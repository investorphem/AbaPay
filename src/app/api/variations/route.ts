import { NextResponse } from 'next/server';
import { getHeaders } from '@/lib/vtpass'; 

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const serviceID = searchParams.get('serviceID');

  if (!serviceID) {
    return NextResponse.json({ error: 'serviceID is required' }, { status: 400 });
  }

  const appMode = process.env.NEXT_PUBLIC_APP_MODE || "sandbox";
  const baseUrl = appMode === "live" ? "https://vtpass.com/api" : "https://sandbox.vtpass.com/api";

  try {
    const vtpassResponse = await fetch(`${baseUrl}/service-variations?serviceID=${serviceID}`, {
      method: 'GET',
      headers: getHeaders(),
      cache: 'no-store' 
    });

    const data = await vtpassResponse.json();

    // ⚡ DEBUG LOGS: This is how you see the truth in Vercel Logs ⚡
    console.log(`📡 [VTpass Request] Service: ${serviceID} | Mode: ${appMode}`);
    console.log(`📦 [VTpass Response]:`, JSON.stringify(data, null, 2));

    return NextResponse.json(data);

  } catch (error: any) {
    console.error("❌ Variation Fetch Error:", error.message);
    return NextResponse.json({ error: 'Failed to fetch variations from VTpass' }, { status: 500 });
  }
}
