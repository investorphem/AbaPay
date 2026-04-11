import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  // 1. Get the serviceID from the frontend request (e.g., 'bank-deposit', 'waec', etc.)
  const { searchParams } = new URL(request.url);
  const serviceID = searchParams.get('serviceID');

  if (!serviceID) {
    return NextResponse.json({ error: 'serviceID is required' }, { status: 400 });
  }

  // 2. Get your credentials from the .env file
  const username = process.env.VTPASS_EMAIL;
  const password = process.env.VTPASS_PASSWORD;

  if (!username || !password) {
    return NextResponse.json({ error: 'VTpass credentials missing in server' }, { status: 500 });
  }

  // 3. Create the Basic Auth Token
  const authToken = Buffer.from(`${username}:${password}`).toString('base64');

  // 4. Determine if we are in Sandbox or Live mode (Change to vtpass.com for live)
  // const baseUrl = "https://sandbox.vtpass.com/api";
  const baseUrl = "https://vtpass.com/api"; 

  try {
    // 5. Securely fetch from VTpass
    const vtpassResponse = await fetch(`${baseUrl}/service-variations?serviceID=${serviceID}`, {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${authToken}`,
        'Content-Type': 'application/json',
      },
      // Next.js caching: revalidate every hour so your app loads fast without spamming VTpass
      next: { revalidate: 3600 } 
    });

    const data = await vtpassResponse.json();

    // 6. Send the VTpass data back to your frontend
    return NextResponse.json(data);

  } catch (error) {
    console.error("VTpass API Error:", error);
    return NextResponse.json({ error: 'Failed to fetch variations from VTpass' }, { status: 500 });
  }
}
