import { NextResponse } from 'next/server';
import { getHeaders } from '@/lib/vtpass';

export async function POST(req: Request) {
  try {
    const { billersCode, serviceID, type } = await req.json();

    // ⚡ DYNAMIC ENVIRONMENT SWITCHING VIA APP MODE ⚡
    const appMode = process.env.NEXT_PUBLIC_APP_MODE || "sandbox";
    const baseUrl = appMode === "live" ? "https://vtpass.com/api" : "https://sandbox.vtpass.com/api";

    let url = `${baseUrl}/merchant-verify`;
    let bodyPayload: any = { billersCode, serviceID };

    // Ensures we pass the variation code for JAMB, Bank Transfers, and Electricity
    if (type) bodyPayload.type = type;

    // ⚡ VTPASS SMILE NETWORK OVERRIDE ⚡
    if (serviceID === 'smile-direct') {
       url = `${baseUrl}/merchant-verify/smile/email`;
       bodyPayload = { billersCode, serviceID }; // billersCode here acts as the email
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: getHeaders('POST'),
      body: JSON.stringify(bodyPayload)
    });

    const data = await res.json();
    return NextResponse.json(data);
    
  } catch (error: any) {
    console.error("Verification Engine Failure:", error.message);
    return NextResponse.json({ code: "500", message: "Verification Failed" }, { status: 500 });
  }
}
