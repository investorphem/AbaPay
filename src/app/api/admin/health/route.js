import { NextResponse } from 'next/server';
import { getHeaders } from '@/lib/vtpass'; 

export async function GET() {
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

    return NextResponse.json({
      env: appMode,
      chain: process.env.NEXT_PUBLIC_NETWORK || "Unknown",
      naira: walletData.contents?.balance?.toLocaleString() || "0.00",
      sms: !isNaN(parseFloat(smsBalance)) ? parseFloat(smsBalance).toFixed(0) : "0",
      status: "Operational"
    });
  } catch (err) { // ⚡ REMOVED ": any" for JavaScript compatibility
    console.error("Health Check Failed:", err);
    return NextResponse.json({ status: "Error", msg: err.message }, { status: 500 });
  }
}
