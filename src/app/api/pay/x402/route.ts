import { NextResponse } from 'next/server';
import { supabaseAdmin as supabase } from '@/utils/supabase';
import { executeVend, getStrictRequestId } from '@/lib/vend';
import { resolveTokenOnChain, DEFAULT_CHAIN } from '@/constants';
import { sendTelegramAlert } from '@/lib/telegram';
import { getServiceRules } from '@/lib/serviceRules';
import { isDuplicateElectricity } from '@/lib/parity';
import { enqueueRefund } from '@/lib/refunds';
import { readAuthorization, checkAuthorization, isRetryableSettleFailure, settleResponseNamesTransaction, buildAuthorizationStateCall, parseAuthorizationState, transferAuthorizationTypedData, type X402Authorization } from '@/lib/x402Settle';
import { rpcUrlsFor } from '@/lib/chain';
import { verifyTypedData, recoverTypedDataAddress } from 'viem';
import { verifyTypedData as verifyTypedDataOnChain } from 'viem/actions';
import { getPublicClient } from '@/lib/chain';

// ⚡ x402 SETTLEMENT — MAIN APP ONLY. Two rails, resolved by chainConfigFor():
//   • CELO (default): Celo's own facilitator (api.x402.celo.org — "Built by Celo Core Co."),
//     X-API-Key auth, x402Version 1. Supports USDC and USD₮ (both have EIP-3009 on Celo).
//   • BASE (opt-in): Coinbase's CDP facilitator, Bearer-JWT auth, x402Version 2. USDC only.
//     Dormant until CDP_API_KEY_ID/SECRET + the Base vault address are configured.
// Per-token EIP-712 domains are in X402_DOMAINS_BY_CHAIN below (that's how each was verified).
// USDm is NOT supported on either — it's a Mento stable token (same family as cUSD) with only
// EIP-2612 permit(), no transferWithAuthorization, and the "exact" scheme needs EIP-3009.
//
// Switched off thirdweb for this route because:
//   1. thirdweb requires a paid billing plan to settle on mainnet at all (DELEGATION_CHECK_FAILED
//      otherwise) and takes ~0.3% per settlement. Celo's facilitator is flat $0.001/settlement,
//      prepaid via credits, no billing plan required.
//   2. thirdweb's SDK routes payment through ITS OWN server wallet first, then forwards to the
//      real recipient in a separate step (visible as a 3-call batch on-chain). Celo's facilitator
//      is genuinely non-custodial — the signed EIP-3009 authorization pays `payTo` (our vault)
//      DIRECTLY; the facilitator only ever submits the pre-signed transaction, never holds funds.
//   3. thirdweb's SDK always uses x402 protocol v2 for a fresh challenge, delivering it via a
//      base64 header with an EMPTY response body — incompatible with generic x402 scanners
//      (x402scan's crawler included) that expect the challenge in the body. Building the 402
//      response ourselves (as v1, body-based) sidesteps that entirely.
//
// This is a SEPARATE settlement rail from the contract-call flow in /api/pay. It exists so
// payments made here are genuinely visible on x402scan (real facilitator settlement, real
// EIP-3009 signature from the payer) rather than a relabeled contract call.
//
// It is deliberately scoped to the main app: x402 requires a fresh signature from the payer
// for every payment, which is incompatible with the signature-free agent-initiated flow
// (AbaPayV3.payBillFor via src/lib/deai/relayer.ts) — that flow is completely untouched.
//
// payTo is the SAME AbaPayV3 vault the contract-call flow pays into, so the existing
// admin balance/refund/withdrawal tooling needs zero changes — it just reads balanceOf,
// which doesn't care how the tokens arrived. See README.md "x402 settlement" section.
//
// 🔴 REQUEST VALIDATION MUST NEVER RUN BEFORE THE PAYMENT CHALLENGE. x402 discovery
// crawlers (x402scan et al.) probe this URL with arbitrary/empty/GET requests to confirm
// it's a real x402 resource — they expect a 402 challenge back, not a 400 from our own
// field validation or a 405 from a missing method handler. Fallback to the published
// minimum price (public/openapi.json's x-payment-info.min) when the real bill amount
// isn't present, so ANY request gets a valid challenge; only actually vend a bill once a
// real payment settles AND we have real bill details.

const FALLBACK_MIN_USDC = '0.05'; // matches public/openapi.json's x-payment-info.price.min
const CELO_FACILITATOR_MAINNET = 'https://api.x402.celo.org';
const CELO_FACILITATOR_TESTNET = 'https://api.x402.sepolia.celo.org';

// ⚡ BASE x402 — via COINBASE'S CDP facilitator (NOT Celo's). Kept a fully separate rail from
// Celo below: different host, different auth (CDP Bearer JWT vs Celo's X-API-Key), different
// x402 version (Coinbase speaks v2 "exact"). The entire Base branch is INERT until BOTH
// CDP_API_KEY_ID and CDP_API_KEY_SECRET are set — with them absent, chainConfigFor('BASE')
// returns null and the route never offers a Base challenge, so nothing here can affect the
// live Celo path. Base x402 supports USDC ONLY: Base USDT has no EIP-3009 transferWithAuthorization
// (verified on-chain — version()/DOMAIN_SEPARATOR() revert), so it can't be settled "exact".
const CDP_FACILITATOR_HOST = 'api.cdp.coinbase.com';
const CDP_FACILITATOR_SETTLE_PATH = '/platform/v2/x402/settle';

// Per-token EIP-712 domains, per chain. The name/version MUST match each token's own on-chain
// EIP712Domain or the payer's signature won't verify. Base USDC's domain name is "USD Coin"
// (not Celo USDC's "USDC") — a different token contract entirely.
const X402_DOMAINS_BY_CHAIN: Record<'CELO' | 'BASE', Record<string, { name: string; version: string }>> = {
  CELO: {
    USDC: { name: 'USDC', version: '2' },
    'USD₮': { name: 'Tether USD', version: '1' },
    // ⚡ USA₮ (Tether America USD) — verified the same way every other entry here was: its
    // on-chain DOMAIN_SEPARATOR (0xe6bbb792…) is reproduced exactly by this name/version pair
    // against chainId 42220 and 0xD2ab3C9A…F771. Note the name is the TOKEN's full name, not
    // its symbol — signing "USA₮" here would recover to an unrelated address and revert.
    'USA₮': { name: 'Tether America USD', version: '1' },
  },
  BASE: {
    USDC: { name: 'USD Coin', version: '2' },
  },
};

type ChainKey = 'CELO' | 'BASE';

/**
 * Has this EIP-3009 authorization already been spent?
 *
 * `true` = the money moved (never retry, never fall back). `false` = it provably did not (a
 * retry is safe). `null` = we could not find out, which callers must treat as `true` would be
 * treated — the chain is the only authority here, and guessing in the payer's disfavour is the
 * only guess that cannot cost them a second payment.
 *
 * Deliberately its own tiny fetch rather than a viem client: this runs on a path that has
 * ALREADY failed, so it must add one cheap, short-timeout read and never a new way to hang.
 */
async function authorizationWasConsumed(
  chainKey: ChainKey,
  isMainnet: boolean,
  tokenAddress: string,
  auth: X402Authorization,
): Promise<boolean | null> {
  const chainId = chainKey === 'BASE' ? (isMainnet ? 8453 : 84532) : (isMainnet ? 42220 : 11142220);
  const data = buildAuthorizationStateCall(auth.from, auth.nonce);
  if (!data) return null;

  for (const url of rpcUrlsFor(chainId)) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'eth_call',
          params: [{ to: tokenAddress, data }, 'latest'],
        }),
        signal: AbortSignal.timeout(6_000),
      });
      const body = await res.json();
      const state = parseAuthorizationState(body?.result);
      if (state !== null) return state;
    } catch {
      // Try the next endpoint — one unreachable RPC is not an answer.
    }
  }
  return null;
}

/**
 * The same read, but given the time a real submission needs to actually land.
 *
 * 🔴 THE INCIDENT THIS EXISTS FOR. A Celo USA₮ payment came back
 * `"nonce too low: next nonce 762330, tx nonce 762329"` — the FACILITATOR's own account nonce,
 * meaning it had just submitted (or was about to finish submitting) the very transaction that
 * carries this authorization. `authorizationWasConsumed` was still asked ONCE, immediately, and
 * read "unspent" — because the transaction was in flight, not yet mined, not yet visible to any
 * RPC. On that single read we told the payer their payment failed and sent them to the
 * contract-call rail, and wrote NO row anywhere, because the row is only ever written on a
 * confirmed outcome. Ten minutes later the transfer WAS mined — payer to vault, signed by the
 * facilitator's own signer, confirmed on-chain — with nothing in `transactions`, nothing in
 * History, nothing in Admin. The payer's only recourse was noticing the balance move themselves.
 *
 * One immediate read can never be enough evidence for a decision this expensive to get wrong:
 * a false "unspent" here is a payment that vanishes from every record we keep, and a false
 * "spent" would tell someone their payment succeeded when it did not. So this spends up to ~14s
 * — cheap next to either mistake — checking again as the chain has time to catch up, and returns
 * the moment a read stops being ambiguous.
 */
