import type { VendInput } from '@/lib/vend';

/**
 * Build the vend input from a STORED `transactions` row — never from a request body.
 *
 * Every rail that settles a payment against a row it recorded earlier (/api/pay, /api/pay/x402,
 * the x402 reconciler) vends through this, so what gets delivered is always what was priced and
 * paid for: anything not visible on-chain (variation_code — which data plan or cable package —
 * phone, subscription type, email) can't be swapped between paying and vending.
 *
 * Kept dependency-free (a type-only import) so it can be exercised as-is in route tests that
 * mock the vend itself.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows come from the untyped Supabase client
export function vendInputFromRow(row: Record<string, any>, ctx: { txHash: string; explorerUrl: string; baseRate: number; vtRequestId?: string }): VendInput {
  return {
    vtRequestId: ctx.vtRequestId ?? row.request_id,
    txHash: ctx.txHash,
    serviceID: row.service_id,
    serviceCategory: row.service_category,
    network: row.network,
    billersCode: row.account_number,
    phone: row.phone,
    variation_code: row.variation_code ?? undefined,
    subscription_type: row.subscription_type ?? undefined,
    amount: row.amount_usdt,
    tokenSymbol: row.token_used,
    vendAmount: Number(row.amount_naira),
    displayAmount: row.display_amount ?? undefined,
    foreignAmount: row.foreign_amount ?? undefined,
    isForeign: row.service_id === 'foreign-airtime',
    operator_id: row.operator_id ?? undefined,
    country_code: row.country_code ?? undefined,
    product_type_id: row.product_type_id ?? undefined,
    email: row.customer_email,
    wallet_address: row.wallet_address,
    blockchain: row.blockchain,
    source_channel: row.source_channel,
    customer_name: row.customer_name,
    customer_address: row.customer_address,
    baseRate: ctx.baseRate,
    explorerUrl: ctx.explorerUrl,
  };
}
