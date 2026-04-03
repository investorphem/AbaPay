import { NextResponse } from 'next/server';

export async function GET() {
  try {
    // 1. THE SOURCE OF TRUTH
    // We pull the exact P2P market rate from your secure .env file.
    // If you forget to set it, we default to 1200. (A low default ensures you NEVER lose money if a bug happens).
    const marketRate = parseFloat(process.env.TRUE_MARKET_RATE || "1200");

    // 2. YOUR CRYPTO SPREAD (3% Profit)
    // Example: If market is 1410, we take 3% (42.3). 
    // The rate the customer gets is 1367.7 NGN per 1 USDT.
    const profitPercentage = 0.03; 
    const customerRate = marketRate - (marketRate * profitPercentage);

    // 3. SERVICE CONFIGURATION ENGINE
    // We explicitly set the fees for each service here so the frontend can't make mistakes.
    const serviceConfig = {
      "AIRTIME": { userFeeNaira: 0 },
      "DATA": { userFeeNaira: 0 },
      "ELECTRICITY": { userFeeNaira: 100 },
      "CABLE": { userFeeNaira: 100 }
    };

    return NextResponse.json({
      success: true,
      liveMarketRate: marketRate,
      abaPayRate: customerRate, 
      services: serviceConfig
    });

  } catch (error) {
    console.error("Rate API Error:", error);
    // Ultimate safety fallback. If the backend fails, default to a rate so low you make a massive profit, preventing losses.
    return NextResponse.json({ 
      success: false, 
      abaPayRate: 1200, 
      services: { "AIRTIME": { userFeeNaira: 0 }, "ELECTRICITY": { userFeeNaira: 100 } }
    }, { status: 500 });
  }
}