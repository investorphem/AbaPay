import { NextResponse } from 'next/server';
import { getHeaders } from '@/lib/vtpass';

export async function GET() {
  const appMode = process.env.NEXT_PUBLIC_APP_MODE || "sandbox";
  const baseUrl = appMode === "live" ? "https://vtpass.com/api" : "https://sandbox.vtpass.com/api";

  try {
    const response = await fetch(`${baseUrl}/get-international-airtime-countries`, {
      method: 'GET',
      headers: getHeaders(),
      cache: 'no-store'
    });
    
    const data = await response.json();
    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json({ error: 'Failed to fetch international countries' }, { status: 500 });
  }
}
