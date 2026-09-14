import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, FolderGit2, ShieldCheck, Ban, RefreshCw } from "lucide-react";
import CopyBlock from "../../CopyBlock";

export const metadata: Metadata = {
  title: "Integration Guide — AbaPay Rails",
  description: "Non-custodial mechanics, the off-chain vend/refund handoff, and every kill switch that can stop an agent's spending on AbaPay.",
};

// ⚡ THIS CONTENT IS THE "Settlement, Custody & Compliance" SECTION OF
// docs/AGENT_INTEGRATION.md, IN PAGE FORM — the two integration paths themselves already have
// full pages (/agents/x402, /agents/a2a); reproducing them again here would just be the same
// words twice. This page carries what those two don't: the custody model, the off-chain
// handoff, and the kill switches — genuinely new material, not a restatement.
export default function GuidePage() {
  return (
    <>
      <Link href="/agents/developers" className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400 mb-6">
        <ArrowLeft size={14} /> Developers
      </Link>

      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl sm:text-4xl font-black tracking-tight text-slate-900 dark:text-white mb-4 text-balance">Integration guide</h1>
          <p className="text-lg text-slate-600 dark:text-slate-300 leading-relaxed font-medium max-w-2xl">
            The two integration paths — <Link href="/agents/x402" className="underline hover:text-emerald-500">x402</Link> and <Link href="/agents/a2a" className="underline hover:text-emerald-500">A2A / MCP</Link> — get their own full pages. What follows is what happens after a payment is signed: custody, settlement, and every way an agent&apos;s spending can be stopped.
          </p>
        </div>
        <a href="https://github.com/investorphem/AbaPay/blob/main/docs/AGENT_INTEGRATION.md" target="_blank" rel="noopener noreferrer" title="View source on GitHub" className="p-2 text-slate-300 dark:text-slate-600 hover:text-slate-600 dark:hover:text-slate-300 flex-shrink-0">
          <FolderGit2 size={20} />
        </a>
      </div>

      <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2rem] p-6 sm:p-8 mb-6">
        <h2 className="font-black text-slate-900 dark:text-white mb-3 flex items-center gap-2"><ShieldCheck size={18} className="text-emerald-500" /> Non-custodial by construction, not just by claim</h2>
        <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed mb-4 max-w-2xl">
          AbaPay never takes custody of funds ahead of a payment. There is no deposit step, no pooled balance held on your behalf. The settlement contract uses a pull-based ERC-20 allowance, and every constraint is enforced <strong className="text-slate-900 dark:text-white">on-chain</strong>, not by application code a direct API call could bypass:
        </p>
        <ul className="space-y-2.5 text-sm text-slate-600 dark:text-slate-300 max-w-2xl">
          <li className="flex gap-2"><span className="text-emerald-500 flex-shrink-0">•</span> The agent-relay function reverts if an amount exceeds either the owner-set per-transaction ceiling <em>or</em> the caller&apos;s own remaining spending allowance — both checked before anything moves.</li>
          <li className="flex gap-2"><span className="text-emerald-500 flex-shrink-0">•</span> The allowance is decremented <em>before</em> the token transfer (checks-effects-interactions), so a reentrant call can&apos;t double-spend the same allowance.</li>
          <li className="flex gap-2"><span className="text-emerald-500 flex-shrink-0">•</span> Tokens move directly from the payer&apos;s wallet to the settlement contract in the same transaction that decrements the allowance — no intermediate AbaPay-controlled balance for them to sit in.</li>
          <li className="flex gap-2"><span className="text-emerald-500 flex-shrink-0">•</span> Setting a spending allowance can only ever be called by the wallet setting its own allowance — no owner/admin path exists for AbaPay&apos;s backend to grant itself more room on anyone&apos;s account.</li>
        </ul>
        <p className="text-xs text-slate-400 dark:text-slate-500 mb-3">The actual checks, verbatim from <code className="text-slate-500">contracts/AbaPayV4.sol</code>:</p>
        <CopyBlock
          code={`function payBillFor(address user, address tokenAddress, ..., uint256 amount)
    external onlyRelayer whenNotPaused nonReentrant
{
    uint256 perTxCap = maxAgentPaymentPerTx[tokenAddress];
    if (amount > perTxCap) revert ExceedsMaxAgentPayment(amount, perTxCap);

    uint256 remaining = spendingAllowance[user][tokenAddress];
    if (amount > remaining) revert ExceedsSpendingAllowance(amount, remaining);

    // EFFECTS BEFORE INTERACTIONS: burn the allowance first, so a reentrant
    // token cannot spend the same allowance twice.
    spendingAllowance[user][tokenAddress] = remaining - amount;

    uint256 received = _pull(tokenAddress, user, amount);
    emit PaymentReceived(user, tokenAddress, serviceType, accountNumber, received);
}

function setSpendingAllowance(address tokenAddress, uint256 amount) external {
    // msg.sender only -- no owner/relayer path raises anyone else's allowance.
    spendingAllowance[msg.sender][tokenAddress] = amount;
}`}
        />
        <p className="text-xs text-slate-400 dark:text-slate-500 mt-4">
          This matches the framing already published at <a href="/terms" className="underline hover:text-emerald-500">/terms</a>: AbaPay operates as a non-custodial software protocol / technology interface, not a custodian, with no access to any wallet&apos;s private keys. (/terms also covers AML monitoring and is explicitly not represented as lawyer-reviewed — read it directly for anything you need to rely on legally.)
        </p>
      </section>

      <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2rem] p-6 sm:p-8 mb-6">
        <h2 className="font-black text-slate-900 dark:text-white mb-3 flex items-center gap-2"><RefreshCw size={18} className="text-emerald-500" /> The off-chain leg: how a payment becomes a delivered bill</h2>
        <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed mb-4 max-w-2xl">
          The on-chain payment and the off-chain vend are two separate steps, bridged by a webhook, not a synchronous call:
        </p>
        <ol className="space-y-3 max-w-2xl">
          {[
            "The stablecoin payment lands on-chain (contract call or x402 settlement).",
            "AbaPay's backend, triggered by the on-chain event, calls the licensed bill-aggregation API this product vends through to actually deliver the purchase.",
            "If vending fails after the on-chain payment already confirmed, the transaction enters an automatic refund flow — flagged, verified against what actually happened, and refunded on-chain without a human needing to intervene.",
          ].map((step, i) => (
            <li key={step} className="flex items-start gap-3 text-sm text-slate-700 dark:text-slate-300">
              <span className="w-5 h-5 rounded-full bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-100 dark:border-emerald-800/50 text-emerald-600 dark:text-emerald-400 text-[10px] font-black flex items-center justify-center flex-shrink-0 mt-0.5">{i + 1}</span>
              {step}
            </li>
          ))}
        </ol>
        <p className="text-xs text-slate-400 dark:text-slate-500 mt-4 max-w-2xl">
          An agent integrating against this should treat a pending or failed-vend state as a real, expected outcome with money already moved — not an error to retry blindly. Retrying an already-settled payment double-charges the wallet.
        </p>
      </section>

      <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2rem] p-6 sm:p-8">
        <h2 className="font-black text-slate-900 dark:text-white mb-3 flex items-center gap-2"><Ban size={18} className="text-emerald-500" /> Kill switches — all of them stop the agent, not just the UI</h2>
        <ul className="space-y-2.5 text-sm text-slate-600 dark:text-slate-300 max-w-2xl">
          <li className="flex gap-2"><span className="text-emerald-500 flex-shrink-0">•</span> <strong className="text-slate-900 dark:text-white">Per-channel pause</strong> — an operator can pause just the MCP surface without touching Telegram/WhatsApp/X.</li>
          <li className="flex gap-2"><span className="text-emerald-500 flex-shrink-0">•</span> <strong className="text-slate-900 dark:text-white">Global pause</strong> — the contract itself can be paused; payments revert while paused, but refunds deliberately stay callable so anyone already charged can still be made whole.</li>
          <li className="flex gap-2"><span className="text-emerald-500 flex-shrink-0">•</span> <strong className="text-slate-900 dark:text-white">Relayer kill switch</strong> — instantly disables the agent-initiated payment path system-wide, on-chain, independent of anything the backend does. A compromised backend cannot re-enable itself.</li>
          <li className="flex gap-2"><span className="text-emerald-500 flex-shrink-0">•</span> <strong className="text-slate-900 dark:text-white">Per-credential rate limiting</strong> — every money-moving call is rate-limited per API key, on top of the PIN requirement.</li>
          <li className="flex gap-2"><span className="text-emerald-500 flex-shrink-0">•</span> <strong className="text-slate-900 dark:text-white">PIN lockout</strong> — escalating lockout on repeated failed PIN attempts.</li>
        </ul>
        <p className="text-xs text-slate-400 dark:text-slate-500 mb-3">The two contract-level switches, verbatim:</p>
        <CopyBlock
          code={`/// Instantly disables the agent-initiated path system-wide, on-chain --
/// independent of anything the backend does. A compromised backend
/// cannot re-enable itself.
function setRelayer(address newRelayer) external onlyOwner {
    relayer = newRelayer;
}

/// payBillFor reverts while paused. Refunds deliberately stay callable
/// so anyone already charged can still be made whole.
function pause() external onlyOwner { _pause(); }`}
        />
        <p className="text-xs text-slate-400 dark:text-slate-500 mt-4 max-w-2xl">
          None of these live only in the web app — they&apos;re enforced by the same code path (or the contract itself) regardless of which channel or credential is calling in, MCP and A2A included.
        </p>
      </section>
    </>
  );
}
