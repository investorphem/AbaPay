import { NextResponse } from 'next/server';
import { BASE_URL, getHeaders } from '@/lib/vtpass';

export async function GET() {
  try {
    // 1. Fetch Naira Wallet (GET uses Public Key)
    const walletRes = await fetch(`${BASE_URL}/balance`, {
      method: 'GET',
      headers: getHeaders('GET')
    });
    const walletData = await walletRes.json();

    // 2. Fetch SMS Wallet
    const smsRes = await fetch(`https://messaging.vtpass.com/api/sms/balance`, {
      method: 'GET',
      headers: {
        'X-Token': process.env.VTPASS_MSG_TOKEN,
        'X-Secret': process.env.VTPASS_MSG_SECRET,
      }
    });
    const smsBalance = await smsRes.text();

    return NextResponse.json({
      env: process.env.NEXT_PUBLIC_APP_MODE,
      chain: process.env.NEXT_PUBLIC_CHAIN_NET,
      naira: walletData.contents?.balance?.toLocaleString() || "0.00",
      sms: parseFloat(smsBalance).toFixed(0),
      status: "Operational"
    });
  } catch (err) {
    console.error("Health Check Failed:", err);
    return NextResponse.json({ status: "Error", msg: err.message }, { status: 500 });
  }
}