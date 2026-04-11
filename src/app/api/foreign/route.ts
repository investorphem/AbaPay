import { NextResponse } from 'next/server';
import { getHeaders } from '@/lib/vtpass'; 

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get('action');

  const appMode = process.env.NEXT_PUBLIC_APP_MODE || "sandbox";
  const baseUrl = appMode === "live" ? "https://vtpass.com/api" : "https://sandbox.vtpass.com/api";

  try {
    // ⚡ REMOVED 'GET' argument from getHeaders() across all calls ⚡
    
    if (action === 'countries') {
      const res = await fetch(`${baseUrl}/get-international-airtime-countries`, { 
        method: 'GET', 
        headers: getHeaders() 
      });
      return NextResponse.json(await res.json());
    }

    if (action === 'product-types') {
      const code = searchParams.get('code');
      const res = await fetch(`${baseUrl}/get-international-airtime-product-types?code=${code}`, { 
        method: 'GET', 
        headers: getHeaders() 
      });
      return NextResponse.json(await res.json());
    }

    if (action === 'operators') {
      const code = searchParams.get('code');
      const product_type_id = searchParams.get('product_type_id');
      const res = await fetch(`${baseUrl}/get-international-airtime-operators?code=${code}&product_type_id=${product_type_id}`, { 
        method: 'GET', 
        headers: getHeaders() 
      });
      return NextResponse.json(await res.json());
    }

    if (action === 'variations') {
      const operator_id = searchParams.get('operator_id');
      const product_type_id = searchParams.get('product_type_id');
      const res = await fetch(`${baseUrl}/service-variations?serviceID=foreign-airtime&operator_id=${operator_id}&product_type_id=${product_type_id}`, { 
        method: 'GET', 
        headers: getHeaders() 
      });
      return NextResponse.json(await res.json());
    }
    
    return NextResponse.json({ success: false, message: "Invalid action type." }, { status: 400 });
    
  } catch (error: any) { 
    console.error("Foreign API Engine Failure:", error.message);
    return NextResponse.json({ success: false, message: "Internal Server Error" }, { status: 500 }); 
  }
}
