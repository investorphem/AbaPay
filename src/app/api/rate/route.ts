import { NextResponse } from 'next/server';

export async function GET() {
  try {
    // 1. THE SOURCE OF TRUTH
    // We pull the exact exchange rate from your secure .env file.
    // Whatever number you put here is exactly what the user gets. 
    // You calculate your own profit before setting this number!
    const fixedRate = parseFloat(process.env.NEXT_PUBLIC_FIXED_RATE || "1550");

    // 2. SERVICE CONFIGURATION ENGINE
    // We explicitly set the fees for each service here so the frontend can't make mistakes.
    const serviceConfig = {
      "AIRTIME": { userFeeNaira: 0 },
      "DATA": { userFeeNaira: 0 },
      "ELECTRICITY": { userFeeNaira: 100 },
      "CABLE": { userFeeNaira: 100 }
    };

    return NextResponse.json({
      success: true,
      liveMarketRate: fixedRate, 
      abaPayRate: fixedRate, // The exact rate the user sees and the frontend uses
      services: serviceConfig
    });

  } catch (error) {
    console.error("Rate API Error:", error);
    // Ultimate safety fallback. If the backend fails, default to a safe rate.
    return NextResponse.json({ 
      success: false, 
      abaPayRate: 1550, 
      services: { "AIRTIME": { userFeeNaira: 0 }, "ELECTRICITY": { userFeeNaira: 100 } }
    }, { status: 500 });
  }
}
