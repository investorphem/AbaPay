import { NextResponse } from 'next/server';
import { getActiveDiscountForService, computeDiscountNgn } from '@/lib/discounts';

// ⚡ PUBLIC PREVIEW ONLY — lets the web app show "🎉 10% off applied" before payment. The
// actual enforcement happens server-side again inside /api/pay/route.ts (see src/lib/discounts.ts's
// header comment) — nothing here is trusted for settlement.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const service = searchParams.get('service');
  const amount = Number(searchParams.get('amount') || 0);
  const wallet = searchParams.get('wallet');
  const destination = searchParams.get('destination');

  try {
    const discount = await getActiveDiscountForService(service);
    const discountNgn = await computeDiscountNgn(amount, discount, wallet, destination);

    return NextResponse.json({
      success: true,
      discount: discount
        ? { id: discount.id, name: discount.name, type: discount.type, value: discount.value, maxDiscountNgn: discount.maxDiscountNgn }
        : null,
      discountNgn,
    });
  } catch {
    return NextResponse.json({ success: true, discount: null, discountNgn: 0 });
  }
}
