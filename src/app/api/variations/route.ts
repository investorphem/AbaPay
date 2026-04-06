import { NextResponse } from 'next/server';
import { BASE_URL, getHeaders } from '@/lib/vtpass';

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const serviceID = searchParams.get('serviceID');

    const res = await fetch(`${BASE_URL}/service-variations?serviceID=${serviceID}`, {
      method: 'GET',
      headers: getHeaders('GET')
    });

    const data = await res.json();
    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json({ success: false, message: error.message }, { status: 500 });
  }
}
