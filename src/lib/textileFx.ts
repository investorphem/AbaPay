import 'server-only';
import crypto from 'node:crypto';
import { createWalletClient, publicActions, concat, erc20Abi, parseEventLogs, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { celo } from 'viem/chains';
import { getChainTransport, isMainnetEnv } from '@/lib/chain';
import { celoAttributionSuffix } from '@/lib/attribution';
import { feeCurrencyFor } from '@/lib/feeCurrency';
import { errorMessage } from '@/lib/errors';

// 💱 TEXTILE FX — AbaPay's FX wallet buys cNGN with USD₮ on Celo (https://fx-docs.textilecredit.com).
//
// Textile FX is an RFQ venue: we name the exact cNGN we need (`buyAmount`, exact-out), makers
// price it, and one transaction from our wallet settles it through the LimitOrderReactor. No API
// key: the taker proves control of its wallet with an EIP-712 signature when Textile asks
// (401 proof_of_control_required), and that proof covers about 12 hours of quotes.
//
// The FX wallet is a hot key (FX_WALLET_PRIVATE_KEY) holding a small USD₮ float, topped up from the
// vault by the operator. Its float is the most a bug or a leaked key can lose, so keep it small.
// It pays its gas in USD₮ through Celo fee abstraction and never needs CELO.
//
// Every transaction it sends (the approval, the swap and the cNGN delivery) carries AbaPay's Celo
// attribution tags (src/lib/attribution.ts), which is what makes the conversion count on chain.
// Celo mainnet only: Textile FX has no Celo testnet.

export const TEXTILE_API = 'https://api.textilecredit.com/v2';
export const CELO_USDT = '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e' as const;
export const CELO_CNGN = '0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f' as const;
/** Both tokens have 6 decimals; one cNGN is one naira. */
export const TOKEN_DECIMALS = 6;
const CHAIN_ID = celo.id; // 42220

export type FxQuote = {
  rfqId: string;
  claimToken: string;
  takerPays: bigint;
  buyAmount: bigint;
  reactor: `0x${string}`;
  expiresAt: number;
  swap: { to: `0x${string}`; data: Hex };
};

export type QuoteResult = { ok: true; quote: FxQuote } | { ok: false; reason: string };

export function fxConfigured(): boolean {
  return isMainnetEnv() && /^0x[0-9a-fA-F]{64}$/.test(String(process.env.FX_WALLET_PRIVATE_KEY || ''));
}

function fxAccount() {
  return privateKeyToAccount(process.env.FX_WALLET_PRIVATE_KEY as Hex);
}

export function fxWalletAddress(): `0x${string}` | null {
  return fxConfigured() ? fxAccount().address : null;
}

function fxClient() {
  return createWalletClient({ account: fxAccount(), chain: celo, transport: getChainTransport('CELO') }).extend(publicActions);
}

/** Gas in USD₮ (fee abstraction) and AbaPay's attribution tags on every FX-wallet transaction. */
const txExtras = () => ({ feeCurrency: feeCurrencyFor('USD₮', true), dataSuffix: celoAttributionSuffix(CHAIN_ID) });

/** Textile's keyless proof of wallet control (fx-docs: api/v2/authentication). */
export async function signTakerProof() {
  const account = fxAccount();
  const nonce = toHex(crypto.randomBytes(32));
  const issuedAt = Date.now(); // Unix milliseconds
  const signature = await account.signTypedData({
    domain: { name: 'Textile Taker Control', version: '1', chainId: CHAIN_ID },
    types: { TakerControl: [
      { name: 'taker', type: 'address' }, { name: 'chainId', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' }, { name: 'issuedAt', type: 'uint256' },
    ] },
    primaryType: 'TakerControl',
    message: { taker: account.address, chainId: BigInt(CHAIN_ID), nonce, issuedAt: BigInt(issuedAt) },
  });
  return { nonce, issuedAt, signature };
}

type RfqResponse = {
  data?: {
    rfqId?: string; claimToken?: string; status?: string; reason?: string;
    quote?: { takerPays?: string; buyAmount?: string; reactor?: string; expiresAt?: string };
    transactions?: { swap?: { to?: string; data?: string } };
  };
  error?: { message?: string; details?: { reason?: string } };
};

async function postRfq(body: Record<string, unknown>): Promise<{ status: number; json: RfqResponse }> {
  const res = await fetch(`${TEXTILE_API}/rfq/request`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(75_000),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as RfqResponse };
}

/** A firm quote for exactly `cngnAtomic` of cNGN, paid in USD₮ by the FX wallet. */
export async function quoteCngn(cngnAtomic: bigint): Promise<QuoteResult> {
  if (!fxConfigured()) return { ok: false, reason: 'The FX wallet is not configured.' };
  const body: Record<string, unknown> = {
    chainId: CHAIN_ID, sellToken: CELO_USDT, buyToken: CELO_CNGN, buyAmount: cngnAtomic.toString(), taker: fxAccount().address,
  };
  try {
    let r = await postRfq(body);
    if (r.status === 401 && r.json.error?.details?.reason === 'proof_of_control_required') {
      r = await postRfq({ ...body, takerProof: await signTakerProof() });
    }
    const d = r.json.data;
    if (r.status !== 200 || !d) return { ok: false, reason: r.json.error?.message || `Textile FX answered ${r.status}.` };
    if (d.status !== 'quoted') return { ok: false, reason: `No quote (${d.reason || d.status || 'unknown'}).` };
    const q = d.quote, swap = d.transactions?.swap;
    if (!q?.takerPays || !q.buyAmount || !q.reactor || !q.expiresAt || !swap?.to || !swap.data || !d.rfqId) {
      return { ok: false, reason: 'Textile FX returned an incomplete quote.' };
    }
    const quote: FxQuote = {
      rfqId: d.rfqId, claimToken: d.claimToken || '', takerPays: BigInt(q.takerPays), buyAmount: BigInt(q.buyAmount),
      reactor: q.reactor as `0x${string}`, expiresAt: Date.parse(q.expiresAt), swap: { to: swap.to as `0x${string}`, data: swap.data as Hex },
    };
    // The venue must give us at least what we asked for, from the reactor it names.
    if (quote.buyAmount < cngnAtomic) return { ok: false, reason: 'The quote delivers less cNGN than requested.' };
    if (quote.swap.to.toLowerCase() !== quote.reactor.toLowerCase()) return { ok: false, reason: 'The quote names a different settlement contract.' };
    return { ok: true, quote };
  } catch (e) {
    return { ok: false, reason: `Textile FX could not be reached: ${errorMessage(e).slice(0, 120)}` };
  }
}

export type SwapResult = { ok: true; swapTx: `0x${string}`; usdSold: bigint } | { ok: false; reason: string; swapTx?: `0x${string}` };

/**
 * Settle a quote from the FX wallet: approve exactly what it pays (USD₮ refuses a nonzero to
 * nonzero approve, so reset first), then send Textile's swap with our tags appended, and confirm on
 * chain that the cNGN arrived.
 */
export async function settleQuote(quote: FxQuote): Promise<SwapResult> {
  const wallet = fxClient();
  const me = wallet.account.address;
  try {
    const [usdt, allowance] = await Promise.all([
      wallet.readContract({ address: CELO_USDT, abi: erc20Abi, functionName: 'balanceOf', args: [me] }),
      wallet.readContract({ address: CELO_USDT, abi: erc20Abi, functionName: 'allowance', args: [me, quote.reactor] }),
    ]);
    if (usdt < quote.takerPays) return { ok: false, reason: 'The FX wallet does not hold enough USD₮ for this conversion.' };
    if (allowance < quote.takerPays) {
      if (allowance > BigInt(0)) {
        const reset = await wallet.writeContract({ address: CELO_USDT, abi: erc20Abi, functionName: 'approve', args: [quote.reactor, BigInt(0)], ...txExtras() });
        await wallet.waitForTransactionReceipt({ hash: reset });
      }
      const approve = await wallet.writeContract({ address: CELO_USDT, abi: erc20Abi, functionName: 'approve', args: [quote.reactor, quote.takerPays], ...txExtras() });
      const r = await wallet.waitForTransactionReceipt({ hash: approve });
      if (r.status !== 'success') return { ok: false, reason: 'The USD₮ approval reverted.' };
    }
    if (Date.now() >= quote.expiresAt) return { ok: false, reason: 'The quote expired before it could be sent.' };

    const extras = txExtras();
    const swapTx = await wallet.sendTransaction({
      to: quote.swap.to, data: extras.dataSuffix ? concat([quote.swap.data, extras.dataSuffix]) : quote.swap.data, value: BigInt(0),
      feeCurrency: extras.feeCurrency,
    });
    const receipt = await wallet.waitForTransactionReceipt({ hash: swapTx });
    if (receipt.status !== 'success') return { ok: false, reason: 'The Textile FX swap reverted.', swapTx };
    const received = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs })
      .filter((l) => l.address.toLowerCase() === CELO_CNGN.toLowerCase() && l.args.to.toLowerCase() === me.toLowerCase())
      .reduce((t, l) => t + l.args.value, BigInt(0));
    if (received < quote.buyAmount) return { ok: false, reason: 'The swap settled but delivered less cNGN than quoted.', swapTx };

    // Optional, and settlement is reconciled on chain without it.
    fetch(`${TEXTILE_API}/rfq/${quote.rfqId}/submit`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-Rfq-Claim': quote.claimToken }, body: JSON.stringify({ txHash: swapTx }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
    return { ok: true, swapTx, usdSold: quote.takerPays };
  } catch (e) {
    return { ok: false, reason: `The conversion could not be sent: ${errorMessage(e).slice(0, 160)}` };
  }
}

/** Send cNGN from the FX wallet (tagged), and confirm it. */
export async function sendCngn(to: `0x${string}`, atomic: bigint): Promise<{ ok: true; tx: `0x${string}` } | { ok: false; reason: string; tx?: `0x${string}` }> {
  const wallet = fxClient();
  try {
    const tx = await wallet.writeContract({ address: CELO_CNGN, abi: erc20Abi, functionName: 'transfer', args: [to, atomic], ...txExtras() });
    const r = await wallet.waitForTransactionReceipt({ hash: tx });
    return r.status === 'success' ? { ok: true, tx } : { ok: false, reason: 'The cNGN transfer reverted.', tx };
  } catch (e) {
    return { ok: false, reason: `The cNGN transfer could not be sent: ${errorMessage(e).slice(0, 160)}` };
  }
}

/** The FX wallet's float, for the admin panel. Null when not configured. */
export async function fxBalances(): Promise<{ address: string; usdt: number; cngn: number } | null> {
  const address = fxWalletAddress();
  if (!address) return null;
  const wallet = fxClient();
  const [usdt, cngn] = await Promise.all([
    wallet.readContract({ address: CELO_USDT, abi: erc20Abi, functionName: 'balanceOf', args: [address] }),
    wallet.readContract({ address: CELO_CNGN, abi: erc20Abi, functionName: 'balanceOf', args: [address] }),
  ]);
  return { address, usdt: Number(usdt) / 10 ** TOKEN_DECIMALS, cngn: Number(cngn) / 10 ** TOKEN_DECIMALS };
}
