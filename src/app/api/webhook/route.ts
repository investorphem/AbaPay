import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { supabaseAdmin } from '@/utils/supabase';
import { sendTelegramAlert } from '@/lib/telegram';
import { cleanupStalePreflights } from '@/lib/cleanupPreflights';
import { reconcileStuckProcessing } from '@/lib/reconcileStuck';
import { reconcileRecordedRefunds } from '@/lib/refundVerify';
import { reconcileX402Intents } from '@/lib/reconcileX402';
import { explorerBaseFor } from '@/lib/chain';
import { executeVend } from '@/lib/vend';
import { vendInputFromRow } from '@/lib/vendInput';
import { verifyVaultPayment, UNDECIDED_PROOF_FAILURES, type PaymentProofFailure } from '@/lib/paymentProof';

// ⚡ ALCHEMY ADDRESS-ACTIVITY WEBHOOK — the background completer for the contract-call rail.
//
// The web app (/api/pay), the agent relayer and the scheduler all settle their own payments
// synchronously. This is the net under them: when a request dies after the transaction is
// broadcast, the vault's transfer still reaches here, and the matching row is proven and vended.
//
// Since the M2.2 consolidation it has NO logic of its own for either half of that job:
//   • PROOF  — src/lib/paymentProof.ts, the same vault-event check /api/pay uses (token, amount,
//     account, service, payer — all against the stored row);
//   • VEND   — src/lib/vend.ts's executeVend, from the stored row (src/lib/vendInput.ts).
// It used to carry its own copy of both, and the copies had drifted: a VTpass network error
// here marked the row FAILED with no refund queued, "accepted but pending" was handled
// differently, and points were priced by a third formula.

// Verifier codes -> the error_code the admin dashboard already renders for this webhook.
const LEDGER_CODES: Partial<Record<PaymentProofFailure, string>> = {
  REVERTED: 'REVERTED',
  NO_EVENT: 'NO_CONTRACT_EVENT',
  SENDER_MISMATCH: 'SENDER_MISMATCH',
  TOKEN_MISMATCH: 'TOKEN_MISMATCH',
  AMOUNT_SHORT: 'AMOUNT_MISMATCH',
  ACCOUNT_MISMATCH: 'ACCOUNT_MISMATCH',
  SERVICE_MISMATCH: 'SERVICE_MISMATCH',
};

