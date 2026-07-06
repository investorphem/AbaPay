import { NextResponse } from 'next/server';

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
