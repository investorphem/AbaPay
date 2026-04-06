import { NextResponse } from 'next/server';
import { BASE_URL, getHeaders } from '@/lib/vtpass';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { billersCode, serviceID, type } = body;

    const payload: any = { billersCode, serviceID };
    if (type) payload.type = type;

    const res = await fetch(`${BASE_URL}/merchant-verify`, {
      method: 'POST',
      headers: getHeaders('POST'),
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error.message }, { status: 500 });
  }
}