// A mismatch against ONE candidate row says nothing about another: the same wallet can have
// several open intents, and only one of them is this payment.
const CANDIDATE_SPECIFIC: ReadonlySet<PaymentProofFailure> = new Set([
  'SENDER_MISMATCH', 'TOKEN_MISMATCH', 'AMOUNT_SHORT', 'ACCOUNT_MISMATCH', 'SERVICE_MISMATCH', 'TOKEN_UNKNOWN',
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows come from the untyped Supabase client
type TxRow = Record<string, any>;

async function alert(text: string) {
    try { await sendTelegramAlert(text); } catch { /* alerting never changes an outcome */ }
}

// How long the synchronous path gets before this webhook starts on the same payment, and the
// pause between row lookups. Overridable only so tests don't sleep; production uses the defaults.
const HEAD_START_MS = Number(process.env.WEBHOOK_HEAD_START_MS ?? 15_000);
const LOOKUP_RETRY_MS = Number(process.env.WEBHOOK_LOOKUP_RETRY_MS ?? 2_000);

export async function POST(req: Request) {
    try {
        const rawBody = await req.text();
        const signature = req.headers.get('x-alchemy-signature');

        const baseSecret = process.env.ALCHEMY_WEBHOOK_SECRET;
        const celoSecret = process.env.ALCHEMY_CELO_WEBHOOK_SECRET;

        if (!signature || (!baseSecret && !celoSecret)) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        // 🔐 Constant-time comparison. `===` on a hex digest short-circuits at the first
        // differing byte, so response time leaks how much of the digest a guess got right —
        // the standard way to forge an HMAC without knowing the secret. Note the payload is only
        // ever a TRIGGER: even a perfectly forged webhook cannot cause a vend, because everything
        // below re-reads the real receipt from chain and verifies it against the stored row.
        const signatureMatches = (secret: string): boolean => {
            const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
            const a = Buffer.from(signature);
            const b = Buffer.from(digest);
            if (a.length !== b.length) return false;
            try { return crypto.timingSafeEqual(a, b); } catch { return false; }
        };

        let isValid = false;
        if (baseSecret) isValid = signatureMatches(baseSecret);
        if (!isValid && celoSecret) isValid = signatureMatches(celoSecret);

        if (!isValid) {
            return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
        }

        const body = JSON.parse(rawBody);
        const activity = body.event?.activity?.[0];

        if (!activity) return NextResponse.json({ message: "No activity" });

        const txHash = String(activity.hash || '').toLowerCase();

        if (txHash === "0xtesttransactionhash") {
            console.log("✅ Alchemy Test Successful for abapays.com");
            return NextResponse.json({ message: "Test Successful" });
        }

        // ⚡ OPPORTUNISTIC SWEEPS (no paid cron required) — fire-and-forget, each internally
        // throttled to at most once every 5 min per warm instance, never delaying this response.
        //   • stale preflights that were never signed -> EXPIRED
        //   • PROCESSING rows orphaned mid-vend on any rail -> resolved by provider requery
        //   • refunds broadcast from the admin's wallet but never recorded
        //   • x402 intents whose request died after the intent was recorded
        cleanupStalePreflights().catch(() => {});
        reconcileStuckProcessing().catch(() => {});
        reconcileRecordedRefunds().catch(() => {});
        reconcileX402Intents().catch(() => {});

        // Extract the user's wallet address from Alchemy payload to find abandoned preflights
        const fromAddress = activity.fromAddress || null;

        // ⚡ FAST PRE-CHECK — SKIP THE EXPENSIVE PATH FOR IRRELEVANT EVENTS ⚡
        //
        // Alchemy fires on EVERY matching on-chain event for the watched address, not just our
        // app's payments. The pre-flight intent row is written BEFORE the user signs (see
        // /api/pay's intent step), so by the time a transaction exists on-chain a matching row
        // MUST already exist — keyed by the real tx_hash, or still a `preflight_` row for that
        // wallet. If neither is present, this event isn't ours and no amount of waiting changes that.
        {
            const { data: preExisting } = await supabaseAdmin
                .from('transactions')
                .select('status')
                .eq('tx_hash', txHash)
                .maybeSingle();

            // Already finished (SUCCESS / FAILED_VENDING / REFUNDED / PROCESSING) — nothing to do.
            if (preExisting && preExisting.status !== 'PENDING') {
                return NextResponse.json({ message: "Already processed" });
            }

            if (!preExisting) {
                let hasRescuable = false;
                if (fromAddress) {
                    const { data: pendingPreflight } = await supabaseAdmin
                        .from('transactions')
                        .select('id')
                        .ilike('wallet_address', fromAddress)
                        .eq('status', 'PENDING')
                        .like('tx_hash', 'preflight_%')
                        // An x402 intent is not a contract-call preflight: its settlement has no
                        // PaymentReceived event, so "rescuing" one here would fail it as
                        // NO_CONTRACT_EVENT mid-flight. src/lib/reconcileX402.ts owns those.
                        .not('tx_hash', 'like', 'preflight_x402_%')
                        .limit(1)
                        .maybeSingle();
                    hasRescuable = !!pendingPreflight;
                }

                if (!hasRescuable) {
                    console.log(`Webhook: fast-exit, no pending record for tx ${txHash} (from: ${fromAddress || 'n/a'}).`);
                    return NextResponse.json({ message: "No matching record — acknowledged." }, { status: 200 });
                }
            }
        }

        // ⚡ 1. HEAD START FOR THE SYNCHRONOUS PATH. The browser (or relayer) is usually settling
        // this same payment right now; waiting lets it finish first. Correctness does NOT depend
        // on this — both sides claim the row with the same conditional write — it only avoids
        // duplicate receipt reads.
        await new Promise(resolve => setTimeout(resolve, HEAD_START_MS));

        // ⚡ 2. FIND THE ROW THIS PAYMENT BELONGS TO — by exact hash, or, if the payer's request
        // died before attaching it, among that wallet's open intents (most recent first).
        let candidates: TxRow[] = [];
        let matchedByHash = false;
        for (let attempt = 0; attempt < 5 && candidates.length === 0; attempt++) {
            if (attempt) await new Promise(resolve => setTimeout(resolve, LOOKUP_RETRY_MS));

            const { data: exact } = await supabaseAdmin.from('transactions').select('*').eq('tx_hash', txHash).maybeSingle();
            if (exact) {
                if (exact.status !== 'PENDING') return NextResponse.json({ message: "Already processed" });
                candidates = [exact];
                matchedByHash = true;
                break;
            }

            if (fromAddress) {
                const { data: open } = await supabaseAdmin
                    .from('transactions')
                    .select('*')
                    // case-insensitive: Alchemy lowercases addresses; older rows may be checksummed
                    .ilike('wallet_address', fromAddress)
                    .eq('status', 'PENDING')
                    .like('tx_hash', 'preflight_%')
                    .not('tx_hash', 'like', 'preflight_x402_%') // see the fast pre-check above
                    .order('created_at', { ascending: false })
                    .limit(5);
                if (open?.length) candidates = open;
            }
        }

        if (candidates.length === 0) {
            // ⚡ Always 2xx here — Alchemy treats non-2xx as a delivery failure and auto-disables
            // the webhook after enough of them. "No matching record" is a normal outcome.
            console.log(`Webhook: no matching PENDING record for tx ${txHash} (fromAddress: ${fromAddress || 'n/a'}). Acknowledging anyway.`);
            return NextResponse.json({ message: "No matching record found — acknowledged." }, { status: 200 });
        }

        // ⚡ 3. PROVE IT — against each candidate's OWN stored terms.
        let proven: TxRow | null = null;
        let firstFailure: { code: PaymentProofFailure; detail: string } | null = null;
        for (const row of candidates) {
            const proof = await verifyVaultPayment(txHash, {
                blockchain: row.blockchain,
                tokenSymbol: row.token_used || 'USD₮',
                minAmountCrypto: row.amount_usdt,
                accountNumber: row.account_number,
                serviceId: row.service_id,
                walletAddress: row.wallet_address,
            });
            if (proof.ok) { proven = row; break; }
            firstFailure ??= proof;
            // Reverted / no vault event / chain unreadable are facts about the TRANSACTION, not
            // the row — the same for every candidate, so stop asking.
            if (!CANDIDATE_SPECIFIC.has(proof.code)) break;
        }

        if (!proven) {
            const failure = firstFailure!;
            const explorerUrl = `${explorerBaseFor(candidates[0].blockchain)}/tx/${txHash}`;

            if (UNDECIDED_PROOF_FAILURES.has(failure.code)) {
                // The node couldn't answer. Nothing was claimed, so the row is still PENDING and
                // the reconcile sweep / the payer's retry can finish it.
                console.error('Webhook: receipt unavailable —', failure.detail);
                return NextResponse.json({ status: "Node Error. Left Pending." });
            }

            if (!matchedByHash) {
                // An unrelated transaction from a wallet that happens to have an open intent (a
                // refund landing, a transfer for something else). It proves nothing about that
                // intent, so the intent is left alone — marking it failed here used to kill a
                // user's in-flight payment because an unrelated tx arrived first.
                console.log(`Webhook: tx ${txHash} does not match any open intent for ${fromAddress} (${failure.code}) — ignored.`);
                return NextResponse.json({ status: "Not a payment for any open intent — acknowledged." });
            }

            // Matched by exact hash: the row claims THIS transaction, and the chain says no.
            const row = candidates[0];
            if (failure.code === 'NO_EVENT') {
                // 🔴 A REFUND IS NOT A FAILED PAYMENT. A hash already banked as some row's
                // refund_hash moved tokens OUT of the vault; it has no PaymentReceived by design.
                const { data: asRefund } = await supabaseAdmin.from('transactions').select('tx_hash').ilike('refund_hash', txHash).limit(1);
                if (asRefund && asRefund.length > 0) {
                    console.warn('[Webhook] Hash is a recorded REFUND, not a payment — ignoring:', txHash);
                    return NextResponse.json({ status: 'Hash is a recorded refund, not a payment. Ignored.' }, { status: 200 });
                }
            }

            const ledgerCode = LEDGER_CODES[failure.code];
            if (ledgerCode) {
                await supabaseAdmin.from('transactions').update({ status: 'FAILED_VENDING', error_code: ledgerCode, api_response: failure.detail.slice(0, 500) })
                    .eq('id', row.id).eq('status', 'PENDING');
            }
            await alert(`🛑 *WEBHOOK BLOCKED: ${ledgerCode || failure.code}*\n${failure.detail}\n👤 \`${row.wallet_address}\`\nHash: \`${txHash}\`\n🔍 *Explorer:* ${explorerUrl}`);
            return NextResponse.json({ status: `Blocked: ${failure.code}` }, { status: 200 });
        }

        // ⚡ 4. CLAIM + LOCK — attach the proven hash and take PENDING -> PROCESSING in one
        // conditional write. Whoever else is settling this payment (the browser, the relayer)
        // races on the same write; exactly one wins. A hash already on another row is refused
        // by the UNIQUE index.
        const { data: locked, error: lockError } = await supabaseAdmin.from('transactions')
            .update({ tx_hash: txHash, status: 'PROCESSING' })
            .eq('id', proven.id)
            .eq('status', 'PENDING')
            .select()
            .maybeSingle();

        if (lockError?.code === '23505') {
            await alert(`🚨 *WEBHOOK: HASH ALREADY CLAIMED*\n\`${txHash}\` is attached to another transaction — not vended twice.\n👤 \`${proven.wallet_address}\``);
            return NextResponse.json({ message: "Hash already claimed by another transaction" });
        }
        if (!locked) {
            return NextResponse.json({ message: "Already processing by another execution" });
        }

        console.log(`🚀 Vending (webhook) for ${locked.account_number} on ${locked.blockchain}`);

        // ⚡ 5. VEND — the shared engine, from the stored row. Refunds, alerts, SMS, email and
        // points all happen inside executeVend, identically to every other rail.
        const { data: settings } = await supabaseAdmin.from('platform_settings').select('exchange_rate').eq('id', 1).single();
        const baseRate = Number(settings?.exchange_rate) || 1500;
        const result = await executeVend(vendInputFromRow(locked, {
            txHash,
            explorerUrl: `${explorerBaseFor(locked.blockchain)}/tx/${txHash}`,
            baseRate,
        }));

        return NextResponse.json({ status: `Vend ${result.status}` }, { status: 200 });

    } catch (error) {
        console.error("Webhook System Error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
