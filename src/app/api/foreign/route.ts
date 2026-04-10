import { NextResponse } from 'next/server';
import { BASE_URL, getHeaders } from '@/lib/vtpass';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get('action');

  try {
    // ⚡ NEW: 0. Fetch Supported Countries Dynamically
    if (action === 'countries') {
      const res = await fetch(`${BASE_URL}/get-international-airtime-countries`, { 
        method: 'GET', 
        headers: getHeaders('GET') 
      });
      return NextResponse.json(await res.json());
    }

    // 1. Fetch Product Types (Finds out the ID for Airtime vs Data for that specific country)
    if (action === 'product-types') {
      const code = searchParams.get('code');
      if (!code) return NextResponse.json({ success: false, message: "Country code is required" }, { status: 400 });
      
      const res = await fetch(`${BASE_URL}/get-international-airtime-product-types?code=${code}`, { 
        method: 'GET', 
        headers: getHeaders('GET') 
      });
      return NextResponse.json(await res.json());
    }

    // 2. Fetch Operators (e.g., MTN Ghana, Safaricom Kenya)
    if (action === 'operators') {
      const code = searchParams.get('code');
      const product_type_id = searchParams.get('product_type_id');
      if (!code || !product_type_id) return NextResponse.json({ success: false, message: "Code and Product Type ID required" }, { status: 400 });

      const res = await fetch(`${BASE_URL}/get-international-airtime-operators?code=${code}&product_type_id=${product_type_id}`, { 
        method: 'GET', 
        headers: getHeaders('GET') 
      });
      return NextResponse.json(await res.json());
    }

    // 3. Fetch Pricing Variations (e.g., 5 GHS Fixed, or Flexible pricing rules)
    if (action === 'variations') {
      const operator_id = searchParams.get('operator_id');
      const product_type_id = searchParams.get('product_type_id');
      if (!operator_id || !product_type_id) return NextResponse.json({ success: false, message: "Operator ID and Product Type ID required" }, { status: 400 });

      const res = await fetch(`${BASE_URL}/service-variations?serviceID=foreign-airtime&operator_id=${operator_id}&product_type_id=${product_type_id}`, { 
        method: 'GET', 
        headers: getHeaders('GET') 
      });
      return NextResponse.json(await res.json());
    }

    return NextResponse.json({ success: false, message: "Invalid action type." }, { status: 400 });

  } catch (error: any) {
    console.error("Foreign API Engine Error:", error.message);
    return NextResponse.json({ success: false, message: "Internal Server Error" }, { status: 500 });
  }
}
