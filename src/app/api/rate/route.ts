import { NextResponse } from 'next/server';
import { supabaseAdmin as supabase } from '@/utils/supabase'; 

export async function GET() {
  try {
    // 1. THE SOURCE OF TRUTH: Your Admin Dashboard (Supabase)
    // We pull the exact exchange rate directly from the database.
    const { data: settingsData, error } = await supabase
      .from('platform_settings')
      .select('exchange_rate')
      .eq('id', 1)
      .single();

    if (error || !settingsData) {
      throw new Error("Failed to fetch rate from Supabase database");
    }

    const liveAdminRate = parseFloat(settingsData.exchange_rate);

    // 2. SERVICE CONFIGURATION ENGINE
    // We explicitly set the fees for each service here to match your frontend and payment engine.
    const serviceConfig = {
      "AIRTIME": { userFeeNaira: 0 },
      "DATA": { userFeeNaira: 0 },
      "INTERNET": { userFeeNaira: 0 },
      "ELECTRICITY": { userFeeNaira: 100 },
      "CABLE": { userFeeNaira: 100 },
      "BANK": { userFeeNaira: 100 },
      "EDUCATION": { userFeeNaira: 100 }
    };

    return NextResponse.json({
      success: true,
      liveMarketRate: liveAdminRate, 
      abaPayRate: liveAdminRate, // The exact rate the user sees and the frontend uses
      services: serviceConfig
    });

  } catch (error) {
    console.error("Rate API Error:", error);
    // Ultimate safety fallback. If the backend or DB fails, default to a safe rate.
    return NextResponse.json({ 
      success: false, 
      abaPayRate: 1550, 
      services: { "AIRTIME": { userFeeNaira: 0 }, "ELECTRICITY": { userFeeNaira: 100 }, "BANK": { userFeeNaira: 100 } }
    }, { status: 500 });
  }
}
