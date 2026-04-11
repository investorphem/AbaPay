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
    console.error("❌ CRITICAL: VTpass Email or Password is missing in your .env.local file!");
    return NextResponse.json({ error: 'VTpass credentials missing' }, { status: 500 });
  }

  const authToken = Buffer.from(`${username}:${password}`).toString('base64');
  
  // ⚡ IF YOU ARE USING SANDBOX CREDENTIALS, UNCOMMENT THE SANDBOX URL AND COMMENT THE LIVE URL ⚡
  // const baseUrl = "https://sandbox.vtpass.com/api";
  const baseUrl = "https://vtpass.com/api"; 

  try {
    console.log(`📡 Fetching VTpass Service: ${serviceID}...`);
    
    const vtpassResponse = await fetch(`${baseUrl}/service-variations?serviceID=${serviceID}`, {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${authToken}`,
        'Content-Type': 'application/json',
      },
      // ⚡ FORCE NEXT.JS NOT TO CACHE THIS WHILE WE ARE DEBUGGING ⚡
      cache: 'no-store' 
    });

    const data = await vtpassResponse.json();

    // Log the actual VTpass response to your terminal
    if (data.response_description !== "000") {
      console.error("🛑 VTPASS REJECTED THE REQUEST:", data);
    } else {
      console.log("✅ VTPASS SUCCESS: Banks Loaded!");
    }

    return NextResponse.json(data);

  } catch (error) {
    console.error("🔥 FATAL VTPASS API ERROR:", error);
    return NextResponse.json({ error: 'Failed to fetch variations from VTpass' }, { status: 500 });
  }
}
