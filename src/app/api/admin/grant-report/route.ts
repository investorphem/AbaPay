import { NextResponse } from 'next/server';
import { verifyAdminRequest } from '@/utils/adminAuth';
import { buildGrantReport, grantReportCsv } from '@/lib/grantReport';
import { errorMessage } from '@/lib/errors';

export const dynamic = 'force-dynamic';

// GET /api/admin/grant-report?from=YYYY-MM-DD&to=YYYY-MM-DD[&format=csv]
// The Prezenti milestone-1 count (src/lib/grantReport.ts) for a window: `to` is exclusive, so a
// 30-day window is from=D&to=D+30. Admin only — it lists payer wallets.
export async function GET(req: Request) {
  const auth = await verifyAdminRequest(req);
  if (!auth.authorized) return NextResponse.json({ success: false, message: auth.message }, { status: 401 });

  const url = new URL(req.url);
  const from = url.searchParams.get('from') || '';
  const to = url.searchParams.get('to') || '';
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (!day.test(from) || !day.test(to) || from >= to) {
    return NextResponse.json({ success: false, message: 'Give from and to as YYYY-MM-DD, with from before to (to is exclusive).' }, { status: 400 });
  }

  try {
    const report = await buildGrantReport(`${from}T00:00:00Z`, `${to}T00:00:00Z`);
    if (url.searchParams.get('format') === 'csv') {
      return new NextResponse(grantReportCsv(report), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="abapay-external-agent-payments_${from}_${to}.csv"`,
          'Cache-Control': 'no-store',
        },
      });
    }
    return NextResponse.json({ success: true, report }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return NextResponse.json({ success: false, message: errorMessage(e) }, { status: 500 });
  }
}
