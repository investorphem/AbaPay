import { NextResponse } from 'next/server';
import { getHeaders } from '@/lib/vtpass';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const countryCode = searchParams.get('code');

  if (!countryCode) {
    return NextResponse.json({ error: 'Country code is required' }, { status: 400 });
  }

  const appMode = process.env.NEXT_PUBLIC_APP_MODE || "sandbox";
  const baseUrl = appMode === "live" ? "https://vtpass.com/api" : "https://sandbox.vtpass.com/api";

  try {
    const response = await fetch(`${baseUrl}/get-international-airtime-operators?code=${countryCode}`, {
      method: 'GET',
      headers: getHeaders(),
      cache: 'no-store'
    });
    
    const data = await response.json();
    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json({ error: 'Failed to fetch international operators' }, { status: 500 });
  }
}
