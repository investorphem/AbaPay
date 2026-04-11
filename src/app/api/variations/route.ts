import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const serviceID = searchParams.get('serviceID');

  if (!serviceID) {
    return NextResponse.json({ error: 'serviceID is required' }, { status: 400 });
  }

  const username = process.env.VTPASS_EMAIL;
  const password = process.env.VTPASS_PASSWORD;

  if (!username || !password) {
    return NextResponse.json({ error: 'VTpass credentials missing' }, { status: 500 });
  }

  const authToken = Buffer.from(`${username}:${password}`).toString('base64');
  
  // ⚡ DYNAMIC ENVIRONMENT SWITCHING VIA APP MODE ⚡
  const appMode = process.env.NEXT_PUBLIC_APP_MODE || "sandbox"; // Defaults to sandbox for safety
  const baseUrl = appMode === "live" ? "https://vtpass.com/api" : "https://sandbox.vtpass.com/api";

  try {
    const vtpassResponse = await fetch(`${baseUrl}/service-variations?serviceID=${serviceID}`, {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${authToken}`,
        'Content-Type': 'application/json',
      },
      cache: 'no-store' 
    });

    const data = await vtpassResponse.json();
    return NextResponse.json(data);

  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch variations from VTpass' }, { status: 500 });
  }
}
