// src/app/api/intl/route.ts
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action');
  const code = searchParams.get('code');
  const type_id = searchParams.get('type_id');
  const operator_id = searchParams.get('operator_id');

  const apiKey = process.env.VTPASS_API_KEY;
  const publicKey = process.env.VTPASS_PUBLIC_KEY;
  const appMode = process.env.NEXT_PUBLIC_APP_MODE || "sandbox";
  const baseUrl = appMode === "live" ? "https://vtpass.com/api" : "https://sandbox.vtpass.com/api";

  const headers = {
    'api-key': apiKey || '',
    'public-key': publicKey || '',
    'Content-Type': 'application/json'
  };

  try {
    let endpoint = "";
    if (action === "countries") endpoint = "/get-international-airtime-countries";
    else if (action === "products") endpoint = `/get-international-airtime-product-types?code=${code}`;
    else if (action === "operators") endpoint = `/get-international-airtime-operators?code=${code}&product_type_id=${type_id}`;
    else if (action === "variations") endpoint = `/service-variations?serviceID=foreign-airtime&operator_id=${operator_id}&product_type_id=${type_id}`;
    else return NextResponse.json({ error: "Invalid action" }, { status: 400 });

    const response = await fetch(`${baseUrl}${endpoint}`, { method: 'GET', headers, cache: 'no-store' });
    const data = await response.json();
    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json({ error: 'Failed to fetch international data' }, { status: 500 });
  }
}
