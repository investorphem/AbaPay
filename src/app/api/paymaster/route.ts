import { NextResponse } from 'next/server';
import { enforceRateLimit, enforceRateLimitByKey } from '@/lib/rateLimit';
import { checkUserOperation, type SponsorScope } from '@/lib/paymasterPolicy';
import { vaultAddressFor } from '@/lib/paymentProof';
import { tokenSymbolsForChain, resolveTokenOnChain } from '@/constants';
import { isMainnetEnv } from '@/lib/chain';

// Base mainnet (8453) and Base Sepolia (84532), as the hex chain ids ERC-7677 passes.
const BASE_CHAIN_IDS = new Set(['0x2105', '0x14a34', '8453', '84532']);

// The contracts a sponsored UserOperation may call: the Base vault and its stablecoins.
function sponsorScope(): SponsorScope | null {
  const vault = vaultAddressFor('BASE');
  if (!vault) return null;
  const tokens = tokenSymbolsForChain('BASE')
    .map((s) => resolveTokenOnChain(s, 'BASE', isMainnetEnv())?.address?.toLowerCase())
    .filter((a): a is string => !!a);
  return { vault, tokens };
}

// ⚡ PAYMASTER PROXY (Base gas sponsorship) ⚡
//
// Smart-wallet clients (Coinbase Smart Wallet / Base Account) that support the
// EIP-5792 `paymasterService` capability call whatever URL we hand them directly
// from the browser as raw JSON-RPC (`pm_getPaymasterStubData`, `pm_getPaymasterData`, etc).
//
// Rather than pointing wallets straight at Coinbase's CDP paymaster endpoint
// (which has your API key baked into the URL path), we point them at THIS route.
// This route holds the real, secret CDP paymaster URL server-side only
// (process.env.PAYMASTER_URL) and simply forwards the JSON-RPC request/response.
// The API key is never present in any client-side bundle, network tab, or wallet config.

export async function POST(req: Request) {
  try {
    const paymasterUrl = process.env.PAYMASTER_URL; // e.g. https://api.developer.coinbase.com/rpc/v1/base/<key>

    if (!paymasterUrl) {
      return NextResponse.json(
        { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Paymaster not configured on server' } },
        { status: 500 }
      );
    }

    const body = await req.text();

    // 🔐 METHOD ALLOWLIST: this proxy exists solely so wallets can request gas
    // sponsorship — it must not double as a free, unauthenticated general-purpose
    // RPC relay running on our CDP key. Only ERC-7677 paymaster methods pass.
    const ALLOWED_METHODS = new Set([
      'pm_getPaymasterStubData',
      'pm_getPaymasterData',
      'pm_sponsorUserOperation',
      'pm_getAcceptedPaymentTokens',
    ]);
    let requests: any[];
    try {
      const parsed = JSON.parse(body);
      requests = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return NextResponse.json(
        { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
        { status: 400 }
      );
    }
    if (requests.length === 0 || requests.length > 5) {
      return NextResponse.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid batch' } }, { status: 400 });
    }

    // Per-IP ceiling first — cheap, and bounds how hard anyone can probe the policy below.
    const ipLimited = await enforceRateLimit(req, 'paymaster', 60, 600);
    if (ipLimited) return ipLimited;

    // 🔐 SPONSORSHIP POLICY — only AbaPay's own calls get free gas. See src/lib/paymasterPolicy.ts.
    const scope = sponsorScope();
    for (const r of requests) {
      if (!r || typeof r.method !== 'string' || !ALLOWED_METHODS.has(r.method)) {
        return NextResponse.json(
          { jsonrpc: '2.0', id: r?.id ?? null, error: { code: -32601, message: 'Method not allowed through this proxy' } },
          { status: 403 }
        );
      }
      if (r.method === 'pm_getAcceptedPaymentTokens') continue; // no UserOperation to check
      const [userOp, , chainId] = Array.isArray(r.params) ? r.params : [];
      const refuse = (message: string) => NextResponse.json(
        { jsonrpc: '2.0', id: r.id ?? null, error: { code: -32602, message: `Not sponsored: ${message}` } },
        { status: 403 }
      );
      if (!scope) return refuse('sponsorship is not configured for this chain');
      if (chainId !== undefined && !BASE_CHAIN_IDS.has(String(chainId).toLowerCase())) return refuse('only Base is sponsored');
      const policy = checkUserOperation(userOp, scope);
      if (!policy.ok) return refuse(policy.reason);

      const sender = String(userOp?.sender || '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(sender)) return refuse('missing sender');
      // Stub + final data is 2 calls per payment, so 20 per 10 minutes is ~10 payments.
      const senderLimited = await enforceRateLimitByKey(`paymaster:${sender}`, 20, 600);
      if (senderLimited) return senderLimited;
    }

    const upstreamRes = await fetch(paymasterUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    const data = await upstreamRes.text();

    return new NextResponse(data, {
      status: upstreamRes.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    console.error('Paymaster proxy error:', error);
    return NextResponse.json(
      { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Paymaster proxy failed' } },
      { status: 500 }
    );
  }
}
