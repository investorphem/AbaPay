import { NextResponse } from 'next/server';
import { getHeaders } from '@/lib/vtpass';
import { getWalletBalance } from '@/lib/monnify';
import { verifyAdminRequest } from '@/utils/adminAuth';

export async function GET(req) {
  // 🔐 SECURITY: wallet balances are for the admin's eyes only
  const auth = await verifyAdminRequest(req);
  if (!auth.authorized) {
    return NextResponse.json({ success: false, message: auth.message }, { status: 401 });
  }

  try {
    // ⚡ DYNAMIC ENVIRONMENT SWITCHING VIA APP MODE ⚡
    const appMode = process.env.NEXT_PUBLIC_APP_MODE || "sandbox";
    const baseUrl = appMode === "live" ? "https://vtpass.com/api" : "https://sandbox.vtpass.com/api";

    // 1. Fetch Naira Wallet (GET uses Public Key)
    const walletRes = await fetch(`${baseUrl}/balance`, {
      method: 'GET',
      headers: getHeaders('GET')
    });
    const walletData = await walletRes.json();

    // 2. Fetch SMS Wallet
    const smsRes = await fetch(`https://messaging.vtpass.com/api/sms/balance`, {
      method: 'GET',
      headers: {
        'X-Token': process.env.VTPASS_MSG_TOKEN || "",
        'X-Secret': process.env.VTPASS_MSG_SECRET || "",
      }
    });
    const smsBalance = await smsRes.text();

    // 3. Fetch Monnify (Moniepoint) disbursement wallet balance — separate provider, separate
    // float, so it's tracked alongside VTpass's rather than folded into it. null (not thrown)
    // when credentials aren't configured yet, so this never breaks the health check for
    // installs still waiting on Monnify approval.
    const monnifyBalance = await getWalletBalance();

    return NextResponse.json({
      env: appMode,
      chain: process.env.NEXT_PUBLIC_NETWORK || "Unknown",
      naira: walletData.contents?.balance?.toLocaleString() || "0.00",
      sms: !isNaN(parseFloat(smsBalance)) ? parseFloat(smsBalance).toFixed(0) : "0",
      monnify: monnifyBalance ? {
        available: monnifyBalance.availableBalance.toLocaleString(),
        ledger: monnifyBalance.ledgerBalance.toLocaleString(),
        accountNumber: monnifyBalance.accountNumber,
      } : null,
      status: "Operational"
    });
  } catch (err) { // ⚡ REMOVED ": any" for JavaScript compatibility
    console.error("Health Check Failed:", err);
    return NextResponse.json({ status: "Error", msg: err.message }, { status: 500 });
  }
}