async function authorizationWasConsumedAfterSettling(
  chainKey: ChainKey,
  isMainnet: boolean,
  tokenAddress: string,
  auth: X402Authorization,
): Promise<boolean | null> {
  const delaysMs = [0, 2_000, 4_000, 8_000];
  let lastAnswer: boolean | null = null;
  for (const delay of delaysMs) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    lastAnswer = await authorizationWasConsumed(chainKey, isMainnet, tokenAddress, auth);
    if (lastAnswer === true) return true; // Settled — no reason to keep polling.
  }
  return lastAnswer; // false or null after every attempt agreed.
}

interface X402ChainConfig {
  chainKey: ChainKey;
  caip2: string;            // signed into the payer's EIP-712 domain via the CAIP-2 string
  settleNetworkName: string; // the network label the facilitator's /supported expects
  settleX402Version: number; // both Celo and Base/CDP: 1 (see chainConfigFor('BASE') for why)
  facilitatorSettleUrl: string;
  payTo: string | undefined;
  explorerBase: string;
  domains: Record<string, { name: string; version: string }>;
  authFor: (path: string) => Promise<Record<string, string> | null>;
}

// Resolve everything chain-specific in ONE place. Returns null when the chain isn't configured
// (e.g. Base without CDP creds, or a missing vault address) — callers then behave exactly as if
// x402 isn't available for that chain, never half-settling.
async function chainConfigFor(chainKey: ChainKey, isMainnet: boolean): Promise<X402ChainConfig | null> {
  if (chainKey === 'BASE') {
    const id = process.env.CDP_API_KEY_ID;
    const secret = process.env.CDP_API_KEY_SECRET;
    if (!id || !secret) return null; // Base x402 disabled until CDP creds exist — stays dormant
    const payTo = process.env.NEXT_PUBLIC_ABAPAY_BASE_ADDRESS;
    if (!payTo) return null;
    // ⚡ THREE LIVE ATTEMPTS AGAINST REAL SIGNED PAYMENTS GOT THIS RIGHT — trace kept in full
    // because the middle two look plausible in isolation but are each wrong:
    //   1. {x402Version:2, network:'base' (bare)}     -> "invalid_network" (empty reason)
    //   2. {x402Version:2, network:'eip155:8453'}      -> "paymentPayload...x402V2 requires 'accepted'"
    //   3. {x402Version:1, network:'eip155:8453'}      -> IDENTICAL error to #2, unchanged
    // #2 -> #3 changing x402Version and getting the EXACT SAME error is the tell: CDP is
    // inferring "this is a v2 payload" from the network field's SHAPE (CAIP-2, i.e. contains a
    // colon) regardless of the declared x402Version. thirdweb's client (the only source of
    // `decodedPayload` here) can only ever produce the older flat v1-style payload — it never
    // has v2's `accepted`/`resource`/`extensions` fields — so as long as network looks like v2,
    // CDP validates against v2's schema and rejects it for a field that could never be present.
    // Confirmed against the bundled `x402` npm package's own type definitions
    // (node_modules/x402/dist/cjs/x402Specs-*.d.ts): PaymentRequirementsSchema, PaymentPayloadSchema,
    // AND SettleRequestSchema all type `network` as a bare-name enum (`"base"`, `"base-sepolia"`,
    // ...) — CAIP-2 never appears in any of them. The CAIP-2 form (`caip2` below) is still
    // correct for the CHALLENGE's `accepts[].network` — thirdweb's client needs that to resolve
    // an EIP-712 chainId when signing, and that part already worked (a real signature came back).
    // It's only the SETTLE-time override that must be the bare name.
    return {
      chainKey,
      caip2: isMainnet ? 'eip155:8453' : 'eip155:84532',
      settleNetworkName: isMainnet ? 'base' : 'base-sepolia',
      settleX402Version: 1,
      facilitatorSettleUrl: `https://${CDP_FACILITATOR_HOST}${CDP_FACILITATOR_SETTLE_PATH}`,
      payTo,
      explorerBase: isMainnet ? 'https://basescan.org' : 'https://sepolia.basescan.org',
      domains: X402_DOMAINS_BY_CHAIN.BASE,
      authFor: async () => {
        // CDP requires a fresh short-lived Bearer JWT bound to method+host+path.
        const { generateJwt } = await import('@coinbase/cdp-sdk/auth');
        const jwt = await generateJwt({
          apiKeyId: id, apiKeySecret: secret,
          requestMethod: 'POST', requestHost: CDP_FACILITATOR_HOST, requestPath: CDP_FACILITATOR_SETTLE_PATH,
          expiresIn: 120,
        });
        return { Authorization: `Bearer ${jwt}` };
      },
    };
  }

  // CELO — unchanged behaviour: Celo's own facilitator, X-API-Key auth, x402Version 1 + 'celo'.
  const apiKey = process.env.CELO_X402_API_KEY;
  if (!apiKey) return null;
  const payTo = process.env.NEXT_PUBLIC_ABAPAY_CELO_ADDRESS || process.env.NEXT_PUBLIC_ABAPAY_ADDRESS;
  if (!payTo) return null;
  return {
    chainKey,
    caip2: isMainnet ? 'eip155:42220' : 'eip155:11142220',
    settleNetworkName: isMainnet ? 'celo' : 'celo-sepolia',
    settleX402Version: 1,
    facilitatorSettleUrl: `${isMainnet ? CELO_FACILITATOR_MAINNET : CELO_FACILITATOR_TESTNET}/settle`,
    payTo,
    explorerBase: isMainnet ? 'https://celoscan.io' : 'https://sepolia.celoscan.io',
    domains: X402_DOMAINS_BY_CHAIN.CELO,
    authFor: async () => ({ 'X-API-Key': apiKey }),
  };
}

// x402 needs EIP-3009 transferWithAuthorization, and Celo's facilitator only speaks the
// "exact" scheme (its /supported endpoint advertises no "permit"/"upto" kind) — so only
// tokens with a real transferWithAuthorization function are eligible, not just anything
// SUPPORTED_TOKENS lists for the contract-call flow. Verified per-token on Celo mainnet
// (Blockscout: ABI + on-chain DOMAIN_SEPARATOR cross-check against the computed EIP-712
// domain hash) rather than assumed:
//   - USDC: transferWithAuthorization present, domain {name:"USDC", version:"2"} (already
//     proven working end-to-end with real settlements).
//   - USD₮ (TetherTokenCeloExtension): transferWithAuthorization present. Domain version is
//     "1", not "2" — its initialize() calls OpenZeppelin's __ERC20Permit_init(name), which
//     always hardcodes version "1" internally (a different convention from USDC's own
//     EIP712 setup). Confirmed by recomputing the domain hash and matching it byte-for-byte
//     against the live on-chain DOMAIN_SEPARATOR().
//   - USDm (StableTokenV3 — Mento's stable token family, same lineage as cUSD): only has
//     EIP-2612 permit(), no transferWithAuthorization function exists in its ABI at all.
//     Genuinely incompatible with this facilitator's "exact" scheme — not wired in,
//     and requesting it returns a clear error rather than silently falling back to USDC.
// These per-token domains now live in X402_DOMAINS_BY_CHAIN above (Celo + Base).

interface CeloSettleResponse {
  success: boolean;
  network: string;
  transaction: string;
  payer: string;
  errorReason?: string;
  errorMessage?: string;
}

