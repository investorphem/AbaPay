import { NextResponse } from 'next/server';
import { BASE_URL, getHeaders } from '@/lib/vtpass';

export async function POST(req: Request) {
  try {
    const { billersCode, serviceID, type } = await req.json();

    let url = `${BASE_URL}/merchant-verify`;
    let bodyPayload: any = { billersCode, serviceID };

    if (type) bodyPayload.type = type;

    // ⚡ VTPASS SMILE NETWORK OVERRIDE ⚡
    if (serviceID === 'smile-direct') {
       url = `${BASE_URL}/merchant-verify/smile/email`;
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
    return NextResponse.json({ code: "500", message: "Verification Failed" }, { status: 500 });
  }
}
