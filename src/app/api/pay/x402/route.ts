import { NextResponse } from 'next/server';
import { supabaseAdmin as supabase } from '@/utils/supabase';
import { executeVend, getStrictRequestId } from '@/lib/vend';
import { resolveTokenOnChain } from '@/constants';
import { sendTelegramAlert } from '@/lib/telegram';

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
  },
  BASE: {
    USDC: { name: 'USD Coin', version: '2' },
  },
};

type ChainKey = 'CELO' | 'BASE';

interface X402ChainConfig {
  chainKey: ChainKey;
  caip2: string;            // signed into the payer's EIP-712 domain via the CAIP-2 string
  settleNetworkName: string; // the network label the facilitator's /supported expects
  settleX402Version: number; // Celo: 1 (proven combo); Base/Coinbase: 2
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
    // 🔴 THE BUG THIS FIXES: settleNetworkName was 'base' (a bare chain name, matching Celo's
    // facilitator's OWN convention — see the Celo branch below). CDP's facilitator instead
    // expects CAIP-2 throughout (its PAYMENT-RESPONSE headers and payment-option `network`
    // fields are always "eip155:<chainId>", confirmed independently, not a bare chain name).
    // A live settle call with 'base' came back `{"errorReason":"invalid_network","errorMessage":
    // "invalid network: "}` — CDP's validator tried to split it as CAIP-2, found no colon, and
    // was left with nothing to report. Reusing `caip2` here (same value the challenge already
    // uses) is the fix — no separate "settle name" exists for CDP, unlike Celo.
    return {
      chainKey,
      caip2: isMainnet ? 'eip155:8453' : 'eip155:84532',
      settleNetworkName: isMainnet ? 'eip155:8453' : 'eip155:84532',
      settleX402Version: 2,
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
  const vtRequestId = getStrictRequestId();

  // ⚡ CHAIN ROUTING — Celo (Celo facilitator) vs Base (Coinbase CDP facilitator). Base is
  // inert unless CDP creds + the Base vault address are configured; when unconfigured we fall
  // back to Celo so the route always behaves EXACTLY as before for the live Celo flow. The
  // client signals its chain via `blockchain` (same field the contract-call path uses).
  // Normalize once — the frontend sends the viem chain NAME ("Base", "Base Sepolia", "Celo"),
  // so match on a substring rather than an exact 'BASE'.
  const requestedChain: ChainKey = (blockchain || '').toUpperCase().includes('BASE') ? 'BASE' : 'CELO';
  const chainCfg = (await chainConfigFor(requestedChain, isMainnet)) || (await chainConfigFor('CELO', isMainnet));
  if (!chainCfg) {
    return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: 'x402 is not configured.' }, { status: 500 });
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
  let requiredWei: bigint;
  let requiredCrypto: number;
  let baseRate = 1500; // fallback only ever used when vendAmount is null (no real bill to price)
  if (vendAmount !== null) {
    const { data: settingsData } = await supabase.from('platform_settings').select('exchange_rate').eq('id', 1).single();
    baseRate = parseFloat(settingsData?.exchange_rate || '1500');
    requiredCrypto = (vendAmount + serviceFee) / baseRate;
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
      extensions: {},
    };
    const v1Body = { x402Version: 1, error: 'Payment required', accepts: [acceptEntry] };
    return NextResponse.json(v1Body, {
      status: 402,
      headers: { 'payment-required': Buffer.from(JSON.stringify(v2Challenge)).toString('base64') },
    });
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
  try {
    let decodedPayload: any;
    try {
      decodedPayload = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf-8'));
    } catch {
      return NextResponse.json({ x402Version: 1, error: 'Malformed X-PAYMENT header', accepts: [acceptEntry] }, { status: 402 });
    }

    const facilitatorPaymentPayload = { ...decodedPayload, x402Version: chainCfg.settleX402Version, network: chainCfg.settleNetworkName };
    const facilitatorPaymentRequirements = { ...acceptEntry, network: chainCfg.settleNetworkName };

    const authHeaders = await chainCfg.authFor(CDP_FACILITATOR_SETTLE_PATH);
    if (!authHeaders) {
      return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: 'x402 is not configured for this chain.' }, { status: 500 });
    }

    const settleRes = await fetch(chainCfg.facilitatorSettleUrl, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
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
    const rawSettleText = await settleRes.text();
    try {
      settleResult = JSON.parse(rawSettleText);
    } catch {
      console.error(`[Pay/x402] Settle returned non-JSON (${chainKey}):`, settleRes.status, rawSettleText.slice(0, 500));
      return NextResponse.json({ x402Version: 1, error: `Facilitator error (${settleRes.status})`, accepts: [acceptEntry] }, { status: 402 });
    }
    if (!settleRes.ok || !settleResult.success) {
      console.error(`[Pay/x402] Settle rejected (${chainKey}):`, settleRes.status, 'token:', requestedTokenSymbol, 'asset:', usdc.address, 'raw:', rawSettleText.slice(0, 800));
    }
  } catch (err: any) {
    console.error(`[Pay/x402] ${chainKey} facilitator unreachable:`, err?.message);
    return NextResponse.json({ x402Version: 1, error: 'Facilitator temporarily unavailable', accepts: [acceptEntry] }, { status: 402 });
  }

  if (!settleResult.success) {
    // "0 credits" also comes back as a settle failure per Celo's own docs ("the facilitator
    // returns 402 Payment Required until you top up") — that's an operator problem, not a
    // payer one, so alert rather than silently telling the payer to just retry. Scan every
    // stringy field on the response, not just the two we used to know about, since the
    // facilitator's error shape has varied.
    const allText = JSON.stringify(settleResult);
    const looksLikeCreditExhaustion = /credit/i.test(allText);
    if (looksLikeCreditExhaustion) {
      sendTelegramAlert(`🚨 *x402 FACILITATOR OUT OF CREDITS*\n\nCelo x402 settlement is failing — top up credits at x402.celo.org.\n\n${allText.slice(0, 300)}`).catch(() => {});
    } else {
      console.error('[Pay/x402] Settle failed (parsed):', allText.slice(0, 800));
    }
    const reason = settleResult.errorMessage || settleResult.errorReason || (settleResult as any).error || (settleResult as any).message || 'Payment could not be settled';
    return NextResponse.json(
      { x402Version: 1, error: reason, accepts: [acceptEntry] },
      { status: 402 }
    );
  }

  // ⚡ Payment is now CONFIRMED and irreversibly settled. Everything past this point is
  // "do we have enough to actually vend a bill" — scope/field checks live here, not before
  // the payment gate, so they never interfere with discovery probing.
  //
  // Note: this checks blockchain/vendAmount/etc, but NOT tokenSymbol against 'USDC' — the
  // actual charged token is requestedTokenSymbol (resolved above from the request, falling
  // back to USDC), which is what really went on-chain. It's used below in place of the raw
  // client-claimed tokenSymbol for exactly that reason.
  // The settled chain is whatever chainCfg actually used — cross-check the client's requested
  // chain agrees, so a Base settlement can't be mislabelled as Celo (or a Base request that
  // silently fell back to Celo because Base wasn't configured can't vend).
  if (requestedChain !== chainKey || vendAmount === null || !serviceID || !billersCode) {
    console.error('[Pay/x402] Payment settled but request lacked real bill details:', { blockchain, requestedChain, chainKey, tokenSymbol, vendAmount, serviceID, billersCode, tx: settleResult.transaction });
    return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: 'Payment settled, but the request was missing bill details — contact support with your transaction hash.' }, { status: 400 });
  }

  const txHash = settleResult.transaction;
  const payer = settleResult.payer;

  // Cross-check the payer matches who the frontend claims is paying — mirrors the
  // SENDER_MISMATCH check in /api/webhook for the contract-call path.
  if (payer && wallet_address && payer.toLowerCase() !== String(wallet_address).toLowerCase()) {
    return NextResponse.json({ success: false, status: 'FAILED_VENDING', message: 'Payer address mismatch.' }, { status: 400 });
  }

  const explorerUrl = `${explorerBase}/tx/${txHash}`;

  // Record the transaction, then atomically lock it before vending — same pattern as
  // /api/pay, so a retried request with the same settlement tx can't double-vend.
  const dbPayload = {
    tx_hash: txHash, request_id: vtRequestId, service_category: serviceCategory, service_id: serviceID,
    variation_code: variation_code, network: network, blockchain: chainKey,
    account_number: billersCode || phone || 'N/A', phone: phone || null,
    amount_usdt: requiredCrypto, amount_naira: vendAmount, fee_naira: serviceFee, status: 'PENDING',
    wallet_address: (payer || wallet_address || 'UNKNOWN').toLowerCase(),
    customer_name: customer_name || null, customer_address: customer_address || null,
    source_channel: source_channel || 'WEB', token_used: requestedTokenSymbol,
    meter_account_type: meter_account_type || null, customer_email: email || null,
    operator_id: operator_id || null, country_code: country_code || null, product_type_id: product_type_id || null,
    subscription_type: subscription_type || null,
    foreign_amount: foreignAmount || null, display_amount: displayAmount || null,
    payment_method: 'X402',
  };

  await supabase.from('transactions').upsert(dbPayload, { onConflict: 'tx_hash' });

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
    variation_code, subscription_type, amount: requiredCrypto, tokenSymbol: requestedTokenSymbol, vendAmount, displayAmount,
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
    return NextResponse.json({ success: false, status: 'SYSTEM_CRASH', message: 'System error settling x402 payment.' }, { status: 500 });
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
    return NextResponse.json({ success: false, status: 'SYSTEM_CRASH', message: 'System error settling x402 payment.' }, { status: 500 });
  }
}