async function handleX402Request(req: Request) {
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    // No/invalid JSON body (a bare probe, or a GET request) — fall through with an empty
    // body; the price fallback below still produces a valid 402 challenge.
  }

  const {
    serviceID, serviceCategory, network, billersCode, phone,
    token: tokenSymbol, variation_code, subscription_type,
    nairaAmount, foreignAmount, displayAmount, wallet_address,
    operator_id, country_code, product_type_id, email,
    meter_account_type, blockchain,
    customer_name, customer_address, source_channel,
  } = body;

  const isMainnet = process.env.NEXT_PUBLIC_NETWORK === 'mainnet' || process.env.NEXT_PUBLIC_NETWORK === 'celo' || process.env.NEXT_PUBLIC_NETWORK === 'base';
  const isForeign = serviceID === 'foreign-airtime';
  const requestedNaira = parseFloat(nairaAmount);
  const needsVerification = !isForeign && (serviceCategory === 'ELECTRICITY' || serviceCategory === 'BANK' || (serviceCategory === 'EDUCATION' && serviceID === 'jamb') || (serviceCategory === 'CABLE' && network !== 'SHOWMAX'));
  const serviceFee = (needsVerification || serviceCategory === 'EDUCATION') ? 100 : 0;
  const vendAmount = Number.isFinite(requestedNaira) && requestedNaira > 0 ? requestedNaira : null;
  // ⚡ CBN STAMP DUTY — ₦50 fixed, mandated on electronic transfers of ₦10,000 and above. See
  // /api/pay's identical comment — same rule, tracked in stamp_duty_ngn, never shown to the user.
  const stampDutyNgn = (serviceCategory === 'BANK' && vendAmount !== null && vendAmount >= 10000) ? 50 : 0;
  const vtRequestId = getStrictRequestId();

  // ⚡ CHAIN ROUTING — Celo (Celo facilitator) vs Base (Coinbase CDP facilitator). Base is
  // inert unless CDP creds + the Base vault address are configured; when unconfigured we fall
  // back to Celo so the route always behaves EXACTLY as before for the live Celo flow. The
  // client signals its chain via `blockchain` (same field the contract-call path uses).
  // Normalize once — the frontend sends the viem chain NAME ("Base", "Base Sepolia", "Celo"),
  // so match on a substring rather than an exact 'BASE'.
  //
  // 🔴 AN UNSPECIFIED CHAIN NOW MEANS THE APP'S DEFAULT, NOT CELO. This read `includes('BASE')`,
  // so ANY request without a `blockchain` — every discovery crawler probe, which sends no body
  // at all — was answered with a CELO challenge. Confirmed against Coinbase's own validator
  // (POST /platform/v2/x402/validate), which failed us on exactly that:
  //
  //   FAIL  accepts[0].network: Network "eip155:42220" is not supported
  //   FAIL  accepts[0].asset:   Asset "0xceba93…" is not USDC
  //
  // CDP's catalog only indexes the chains its facilitator settles, so while a bare probe
  // advertised Celo the Base route could never be listed no matter how many payments settled.
  // A request that NAMES a chain is still honoured exactly as before — only the "didn't say"
  // case moves, and it moves to the chain the app itself defaults to.
  const requestedChain: ChainKey = blockchain
    ? (String(blockchain).toUpperCase().includes('BASE') ? 'BASE' : 'CELO')
    : (DEFAULT_CHAIN === 'BASE' ? 'BASE' : 'CELO');
  const chainCfg = (await chainConfigFor(requestedChain, isMainnet)) || (await chainConfigFor('CELO', isMainnet));
  if (!chainCfg) {
    return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: 'This payment method is temporarily unavailable.' }, { status: 500 });
  }
  const chainKey = chainCfg.chainKey;

  const explorerBase = chainCfg.explorerBase;

  // Resolve which token to actually challenge/settle for. Falls back to USDC whenever the
  // request doesn't specify a supported one (a bare probe, or a real request naming an
  // unsupported token like USDm, or USD₮ on Base which has no EIP-3009) — this is deliberate:
  // the 402 challenge must always fire regardless of what the client asked for (see the
  // "validation must never run before the payment challenge" note above), and the challenge's
  // own `asset`/`extra` fields are what actually govern what the client signs.
  const requestedTokenSymbol: string = chainCfg.domains[tokenSymbol] ? tokenSymbol : 'USDC';
  const tokenDomain = chainCfg.domains[requestedTokenSymbol];
  const usdc = resolveTokenOnChain(requestedTokenSymbol, chainKey, isMainnet);
  if (!usdc) {
    return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: `${requestedTokenSymbol} is not configured for this network.` }, { status: 500 });
  }

  const payTo = chainCfg.payTo;
  if (!payTo) {
    return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: 'Vault address not configured.' }, { status: 500 });
  }

  // 1. RATE — the same server-side source of truth /api/pay uses. Unlike the contract
  // path, we don't need to verify a client-claimed amount against calldata: WE set the
  // price passed to the facilitator below, so the payer can only pay exactly what we ask.
  // Falls back to a nominal minimum when there's no real bill amount to price (a probe,
  // or a malformed request) — that request just never has enough detail to vend anything.
  //
  // ⚡ LATENCY: this challenge must round-trip to our server BEFORE the wallet can even be
  // prompted to sign (x402 is challenge-response by design — the client has no way to know
  // the exact amount/domain to sign until we tell it), unlike the contract-call path, which
  // builds everything client-side and can invoke the wallet immediately with no server call
  // at all first. That structural gap can't be closed, but the query that dominates THIS
  // round-trip can be — getServiceRules() (src/lib/serviceRules.ts) is a 30s-cached read of
  // the exact same platform_settings row every other route already shares, instead of this
  // route running its own uncached query on every single challenge/settle call.
  let requiredWei: bigint;
  let requiredCrypto: number;
  let baseRate = 1500; // fallback only ever used when vendAmount is null (no real bill to price)
  if (vendAmount !== null) {
    const rules = await getServiceRules();
    baseRate = rules.exchangeRate;
    requiredCrypto = (vendAmount + serviceFee + stampDutyNgn) / baseRate;
    requiredWei = BigInt(Math.round(requiredCrypto * 10 ** usdc.decimals));
  } else {
    requiredCrypto = Number(FALLBACK_MIN_USDC);
    requiredWei = BigInt(Math.round(requiredCrypto * 10 ** usdc.decimals));
  }

  // The x402 payment header the client signs and retries with. thirdweb's client-side
  // useFetchWithPayment (already wired in the main app) reads the challenge from the
  // response BODY when there's no PAYMENT-REQUIRED header — see fetchWithPayment.js — so
  // building a plain v1-style body here works for both our own app AND generic scanners.
  const paymentHeader = req.headers.get('x-payment') || req.headers.get('payment-signature');

  const resourceUrl = req.url;
  const caip2Network = chainCfg.caip2;

  // Field set is deliberately a superset of both x402 v1 and v2 PaymentRequirements:
  // `maxAmountRequired`/`resource`/`description`/`mimeType` are what thirdweb's client
  // (node_modules/thirdweb/src/x402/schemas.ts — extends the OLD x402/types package's
  // flat schema) requires per-entry to parse and sign; `amount` is the v2 field name
  // x402scan's validator checks for. Extra fields are simply ignored by whichever side
  // doesn't look for them — verified thirdweb only reads `body.accepts[]` and doesn't
  // validate unknown top-level keys.
  const acceptEntry = {
    scheme: 'exact',
    network: caip2Network,
    amount: requiredWei.toString(),
    maxAmountRequired: requiredWei.toString(),
    resource: resourceUrl,
    description: `AbaPay ${network || serviceCategory || 'bill'} payment`,
    mimeType: 'application/json',
    payTo,
    maxTimeoutSeconds: 86400,
    asset: usdc.address,
    extra: { name: tokenDomain.name, version: tokenDomain.version, primaryType: 'TransferWithAuthorization' },
  };

  if (!paymentHeader) {
    // No payment attempted yet — issue the challenge. Traced x402scan's actual crawler
    // (@agentcash/discovery, the npm package it probes with — see node_modules-free repo
    // read at github.com/Merit-Systems/x402scan): its probe only recognizes a v2 challenge
    // via the `payment-required` RESPONSE HEADER (base64 JSON, x402Version must be exactly
    // 2 — see parsePaymentRequiredBody2 in the package). A v2 challenge in the JSON BODY is
    // explicitly rejected at the probe stage (parsePaymentRequiredBody requires the body's
    // x402Version to be exactly 1, since it's only consulted when no header is present) —
    // that mismatch is what caused "No valid x402 response found". So: header carries v2
    // (for x402scan), body stays v1 for any generic/older client that only reads the body.
    // thirdweb's own client (fetchWithPayment.ts) checks the header FIRST and falls back to
    // body only if absent, and its per-entry schema (maxAmountRequired etc.) doesn't change
    // with version — so this doesn't affect our own app's real payment flow either way.
    const v2Challenge = {
      x402Version: 2,
      error: 'Payment required',
      resource: { url: resourceUrl, description: acceptEntry.description, mimeType: acceptEntry.mimeType },
      accepts: [acceptEntry],
      // ⚡ BAZAAR DISCOVERY — WHAT MAKES THIS ENDPOINT FINDABLE BY AGENTS.
      //
      // Coinbase's Bazaar is one of the catalogs agent wallets search for x402 services, and
      // there is no submission form: CDP indexes a resource the first time a real payment
      // SETTLES through its facilitator for that URL, and only if the 402 advertises this block.
      // `extensions` was an empty object, so every check below failed and the route could never
      // have been listed however much traffic it took.
      //
      // The shape is not guessed. It is what CDP's own validator
      // (POST /platform/v2/x402/validate) demands — it names each missing path individually,
      // `bazaar.info`, `bazaar.info.input.type`, `bazaar.info.input.method`, `bazaar.schema`
      // required, `bazaar.info.output.example` advisory — and it matches the blocks live
      // listings publish today (read back from GET /platform/v2/x402/discovery/resources).
      //
      // The description is written for an AGENT deciding whether this service does what its
      // user asked, which is also how the catalog ranks quality: a bare endpoint name scores
      // nothing. Say the country, the services, the currency and the settlement asset.
      extensions: {
        bazaar: {
          info: {
            input: {
              type: 'http',
              method: 'POST',
              discoverable: true,
              body: {
                type: 'object',
                required: ['serviceID', 'amount'],
                properties: {
                  serviceID: { type: 'string', description: 'Biller code, e.g. "mtn", "ikeja-electric", "dstv".' },
                  serviceCategory: { type: 'string', enum: ['AIRTIME', 'DATA', 'ELECTRICITY', 'CABLE', 'EDUCATION', 'INTERNATIONAL'], description: 'Which kind of bill is being paid.' },
                  amount: { type: 'number', description: 'Face value of the bill in Nigerian Naira (NGN).' },
                  phone: { type: 'string', description: 'Recipient phone number for airtime, data, or the delivery receipt.' },
                  billersCode: { type: 'string', description: 'Meter number, smartcard number, or account identifier for the biller.' },
                  variation_code: { type: 'string', description: 'Plan code for DATA, CABLE and EDUCATION — obtained from the provider catalogue.' },
                },
              },
            },
            output: {
              type: 'json',
              example: {
                success: true,
                status: 'SUCCESS',
                message: 'Airtime purchase successful',
                tx_hash: '0xe1f5043ae4250e570dcdedfd0944b1f5b230b51d78046019c6e1ad711f786e64',
                request_id: '2026082109476tc53yp30jk3',
                amount_naira: 1000,
                token_used: 'USDC',
              },
            },
          },
          schema: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            properties: {
              input: {
                type: 'object',
                properties: {
                  body: {
                    type: 'object',
                    required: ['serviceID', 'amount'],
                    properties: {
                      serviceID: { type: 'string' },
                      serviceCategory: { type: 'string' },
                      amount: { type: 'number' },
                      phone: { type: 'string' },
                      billersCode: { type: 'string' },
                      variation_code: { type: 'string' },
                    },
                  },
                  method: { type: 'string', enum: ['POST'] },
                },
              },
              output: {
                type: 'object',
                properties: {
                  example: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      status: { type: 'string' },
                      tx_hash: { type: 'string' },
                      request_id: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const v1Body = { x402Version: 1, error: 'Payment required', accepts: [acceptEntry] };
    return NextResponse.json(v1Body, {
      status: 402,
      headers: { 'payment-required': Buffer.from(JSON.stringify(v2Challenge)).toString('base64') },
    });
  }

  // ⚡ DUPLICATE ELECTRICITY GUARD — server-side, enforced, same check /api/pay's intent_only
  // branch, chat, MCP, and the scheduler all now share (src/lib/parity.ts). Placed here
  // deliberately: this is the last point BEFORE money moves — the facilitator's /settle call
  // right below is what actually pulls funds via the payer's signed EIP-3009 authorization.
  // A check placed after settling would be too late (money already moved) to do anything but
  // refund, same reasoning as the intent_only placement in /api/pay.
  if (serviceCategory === 'ELECTRICITY' && vendAmount !== null && wallet_address) {
    const dup = await isDuplicateElectricity(supabase, wallet_address, billersCode, vendAmount);
    if (dup) {
      return NextResponse.json({
        success: false,
        status: 'DUPLICATE',
        message: `You already paid ₦${vendAmount.toLocaleString()} to meter ${billersCode} today. If you really meant to pay again, wait a moment and try again, or contact support.`,
      }, { status: 409 });
    }
  }

  // A payment header is present — decode it and forward it to Celo's facilitator to settle.
  // Their /settle endpoint does verify + settle in one call, and per their own docs only
  // successful settlements consume a credit, so there's no need for a separate /verify
  // pre-check here.
  //
  // The header is base64 JSON produced by thirdweb's client (see node_modules/thirdweb/src/x402/encode.ts
  // encodePayment / sign.ts preparePaymentHeader) in the FLAT shape:
  //   { x402Version, scheme, network, payload: { signature, authorization } }
  // thirdweb can only resolve a chain ID for signing from a CAIP-2 network string (e.g.
  // "eip155:42220") — it has no idea what "celo" means — so `acceptEntry.network` above must
  // stay CAIP-2 for the client to sign successfully. The challenge above declares
  // x402Version 2 (x402scan requires it), which thirdweb dutifully echoes back into
  // decodedPayload.x402Version — but Celo's facilitator's /supported endpoint (verified live
  // via curl) only lists these two exact (x402Version, scheme, network) combos:
  // {2, exact, eip155:42220} and {1, exact, celo}. thirdweb can only ever produce the FLAT
  // shape (never the fully-nested v2 PaymentPayload with resource/accepted/extensions), so
  // trusting its echoed "2" would tag a flat payload as v2 — untested against Celo's real v2
  // handler, and risky with real money. Instead we deliberately IGNORE decodedPayload's
  // version and force x402Version 1 + network 'celo' below — the exact combo already proven
  // to settle correctly on mainnet. This is safe: the EIP-712 signature was already made over
  // domain.chainId 42220 (derived from the CAIP-2 string at signing time), and none of
  // x402Version/scheme/network are part of the signed message — they're pure envelope
  // metadata, so relabeling them here doesn't touch the signature at all.
  //
  // BASE differs only in the envelope: Coinbase's CDP facilitator speaks x402Version 2 with
  // network 'base', and authenticates with a CDP Bearer JWT instead of an X-API-Key. Same
  // {paymentPayload, paymentRequirements} body shape. The exact version/network per chain come
  // from chainCfg — never hardcoded — so the Celo combo stays byte-identical.
  let settleResult: CeloSettleResponse;
  let settleRawText = '';
  let settleHttpStatus = 0;
  // What will ACTUALLY move: the amount the payer signed, which from here on replaces the
  // recomputed price everywhere it matters (the DB row, the vend, any refund). See below.
  let chargedCrypto = requiredCrypto;
  // The authorization the payer signed, hoisted out of the try so a FAILURE can still ask the
  // chain whether its nonce was spent. See authorizationWasConsumed below.
  let settledAuth: X402Authorization | null = null;
  // The payer's signature, hoisted for the same reason: a failed settlement can only be
  // replayed against the facilitator if the alert carries the signature it was made with.
  let settledSignature = "";
  try {
    let decodedPayload: any;
    try {
      decodedPayload = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf-8'));
    } catch {
      return NextResponse.json({ x402Version: 1, error: 'Malformed X-PAYMENT header', accepts: [acceptEntry] }, { status: 402 });
    }

    // 🔴 CHECK THE PAYLOAD BEFORE SPENDING A FACILITATOR ROUND-TRIP ON IT.
    //
    // An authorization that cannot settle comes back from the facilitator as
    // "unable to estimate gas" — a revert during simulation, with no clue which of EIP-3009's
    // several revert conditions caused it. That is the message that was reported on Base, and
    // it cost the payer a Telegram alert, a dead rail and two extra prompts on the fallback.
    // The conditions this can decide (expired window, a clock-skewed validAfter, an amount that
    // disagrees with what we are about to declare as required) are decided HERE, where each one
    // has a specific answer and a specific message. See src/lib/x402Settle.ts.
    const auth = readAuthorization(decodedPayload);
    settledAuth = auth; // kept for the on-chain "was this nonce spent?" check on failure
    settledSignature = typeof (decodedPayload?.payload?.signature ?? decodedPayload?.signature) === "string"
      ? String(decodedPayload?.payload?.signature ?? decodedPayload?.signature) : "";
    const authCheck = checkAuthorization({
      auth,
      payTo,
      requiredWei,
      nowSec: Math.floor(Date.now() / 1000),
    });

    if (!authCheck.ok) {
      console.error(`[Pay/x402] Authorization refused before settling (${chainKey}):`, authCheck.code, 'required:', requiredWei.toString(), 'signed:', auth?.value);
      // 🔴 AND IT IS ANNOUNCED. This gate refuses a payment BEFORE the facilitator is ever
      // called, so it produced no facilitator error, no database row and — until now — no alert:
      // a rejection whose only trace was a console line in the hosting platform's logs. That is
      // how a gate that was refusing the first attempt of EVERY payment went unattributed while
      // the payer simply signed a second time. Anything that turns a payer away belongs on the
      // same channel as everything else that costs them a prompt.
      sendTelegramAlert(
        `⚠️ *x402 AUTHORIZATION REFUSED BEFORE SETTLING (${chainKey})*\n\n` +
        `\`${authCheck.code}\` — the facilitator was never called, so nothing moved.\n\n` +
        `required \`${requiredWei.toString()}\` · signed \`${auth?.value ?? 'none'}\`\n` +
        `payer \`${auth?.from ?? 'unknown'}\` · retryable \`${authCheck.retryable}\``,
      ).catch(() => {});
      return NextResponse.json(
        // `retryable` is what the client reads to decide between re-signing once on this rail
        // and dropping to the contract call — see X402PaymentError.retryable. `accepts` carries
        // a CURRENT challenge, so a re-sign is made against today's price and a fresh window.
        { x402Version: 1, error: authCheck.message, errorCode: authCheck.code, retryable: authCheck.retryable, accepts: [acceptEntry] },
        { status: 402 },
      );
    }

    // 🔴 THE REQUIREMENTS MUST DECLARE WHAT WAS SIGNED, NOT WHAT WE RECOMPUTED.
    //
    // `acceptEntry` is rebuilt from scratch on the settle request, and its price comes from the
    // exchange rate — which is cached for 30 seconds and can therefore differ from the rate the
    // CHALLENGE was priced at, if the payer took a moment to approve. The facilitator receives
    // both the payload and the requirements and reconciles them; hand it a pair that disagrees
    // and it refuses, opaquely. checkAuthorization has already established that the signed value
    // covers this bill and is not wildly above it, so the signed value is the honest figure for
    // both — and the figure the user is actually charged, which is what gets recorded.
    const chargedWei = authCheck.chargedWei;
    chargedCrypto = Number(chargedWei) / 10 ** usdc.decimals;

    // A shortfall inside the tolerance band is settled rather than refused (see MAX_UNDERPAY_RATIO)
    // — but it is never silent. One is a rounding difference; one on EVERY payment is a pricing
    // bug between the challenge and the settle, and this is the line that makes that visible
    // instead of leaving it to be absorbed a few wei at a time.
    if (authCheck.shortfallWei && authCheck.shortfallWei > BigInt(0)) {
      console.warn(`[Pay/x402] Settled under the recomputed price (${chainKey}): required ${requiredWei.toString()}, signed ${chargedWei.toString()}, short by ${authCheck.shortfallWei.toString()}`);
      sendTelegramAlert(
        `ℹ️ *x402 SETTLED UNDER THE RECOMPUTED PRICE (${chainKey})*\n\n` +
        `Accepted inside tolerance — the payer signed the price they were quoted, and was charged exactly that. If this appears on every payment, the challenge and the settle are pricing the same bill differently.\n\n` +
        `required \`${requiredWei.toString()}\` · signed \`${chargedWei.toString()}\` · short \`${authCheck.shortfallWei.toString()}\``,
      ).catch(() => {});
    }
    const settleRequirements = { ...acceptEntry, amount: chargedWei.toString(), maxAmountRequired: chargedWei.toString() };

    // 🔴 RECOVER THE SIGNER BEFORE SPENDING A FACILITATOR ROUND-TRIP ON IT.
    //
    // A signature that does not recover to `from` makes transferWithAuthorization revert on
    // signature recovery, which makes gas estimation fail, which CDP reports as
    // "unable to estimate gas" / invalid_payload — a sentence it also uses for expiry, balance,
    // a spent nonce, a blacklisted address and a paused token. Reproduced exactly, byte for byte,
    // by sending CDP a well-formed authorization with a deliberately bad signature.
    //
    // EIP-712 is deterministic, so this is decidable here for nothing: rebuild the typed data,
    // recover, compare. When it fails we can name the address that actually signed instead of
    // handing the payer an estimation error and an alert nobody can act on.
    const signature = decodedPayload?.payload?.signature ?? decodedPayload?.signature;
    if (auth && typeof signature === 'string') {
      const typedData = transferAuthorizationTypedData({
        auth,
        chainId: Number(String(chainCfg.caip2).split(':')[1]),
        asset: usdc.address,
        domainName: tokenDomain.name,
        domainVersion: tokenDomain.version,
      });

      // 🔴 VALIDATE THE SIGNATURE THE WAY THE TOKEN WILL. THE ORDER IS THE WHOLE BUG.
      //
      // USDC (FiatTokenV2_2) checks signatures through SignatureChecker: when
      // `from.code.length > 0` it calls ERC-1271 `isValidSignature` on the account and NEVER
      // falls back to ecrecover. This code did the opposite — ecrecover first, 1271 only if that
      // failed — so a signature ecrecover accepts sailed through to the facilitator even when the
      // token would refuse it.
      //
      // Not hypothetical. The reported Base failures came from a wallet that is an EIP-7702
      // DELEGATED EOA on Base (code 0xef0100… → delegate 0x490aac77…) and a PLAIN EOA on Celo:
      //   • ecrecover recovers the payer perfectly — a real private key did sign it — so we passed
      //   • the token sees code, asks the delegate over 1271, is refused, and reverts with
      //     "FiatTokenV2: invalid signature" (confirmed by simulating the call on Base)
      //   • CDP surfaces that revert as "unable to estimate gas"
      // which is precisely why the SAME wallet always worked on Celo and kept failing on Base.
      //
      // Mirroring the token's order turns that into a precise local refusal: no facilitator
      // round-trip, no opaque alert, and the page falls back to the contract call — which a 7702
      // account signs and sends perfectly well, since only EIP-3009 consults 1271.
      // ⚡ THE ON-CHAIN CHECK IS THE AUTHORITY, BECAUSE IT IS THE ONE THE TOKEN PERFORMS.
      //
      // viem's public-client `verifyTypedData` already branches exactly as SignatureChecker does:
      // an account WITH code is asked over ERC-1271 (6492-aware), an account without is verified
      // by ecrecover. So it is asked FIRST and on its own, rather than being a fallback after an
      // offline ecrecover that the token would never have consulted.
      //
      // 🔴 THE EARLIER VERSION HAD A HOLE. It read eth_getCode itself and, if that call failed
      // for any reason, quietly set `payerHasCode = false` and accepted an offline ecrecover —
      // the precise combination that lets a delegated account's signature through to the
      // facilitator. An RPC hiccup should never widen what we accept.
      let payerHasCode = false;
      let signerOk = false;
      let onChainAnswered = false;
      try {
        const publicClient = getPublicClient(chainKey);
        const code = await publicClient.getCode({ address: auth.from as `0x${string}` }).catch(() => undefined);
        payerHasCode = Boolean(code && code !== '0x');
        signerOk = await verifyTypedDataOnChain(publicClient, {
          ...typedData,
          address: auth.from as `0x${string}`,
          signature: signature as `0x${string}`,
        });
        onChainAnswered = true;
      } catch {
        onChainAnswered = false;
      }

      if (!onChainAnswered) {
        // The chain could not be reached at all. Offline ecrecover is the only thing left, and it
        // is correct for a plain EOA — which is the overwhelming majority. Logged, because if a
        // delegated account slips through here the facilitator error will be the opaque one again
        // and this line is the only thing that will explain why.
        console.warn(`[Pay/x402] On-chain signature check unavailable (${chainKey}); falling back to ecrecover for`, auth.from);
        try {
          signerOk = await verifyTypedData({ ...typedData, address: auth.from as `0x${string}`, signature: signature as `0x${string}` });
        } catch { signerOk = false; }
      }

      if (!signerOk) {
        let recovered = 'unrecoverable';
        try { recovered = await recoverTypedDataAddress({ ...typedData, signature: signature as `0x${string}` }); } catch { /* keep the placeholder */ }

        console.error(`[Pay/x402] Signature does not authorise this payment (${chainKey}): claimed`, auth.from, 'recovered', recovered);
        // Two different faults land here and they deserve different words. A SMART/DELEGATED
        // account whose 1271 refuses the signature is not a mismatched signature — the key that
        // signed is the payer's, and ecrecover proves it; the ACCOUNT simply will not vouch for
        // it. Saying "didn't match your wallet" about that sends everyone hunting the wrong thing.
        sendTelegramAlert(
          `⚠️ *x402 SIGNATURE REFUSED BY THE PAYER'S ACCOUNT (${chainKey})*\n\n` +
          (payerHasCode
            ? 'The account has CODE (smart account, or an EIP-7702 delegated EOA), so the token validates via ERC-1271 — and the account refused its own signature. ecrecover is not consulted for such accounts. Sent to the contract-call rail, which these accounts sign fine.'
            : 'Refused before the facilitator was called — this is what its "unable to estimate gas" actually meant.') + '\n\n' +
          `payer \`${auth.from}\`${payerHasCode ? ' · has code ⚠️' : ''}\n` +
          `ecrecover gives \`${recovered}\`\n` +
          `domain \`${tokenDomain.name}\` v\`${tokenDomain.version}\` · chainId \`${Number(String(chainCfg.caip2).split(':')[1])}\`\n` +
          `asset \`${usdc.address}\``,
        ).catch(() => {});

        return NextResponse.json(
          {
            x402Version: 1,
            error: payerHasCode
              ? "Your wallet's smart-account mode can't authorise this fast payment, so nothing was charged. Switching to the standard payment — approve once more."
              : "That payment approval didn't match your wallet, so nothing was charged. Please try again.",
            errorCode: payerHasCode ? 'SMART_ACCOUNT_UNSUPPORTED' : 'SIGNATURE_MISMATCH',
            // Not retryable on this rail either way: signing again from the same wallet over the
            // same domain reproduces it exactly. The contract call is the honest next step.
            retryable: false,
            accepts: [acceptEntry],
          },
          { status: 402 },
        );
      }
    }

    // ⚡ `resource` ON THE PAYLOAD, NOT ONLY ON THE REQUIREMENTS — BAZAAR NEEDS BOTH.
    //
    // `decodedPayload` is what the CLIENT sent us (x402Pay.ts never puts `resource` on the
    // payload — only the challenge's `paymentRequirements` carries it, which is what a client
    // needs to sign against). Coinbase's own Bazaar guidance is specific about this: the
    // settle-time `paymentPayload.resource` is what lets the facilitator associate a settled
    // payment with the resource it indexes, separately from `paymentRequirements.resource`,
    // which already carries it. Missing here, it costs nothing at settle time — the facilitator
    // still moves the money — but the listing this settlement was meant to earn never appears.
    const facilitatorPaymentPayload = { ...decodedPayload, resource: resourceUrl, x402Version: chainCfg.settleX402Version, network: chainCfg.settleNetworkName };
    const facilitatorPaymentRequirements = { ...settleRequirements, network: chainCfg.settleNetworkName };

    const authHeaders = await chainCfg.authFor(CDP_FACILITATOR_SETTLE_PATH);
    if (!authHeaders) {
      return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: 'This payment method is temporarily unavailable on this network.' }, { status: 500 });
    }

    // ⚡ ONE SILENT RETRY, AND ONLY WHERE IT CANNOT POSSIBLY COST MONEY.
    //
    // 🔴 THE REPORT THIS ANSWERS: "it fails and switches to the contract call, but if I cancel
    // and retry the same x402 it goes through." The facilitator refused with
    // `unable to estimate gas` — a simulation that reverted against state it could not read —
    // and the identical payload settled moments later. That second attempt is one the SERVER can
    // make, without the user's wallet being asked anything at all.
    //
    // Safe by construction, and the reason is EIP-3009 itself: the authorization carries a
    // single-use nonce, so the token contract will accept it AT MOST ONCE no matter how many
    // times it is submitted. A retry can therefore duplicate a request but never a transfer.
    // The two conditions guarding it are about honesty rather than safety: retry only a refusal
    // the facilitator actually returned (never a network error, where we cannot know what it
    // did), and never one that names a transaction hash.
    const SETTLE_ATTEMPTS = 2;
    const SETTLE_RETRY_DELAY_MS = 1_200;

    const attemptSettle = async () => {
      // A fresh CDP JWT per attempt — they are short-lived and bound to this exact request.
      const perAttemptAuth = (await chainCfg.authFor(CDP_FACILITATOR_SETTLE_PATH)) || authHeaders;
      const res = await fetch(chainCfg.facilitatorSettleUrl, {
        method: 'POST',
        headers: { ...perAttemptAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          x402Version: chainCfg.settleX402Version,
          paymentPayload: facilitatorPaymentPayload,
          paymentRequirements: facilitatorPaymentRequirements,
        }),
      });
      // ⚡ Capture the RAW response — the old code did `.json()` and then only read
      // `errorReason`/`errorMessage`, which logged "undefined undefined" whenever the
      // facilitator returned a DIFFERENT error shape (or a non-JSON / non-200 body). That hid
      // the actual reason a settlement was rejected. Log status + full raw body so the real
      // cause is always visible.
      return { status: res.status, ok: res.ok, text: await res.text() };
    };

    let parsed: any = null;
    for (let attempt = 1; ; attempt++) {
      const res = await attemptSettle();
      settleHttpStatus = res.status;
      settleRawText = res.text;
      try { parsed = JSON.parse(res.text); } catch { parsed = null; }

      if (res.ok && parsed?.success === true) break;

      const movedSomething = settleResponseNamesTransaction(parsed);
      const worthRetrying = !movedSomething
        && attempt < SETTLE_ATTEMPTS
        && parsed !== null
        && isRetryableSettleFailure(res.status, res.text);
      if (!worthRetrying) break;

      // 🔴 AND ONLY IF THE CHAIN SAYS THE AUTHORIZATION IS STILL UNSPENT.
      //
      // The single-use nonce makes a resubmission safe for the PAYER's balance, but it does not
      // make it honest: if the first attempt broadcast successfully and merely lost its response,
      // resubmitting produces a revert ("nonce already used"), which the facilitator reports as
      // `unable to estimate gas` — and that manufactured error then OVERWRITES the real outcome
      // in settleRawText, so a settled payment is reported to the payer as a failure. Asking the
      // token first means the retry only ever happens when there is genuinely nothing to lose.
      const stillUnspent = settledAuth
        ? await authorizationWasConsumed(chainKey, isMainnet, usdc.address, settledAuth)
        : null;
      if (stillUnspent !== false) {
        console.warn(`[Pay/x402] Settle refused (${chainKey}); NOT retrying — authorization is spent or unreadable:`, stillUnspent);
        break;
      }

      console.warn(`[Pay/x402] Settle refused (${chainKey}), retrying once:`, res.status, res.text.slice(0, 300));
      await new Promise((resolve) => setTimeout(resolve, SETTLE_RETRY_DELAY_MS));
    }

    if (parsed === null) {
      console.error(`[Pay/x402] Settle returned non-JSON (${chainKey}):`, settleHttpStatus, settleRawText.slice(0, 500));
      return NextResponse.json(
        { x402Version: 1, error: `Facilitator error (${settleHttpStatus})`, retryable: true, accepts: [acceptEntry] },
        { status: 402 },
      );
    }
    settleResult = parsed as CeloSettleResponse;
  } catch (err: any) {
    // 🔴 NOT RETRYABLE, DELIBERATELY. A fetch that threw tells us nothing about what the
    // facilitator did with the request — it may have settled and lost the response. Signing
    // again here could pay twice; the contract-call rail at least prompts the user first.
    console.error(`[Pay/x402] ${chainKey} facilitator unreachable:`, err?.message);
    return NextResponse.json({ x402Version: 1, error: 'Facilitator temporarily unavailable', accepts: [acceptEntry] }, { status: 402 });
  }

  if (!settleResult.success) {
    const allText = settleRawText || JSON.stringify(settleResult);
    const namesTransaction = settleResponseNamesTransaction(settleResult);
    // Retryable = a fresh signature is worth one prompt. Never when a transaction was named:
    // money may already have moved, and the client must not sign anything else.
    let retryable = !namesTransaction && isRetryableSettleFailure(settleHttpStatus, allText);
    const reason = settleResult.errorMessage || settleResult.errorReason || (settleResult as any).error || (settleResult as any).message || 'Payment could not be settled';

    // 🔴 BEFORE OFFERING A RETRY, ASK THE CHAIN WHETHER THE MONEY ALREADY MOVED.
    //
    // The facilitator's `unable to estimate gas` is the same sentence for "nothing has happened
    // yet" and "it already happened" — re-simulating a spent EIP-3009 nonce necessarily reverts,
    // and a revert during estimation is reported exactly that way. Reading it as the former is
    // what charged a payer 1.4925 USDC twice, 140 seconds apart, for one bill: the refusal named
    // no transaction, so it looked safe, and the re-sign carried a fresh nonce the token
    // accepted. No parsing of that message can tell the two apart, so we stop parsing and ask
    // the token: `authorizationState(payer, nonce)` is the chain's own record of the answer.
    let settledWithoutHash = false;
    if (retryable && settledAuth) {
      const consumed = await authorizationWasConsumedAfterSettling(chainKey, isMainnet, usdc.address, settledAuth);
      if (consumed !== false) {
        // `true` (spent) and `null` (could not read it) both land here on purpose. The cost of
        // being wrong is asymmetric: a needless contract-call fallback costs two prompts, while
        // a wrongly-offered retry costs the payer a second, real payment.
        retryable = false;
        settledWithoutHash = consumed === true;
      }
    }

    console.error(`[Pay/x402] Settle rejected (${chainKey}):`, settleHttpStatus, 'token:', requestedTokenSymbol, 'asset:', usdc.address, 'retryable:', retryable, 'authorizationSpent:', settledWithoutHash, 'raw:', allText.slice(0, 800));

    if (settledWithoutHash) {
      // 🔴 THIS IS THE ROW THAT WAS MISSING. The alert used to say "reconcile this one by hand"
      // while leaving NOTHING to reconcile — no transactions row, invisible to History, invisible
      // to Admin, the payer's only proof their own wallet balance moving. Confirmed against a
      // real incident: a Celo USA₮ payment settled on-chain (transferWithAuthorization, signed by
      // the facilitator's own signer, mined minutes later) while this branch told the payer it
      // had failed and recorded nothing anywhere.
      //
      // No real tx_hash exists yet — the facilitator never returned one — so a unique synthetic
      // one is used instead, in the SAME shape History's query already excludes preflight rows
      // by (`not tx_hash like 'preflight_%'`) so this one, deliberately NOT matching that prefix,
      // stays visible. status/error_code follow the pattern the webhook already uses for
      // "something is wrong, an admin needs to look" (FAILED_VENDING + a specific code) rather
      // than inventing a new status the rest of the admin UI does not know how to render.
      //
      // Not vended, not refunded automatically: we know the authorization was consumed, not that
      // it went where THIS row expects — the honest move is to make the payment visible and flag
      // it, not to guess at the rest.
      const unconfirmedTxHash = `x402_unconfirmed_${chainKey}_${settledAuth?.nonce ?? vtRequestId}`;
      await supabase.from('transactions').upsert({
        tx_hash: unconfirmedTxHash, request_id: vtRequestId,
        service_category: serviceCategory || 'UNKNOWN', service_id: serviceID || 'UNKNOWN',
        variation_code: variation_code, network: network || 'UNKNOWN', blockchain: chainKey,
        account_number: billersCode || phone || 'N/A', phone: phone || null,
        amount_usdt: chargedCrypto, amount_naira: vendAmount, fee_naira: serviceFee, stamp_duty_ngn: stampDutyNgn,
        status: 'FAILED_VENDING', error_code: 'X402_SETTLED_UNCONFIRMED',
        api_response: `Facilitator refused (${allText.slice(0, 300)}) but the chain shows the authorization was consumed — money moved, hash unknown. Needs manual reconciliation.`,
        wallet_address: (settledAuth?.from || wallet_address || 'UNKNOWN').toLowerCase(),
        customer_name: customer_name || null, customer_address: customer_address || null,
        source_channel: source_channel || 'WEB', token_used: requestedTokenSymbol,
        meter_account_type: meter_account_type || null, customer_email: email || null,
        operator_id: operator_id || null, country_code: country_code || null, product_type_id: product_type_id || null,
        subscription_type: subscription_type || null,
        foreign_amount: foreignAmount || null, display_amount: displayAmount || null,
        payment_method: 'X402',
      }, { onConflict: 'tx_hash' }).then(({ error }) => {
        if (error) console.error(`[Pay/x402] Could not write the unconfirmed-settlement row (${chainKey}):`, error.message);
      });

      sendTelegramAlert(
        `🚨 *x402 PAID BUT UNCONFIRMED (${chainKey})*\n\n` +
        `The facilitator refused, but the chain says the payer's authorization WAS spent — the money moved and no transaction hash came back. A row is now recorded (\`${unconfirmedTxHash}\`) so this is visible in Admin and the payer's History; reconcile the real tx hash by hand. The payer has NOT been asked to pay again.\n\n` +
        `${requestedTokenSymbol} ${chargedCrypto.toFixed(4)} · payer \`${settledAuth?.from}\`\n` +
        `nonce \`${settledAuth?.nonce}\`\n` +
        `\`${allText.slice(0, 300)}\``,
      ).catch(() => {});

      return NextResponse.json(
        {
          x402Version: 1,
          // `settled` is what stops the page falling back to the contract call — see x402Pay.ts.
          settled: true,
          error: "Your payment went through, but we couldn't confirm it automatically. Don't pay again — check your History tab, and contact support if it hasn't appeared shortly.",
          retryable: false,
        },
        { status: 402 },
      );
    }

    // "0 credits" also comes back as a settle failure per Celo's own docs ("the facilitator
    // returns 402 Payment Required until you top up") — that's an operator problem, not a
    // payer one, so alert rather than silently telling the payer to just retry. Scan every
    // stringy field on the response, not just the two we used to know about, since the
    // facilitator's error shape has varied.
    if (/credit/i.test(allText)) {
      sendTelegramAlert(`🚨 *x402 FACILITATOR OUT OF CREDITS*\n\n${chainKey} x402 settlement is failing — top up credits at x402.celo.org.\n\n${allText.slice(0, 300)}`).catch(() => {});
    } else {
      // 🔴 A CONSOLE LINE IS NOT A REPORT. A rejected settlement leaves NO database row (the row
      // is only written once money has moved), so this console line was the single trace that
      // it happened — and reading it means having the hosting platform's logs open at the time.
      // Meanwhile the user is bounced onto the contract-call rail and asked to approve all over
      // again, with nobody the wiser about why. Send the facilitator's own words to the operator
      // on the channel every other money-affecting failure already uses.
      //
      // ⚡ AND SAY WHAT HAPPENS NEXT. This alert used to state flatly that the payer "has been
      // sent to the contract-call rail", which stopped being true: a retryable refusal has
      // already been re-sent to the facilitator once by then, and is about to be re-signed once
      // on this rail before anything falls back. An alert that describes the old behaviour is
      // worse than none — it sends whoever reads it looking for the wrong thing.
      // ⚡ AND CARRY THE AUTHORIZATION ITSELF. "unable to estimate gas" names none of the six
      // things that actually revert transferWithAuthorization, so an alert without these fields
      // sends whoever reads it to the RPC to reconstruct them by hand. `nowSec` is included
      // because the two window fields are only meaningful next to the clock they are judged
      // against — a validAfter above it is a revert, and nothing else in the message says so.
      const nowSec = Math.floor(Date.now() / 1000);
      // ⚡ AND THE PAYER'S ON-CHAIN BALANCE, BECAUSE THE MARGIN IS THE ONE THING THAT VARIES.
      //
      // 🔴 EVERY OTHER CAUSE HAS BEEN ELIMINATED FROM THE OUTSIDE. Against CDP directly: the
      // network/scheme/version combination is what /supported lists, the payload SHAPE is
      // accepted (a real signature replayed through /verify reached a precise, named window
      // error), and "unable to estimate gas" is reproducible byte for byte with a bad signature
      // — but the signature is verified HERE now, before this point, so it is not that either.
      // On-chain: window valid, nonce unspent, neither address blacklisted, token not paused.
      //
      // What the two failures share is how close the payment sat to the payer's whole balance —
      // 0.042 USDC of headroom on one, 0.000518 on the next — while the payments that settled
      // had orders of magnitude more. That is the remaining variable, so it goes in the alert
      // rather than being reconstructed by hand afterwards.
      //
      // The SIGNATURE goes in too. Everything else about a failure can be re-derived from the
      // chain; the signature cannot, and without it a failed settlement cannot be replayed
      // against the facilitator to see what it actually objects to.
      let balanceLine = '';
      try {
        const balData = `0x70a08231${'0'.repeat(24)}${String(settledAuth?.from ?? '').replace(/^0x/, '').toLowerCase()}`;
        for (const url of rpcUrlsFor(Number(String(chainCfg.caip2).split(':')[1]))) {
          const r = await fetch(url, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: usdc.address, data: balData }, 'latest'] }),
            signal: AbortSignal.timeout(5_000),
          });
          const b = await r.json();
          if (typeof b?.result === 'string' && /^0x[0-9a-f]+$/i.test(b.result)) {
            const bal = BigInt(b.result);
            const need = BigInt(settledAuth?.value ?? '0');
            const spare = bal - need;
            balanceLine =
              `balance \`${bal.toString()}\` · spare \`${spare.toString()}\`` +
              `${spare < BigInt(0) ? ' ⛔ SHORT' : spare < BigInt(10_000) ? ' ⚠️ RAZOR-THIN' : ''}\n`;
            break;
          }
        }
      } catch { /* diagnostics must never break the error path */ }

      const sigForReplay = settledSignature;

      const authLine = settledAuth
        ? `payer \`${settledAuth.from}\` -> \`${settledAuth.to}\`\n` +
          `value \`${settledAuth.value}\` · asset \`${usdc.address}\`\n` +
          balanceLine +
          `validAfter \`${settledAuth.validAfter}\`${Number(settledAuth.validAfter) > nowSec ? ' ⛔ IN THE FUTURE' : ''} · ` +
          `validBefore \`${settledAuth.validBefore}\`${Number(settledAuth.validBefore) <= nowSec ? ' ⛔ EXPIRED' : ''} · now \`${nowSec}\`\n` +
          `maxTimeoutSeconds \`${acceptEntry.maxTimeoutSeconds}\` · window left \`${Number(settledAuth.validBefore) - nowSec}\`\n` +
          `nonce \`${settledAuth.nonce}\`\n` +
          (sigForReplay ? `sig \`${sigForReplay}\`\n` : '')
        : '';

      sendTelegramAlert(
        `⚠️ *x402 SETTLEMENT REJECTED (${chainKey})*\n\n` +
        // ⚡ SAY WHAT ACTUALLY HAPPENS NEXT, WHICH IS NO LONGER A SECOND PROMPT.
        //
        // This claimed the payer's "wallet is being asked to sign once more" whenever the refusal
        // was retryable. That stopped being true when payWithX402's default dropped to a single
        // attempt: `retryable` now only means the SERVER re-sent the same authorization by
        // itself. An alert describing a prompt the user never sees sends whoever reads it looking
        // for the wrong thing — which is the same mistake this alert was written to fix.
        'The payer signed and the facilitator refused' +
        (retryable ? ' twice — the server re-sent the same authorization once by itself. ' : '. ') +
        'Their wallet was asked to sign once, and only once; the bill has gone to the contract-call rail.' + '\n\n' +
        `HTTP ${settleHttpStatus} · ${requestedTokenSymbol} · ${chargedCrypto.toFixed(4)}\n` +
        authLine +
        `\`${allText.slice(0, 400)}\``,
      ).catch(() => {});
    }

    return NextResponse.json(
      { x402Version: 1, error: reason, retryable, accepts: [acceptEntry] },
      { status: 402 }
    );
  }

  const txHash = settleResult.transaction;
  const payer = settleResult.payer;
  const explorerUrl = `${explorerBase}/tx/${txHash}`;
  const settledWallet = (payer || wallet_address || 'UNKNOWN').toLowerCase();

  const dbPayload = {
    tx_hash: txHash, request_id: vtRequestId, service_category: serviceCategory || 'UNKNOWN', service_id: serviceID || 'UNKNOWN',
    variation_code: variation_code, network: network || 'UNKNOWN', blockchain: chainKey,
    account_number: billersCode || phone || 'N/A', phone: phone || null,
    // The amount the facilitator ACTUALLY transferred (the payer's signed value), not the
    // figure we recomputed at settle time — those can differ by an exchange-rate tick, and a
    // refund issued against the wrong one under- or over-pays the user. See x402Settle.ts.
    amount_usdt: chargedCrypto, amount_naira: vendAmount, fee_naira: serviceFee, stamp_duty_ngn: stampDutyNgn, status: 'PENDING',
    wallet_address: settledWallet,
    customer_name: customer_name || null, customer_address: customer_address || null,
    source_channel: source_channel || 'WEB', token_used: requestedTokenSymbol,
    meter_account_type: meter_account_type || null, customer_email: email || null,
    operator_id: operator_id || null, country_code: country_code || null, product_type_id: product_type_id || null,
    subscription_type: subscription_type || null,
    foreign_amount: foreignAmount || null, display_amount: displayAmount || null,
    payment_method: 'X402',
  };

  await supabase.from('transactions').upsert(dbPayload, { onConflict: 'tx_hash' });

  // Cross-check the payer matches who the frontend claims is paying — mirrors the
  // SENDER_MISMATCH check in /api/webhook for the contract-call path.
  const payerMismatch = payer && wallet_address && payer.toLowerCase() !== String(wallet_address).toLowerCase();
  // Note: this checks blockchain/vendAmount/etc, but NOT tokenSymbol against 'USDC' — the
  // actual charged token is requestedTokenSymbol (resolved above from the request, falling
  // back to USDC), which is what really went on-chain. It's used below in place of the raw
  // client-claimed tokenSymbol for exactly that reason.
  // The settled chain is whatever chainCfg actually used — cross-check the client's requested
  // chain agrees, so a Base settlement can't be mislabelled as Celo (or a Base request that
  // silently fell back to Celo because Base wasn't configured can't vend).
  const missingBillDetails = requestedChain !== chainKey || vendAmount === null || !serviceID || !billersCode;

  if (payerMismatch || missingBillDetails) {
    const errorCode = payerMismatch ? 'PAYER_MISMATCH' : 'SETTLED_MISSING_BILL_DETAILS';
    const reason = payerMismatch
      ? 'x402 settled but the payer address did not match the wallet the request claimed.'
      : 'x402 settled but the request lacked real bill details (serviceID/billersCode/amount) — likely a generic x402 client that only resent the payment challenge fields.';
    console.error('[Pay/x402] Settled payment cannot be vended:', { errorCode, blockchain, requestedChain, chainKey, tokenSymbol, vendAmount, serviceID, billersCode, tx: txHash });

    await supabase.from('transactions').update({ status: 'FAILED_VENDING', error_code: errorCode, api_response: reason }).eq('tx_hash', txHash);

    try {
      await enqueueRefund({
        txHash,
        walletAddress: settledWallet,
        tokenUsed: requestedTokenSymbol,
        amountCrypto: chargedCrypto,
        amountNaira: vendAmount ?? undefined,
        blockchain: chainKey,
        reason,
        vtpassError: errorCode,
        userMessage: "There was an issue processing your payment.",
        serviceCategory: serviceCategory || undefined,
        sourceChannel: source_channel || 'WEB',
      });
    } catch (refundErr) {
      console.error('[Pay/x402] Failed to queue refund for settled-but-unvendable payment:', refundErr);
    }

    return NextResponse.json({
      success: false,
      status: 'FAILED_VENDING',
      message: payerMismatch ? 'Payer address mismatch. Your payment is being refunded.' : 'Payment settled, but the request was missing bill details — your payment is being refunded automatically.',
      tx_hash: txHash,
    }, { status: 400 });
  }

  const { data: lockedRecord, error: lockError } = await supabase
    .from('transactions')
    .update({ status: 'PROCESSING', request_id: vtRequestId })
    .eq('tx_hash', txHash)
    .eq('status', 'PENDING')
    .select()
    .single();

  if (!lockedRecord || lockError) {
    return NextResponse.json({ success: true, status: 'TIMEOUT', message: 'This payment is already being processed.' });
  }

  const vendResult = await executeVend({
    vtRequestId, txHash, serviceID, serviceCategory, network, billersCode, phone,
    variation_code, subscription_type, amount: chargedCrypto, tokenSymbol: requestedTokenSymbol, vendAmount, displayAmount,
    foreignAmount, isForeign, operator_id, country_code, product_type_id, email,
    wallet_address: payer || wallet_address, blockchain: chainKey, source_channel, customer_name, customer_address,
    baseRate,
    explorerUrl,
  });

  // The client never sees this transaction directly (the facilitator submits it, not the
  // browser's wallet) — unlike the contract-call path, so it has to come back explicitly.
  return NextResponse.json({ ...vendResult, tx_hash: txHash });
}

export async function POST(req: Request) {
  try {
    return await handleX402Request(req);
  } catch (error: any) {
    console.error('[Pay/x402] error:', error);
    return NextResponse.json({ success: false, status: 'SYSTEM_CRASH', message: 'System error settling payment.' }, { status: 500 });
  }
}

// x402 discovery crawlers (and some clients) probe with GET to confirm a resource is a
// real, valid x402 endpoint before ever attempting a real payment — without this, they see
// a 405 (no handler for GET) instead of the 402 challenge they're looking for. AbaPay's own
// app never uses this path (it always POSTs full bill details), so a GET here always falls
// back to the nominal minimum price and can never actually vend anything.
export async function GET(req: Request) {
  try {
    return await handleX402Request(req);
  } catch (error: any) {
    console.error('[Pay/x402] error:', error);
    return NextResponse.json({ success: false, status: 'SYSTEM_CRASH', message: 'System error settling payment.' }, { status: 500 });
  }
}
