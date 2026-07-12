# AbaPay — Comprehensive Codebase Audit (v2)

**Auditor roles:** Principal Engineer · Security Researcher · Smart-Contract Auditor · Protocol Reviewer · Product Designer
**Date:** Second full pass, after the remediation cycle following Audit v1
**Scope:** Entire repository — 52 source files (~8,620 LOC), 3 Solidity contracts (447 LOC), 25 API routes, CI/CD, tests, migrations, dependencies

**Project Information**
| | |
|---|---|
| **Blockchain** | Celo + Base (EVM), with EIP-5792 / ERC-4337 gas sponsorship |
| **Framework** | Next.js 16.2.10 (App Router, React 19, Turbopack) |
| **Language** | TypeScript (+ Solidity ^0.8.20) |
| **Repository** | github.com/investorphem/AbaPay |
| **Purpose** | Non-custodial crypto→fiat utility bill payments (airtime, data, electricity, cable, bank, education, international) via VTpass, with a conversational "DeAI" agent layer |

> **Method & honesty note.** This is a static review plus verified build/test evidence. I have confirmed: the contracts **compile** (18 files, evm:paris) and the contract suite **passes 21/21**. I have **not** run the app's E2E flow, deployed to any network, or executed a live transaction. A static audit is **not** a substitute for a professional smart-contract audit before pooled funds are at stake.

---

## Executive Summary

**Since Audit v1 this project has improved substantially and measurably.** The two largest gaps identified then — *zero tests* and *no CI* — have been genuinely closed, not papered over. The smart contract has been rewritten with real hardening and now has a passing test suite proving its security properties. Several classes of vulnerability (plaintext PINs, publicly-callable AI brain, spoofable bot webhooks, unbounded paymaster proxy, silent config failure) have been eliminated.

**Grade: B → B+. Score: ~73 → ~80/100.**

However, **three things still block "production ready"**, and one of them is new:

1. 🔴 **NEW — HIGH: `/api/requery` is unauthenticated and leaks purchased goods.** It returns `purchased_code` (the electricity token / exam PIN the user paid for) to *anyone* who supplies a `request_id`, with no auth, no ownership check, and no rate limit. Request IDs are generated with `Math.random()` and a predictable timestamp prefix. **This is exploitable today.**
2. 🔴 **The hardened contract is not deployed.** `AbaPayV2` compiles and passes 21/21 tests — but **production still runs V1**, with its single-key owner, instant unlimited `withdrawFunds`, no pause, and no reentrancy guard. All that hardening currently protects nothing.
3. 🟠 **No professional smart-contract audit.** Tests prove the properties I thought to test. An auditor finds the ones I didn't.

---

## 1. Architecture Review — **8/10** *(was 7.5)*

**Improved:** Genuine service extraction is now happening — `lib/rateLimit.ts`, `lib/cleanupPreflights.ts`, `utils/pinSecurity.ts`, `utils/internalAuth.ts` are clean, single-purpose, reusable modules. The decision to make `cleanupPreflights` a shared helper consumed by both a route and the webhook (rather than duplicating) is exactly right. The `tsconfig` scope fix properly separates app / test / Hardhat concerns.

**Still open:**
- **`page.tsx` remains 2,686 lines.** This is the single worst maintainability liability in the codebase. It holds the entire payment UI, wallet lifecycle, transaction state machine, history, and modals. It is effectively untestable and every change risks regression.
- **`admin/page.tsx` is 964 lines** — same problem, smaller.
- **Duplicate on-chain verification logic** between `/api/pay` and `/api/webhook`. Both independently decode receipts and cross-check amounts. This is *security-critical duplicated logic* — a fix applied to one and not the other is a live vulnerability. Extract a shared `verifyOnChainPayment()`.
- Vend logic remains inlined in `/api/pay` rather than a reusable service — which is precisely why DeAI cannot reuse it.

---

## 2. Code Quality — per folder

| Folder | v1 | **v2** | Notes |
|---|---|---|---|
| `contracts/` | 6/10 | **9/10** | `AbaPayV2.sol` is a marked improvement: OZ libraries, custom errors, thorough NatSpec explaining *why* each hardening exists, checks-effects-interactions. Professional-grade. V1 remains in-tree (correctly, for reference). |
| `src/utils/` | 8.5/10 | **9/10** | Best code in the repo. `pinSecurity`, `internalAuth`, `adminAuth` are clean, timing-safe, and fail closed. |
| `src/lib/` | 6/10 | **6.5/10** | New TS modules are good. **But `vtpass.js`, `telegram.js`, `messaging.js` remain untyped `.js` on money paths.** Credit: all three carry `import 'server-only'` — a genuinely good guard. |
| `src/app/api/` | 7.5/10 | **8/10** | Security commentary is now excellent and explains intent. `pay/route.ts` still does far too much in one function (verify + vend + email + SMS + points + alerts). |
| `src/components/` | 7/10 | **7/10** | Unchanged. `Modals.tsx` (427 LOC) is manageable. |
| `tests/` + `test/` | — | **8/10** | New. Tests are well-named, explain *why* they exist, and target real fraud paths rather than trivia. |

---

## 3. Security Audit

### 🔴 HIGH — H-1 (NEW): Unauthenticated PIN/token disclosure via `/api/requery`

**Evidence** (`src/app/api/requery/route.ts`):
```ts
export async function POST(req: Request) {
  const { request_id, tx_hash } = await req.json();
  // ...no auth, no ownership check, no rate limit...
  const { data: record } = await supabase.from('transactions')
      .select('*').eq('request_id', request_id).single();
  // ...
  return NextResponse.json({ ..., purchased_code: dbPurchasedCode, units: vendedUnits });
}
```

**Why it matters:** `purchased_code` **is the product**. For electricity it's the meter recharge token; for education it's the WAEC/JAMB PIN. These are bearer secrets worth real money. This endpoint hands them to anyone who presents a matching `request_id` — no wallet signature, no session, no admin auth.

**Compounding factor — request IDs are weakly random** (`src/lib/vtpass.js`):
```js
const dateStr = YYYY + MM + DD + HH + mm;                       // fully predictable
const randomSuffix = Math.random().toString(36).substring(2,10); // NOT cryptographically secure
return `${dateStr}${randomSuffix}`;
```
`Math.random()` is not a CSPRNG — V8's generator is reversible from a small number of observed outputs. The 12-char prefix is just a timestamp to the minute, so an attacker targeting a known purchase window only needs the suffix. **And there is no rate limit on this endpoint**, so guessing is unthrottled.

**Exploit scenario:** Attacker buys one item (learning the request_id format and the current minute), then floods `/api/requery` with candidate IDs for the same minute window. Any hit returns another customer's electricity token or exam PIN, which they redeem. The victim's meter never gets credited. There is no logging of failed attempts.

**Fix (all three):**
1. **Require ownership proof.** Bind requery to the caller's wallet — e.g. require `tx_hash` *and* verify `record.wallet_address` matches a signature, or gate it to the record's own wallet session. At minimum require *both* `request_id` AND `tx_hash` to match the same row.
2. **Use a CSPRNG:** `crypto.randomUUID()` or `crypto.randomBytes(16).toString('hex')` for the suffix.
3. **Rate-limit it** (`enforceRateLimit`, already built).

### 🔴 HIGH — H-2: Hardened contract not deployed; V1 still live

`AbaPayV2` compiles and passes 21/21 tests, but **production runs the original `AbaPay.sol`**:
- `withdrawFunds` sends the **entire pooled vault** to a single EOA owner, instantly, with no timelock and no cap. **A single compromised key = total loss of all users' pooled funds.**
- No `Pausable` — a discovered vulnerability cannot be halted.
- No `ReentrancyGuard` — currently mitigated only by the fact that the owner has whitelisted well-behaved stablecoins. `setTokenSupport` can whitelist *any* token.
- Raw `IERC20` + `require(transfer(...))` — breaks on non-bool-returning tokens.

**The hardening you now own protects nothing until it is deployed.** *(See §4 and §12.)*

### 🟠 MEDIUM

**M-1 — Rate-limit coverage is incomplete.** Applied to `verify`, `verify/request`, `verify/confirm`. **Not applied to:**
| Route | Cost of abuse |
|---|---|
| `/api/variations` | Billable VTpass call |
| `/api/intl`, `/api/foreign` | Billable VTpass calls |
| `/api/requery` | Billable VTpass call **+ enables H-1 brute force** |
| `/api/support` | Ticket spam |
| `/api/rate` | DB read amplification |
> ⚠️ **Also: the `rate_limits` table migration must actually be applied.** `rateLimit()` **fails open** by design — if `supabase/migrations/001_rate_limits.sql` has not been run, every throttle silently does nothing while appearing to work.

**M-2 — Security-critical logic is duplicated.** On-chain amount/token verification exists in *both* `/api/pay` and `/api/webhook`. A future fix applied to one but not the other reopens a fraud path. Extract to one shared module.

**M-3 — Admin refund is not verified on-chain.** `/api/admin/refund` flips DB status to `REFUNDED` using an admin-supplied `refund_hash` that is never validated against the chain. An admin (or anyone with admin session) can mark refunds that never happened. Mirror the inbound verification.

**M-4 — No Content-Security-Policy header.** `next.config.ts` sets HSTS, `X-Content-Type-Options`, Referrer-Policy, Permissions-Policy (good), but no CSP. For a wallet-connected fintech, CSP is the main defence-in-depth against a compromised script.

**M-5 — Environment-mode split-brain.** `NEXT_PUBLIC_APP_MODE` (sandbox/live VTpass) and `NEXT_PUBLIC_NETWORK` (chain) are set independently. A mismatch (mainnet chain + sandbox VTpass, or vice-versa) is silently possible and would be financially messy. Consolidate into one mode.

### 🟢 LOW
- **L-1** Untyped `.js` on money paths (`vtpass.js`, `messaging.js`, `telegram.js`) — no compile-time safety where it matters most. *(Mitigated by `server-only` guards.)*
- **L-2** `@farcaster/miniapp-sdk: "latest"` — non-reproducible builds. Pin it.
- **L-3** 28 production-dependency advisories remain, dominated by unfixable wallet-SDK transitives (`uuid` via MetaMask/Farcaster — "No fix available"). Not negligence; standard for the Web3 ecosystem. `lodash` and `ws` are `npm audit fix`-able.

### ✅ Verified secure (credit where due)
- **No `dangerouslySetInnerHTML` anywhere** — XSS surface is minimal.
- **No secret leaks to the client** — every `NEXT_PUBLIC_*` var is legitimately public (chain IDs, contract addresses, Supabase anon key, WC project ID). Service keys, VTpass keys, and bot tokens are all server-side.
- **`import 'server-only'`** on all secret-touching lib files — an active compile-time guard against accidental client import.
- **PIN hashing** — scrypt + per-PIN salt + timing-safe compare, with transparent legacy migration.
- **OTP is burn-on-failure** — one wrong guess deletes the code, making a 4-digit OTP genuinely un-brute-forceable. *(Better than an attempt counter. I flagged this incorrectly in v1; the design is sound.)*
- **Replay protection** via a DB unique constraint on `tx_hash` — correct for serverless (in-memory would be worthless across cold starts).
- **Webhook event cross-validation** — decodes `PaymentReceived` and enforces sender + token + amount + account all match the pending record. This closes a real fraud path.
- **Internal-service auth** on `/api/deai/*` — the AI brain is no longer publicly impersonatable.
- **HMAC verification** on WhatsApp (`X-Hub-Signature-256`) and X webhooks.
- **Paymaster proxy method allowlist** — cannot be abused as a free RPC relay on your CDP key.
- **Admin auth** — wallet-signature challenge, timestamp replay protection, 12h expiry.
- **Webhook returns 2xx on benign no-match** — prevents Alchemy auto-disabling the webhook.

---

## 4. Smart Contract Audit

### `AbaPayV2.sol` — **9/10** ⚠️ *compiled, tested, **NOT audited, NOT deployed***

| Aspect | Assessment |
|---|---|
| Logic | Sound. `payBill` signature and `PaymentReceived` event kept **byte-identical to V1** — backend requires zero changes. Excellent migration discipline. |
| Storage | Clean; `PendingWithdrawal` struct is minimal. |
| Gas | Custom errors over `require` strings; `immutable`/`constant` where appropriate. Good. |
| Events | Comprehensive — `WithdrawalQueued` is specifically designed to be alerted on. |
| Modifiers | `onlyOwner` + `whenNotPaused` + `nonReentrant` correctly applied. Refunds deliberately *not* pausable so users can be made whole during an incident — thoughtful. |
| Ownership | `Ownable2Step` — cannot be bricked by a typo'd transfer. |
| Upgradeability | **None (not proxied).** A bug means redeploy + migrate. Defensible (proxies add their own risk) but must be a conscious choice. |
| Standards | `SafeERC20` — handles non-bool-returning tokens (real USDT deployments). |
| Access control | Correct and tested. |
| **Notable** | **Balance-delta accounting** in `payBill` emits the amount *actually received*, so fee-on-transfer tokens can't cause the backend to over-vend. This is a subtle bug class most implementations miss. |

**Test evidence — 21/21 passing:** timelock genuinely blocks instant withdrawal; refund cap genuinely blocks a timelock-bypass drain; a real reentrant hook-bearing token is genuinely rejected; fee-on-transfer accounting genuinely emits the received amount; `Ownable2Step` genuinely requires acceptance.

**Residual risks:**
- **Single-EOA owner defeats the timelock.** With one key, an attacker who steals it simply waits out the 24h. The timelock only *stops* an adversary who cannot unilaterally re-queue. **A Safe multisig is not optional — it is the assumption the whole design rests on.**
- Refunds **fail closed** until `setMaxRefund` is called per token. Deploy and forget = cannot refund anyone.

### `AbaPay.sol` (V1) — **5/10** — ⚠️ **THIS IS WHAT'S LIVE**
Single-key instant unlimited withdrawal, no pause, no reentrancy guard, raw `IERC20`. See H-2.

### `contracts/test/Mocks.sol` — **8/10**
Well-constructed: a genuine reentrancy attacker and a real fee-on-transfer token, not toy stubs. Correctly marked test-only.

---

## 5. Blockchain Best Practices — **76/100** *(was 68)*

**Strong:** Correct chains/stablecoins; MiniPay + Farcaster Mini App support; **EIP-5792 `sendCalls` with ERC-7677 paymaster** for sponsored gas on Base (genuinely advanced — most apps don't do this); builder-code attribution on Base txs; the webhook correctly handles the ERC-4337 case where `tx.to` is the bundler rather than your contract (a subtlety many teams get wrong).

**Gaps:** V2 undeployed (so live code lacks OZ hardening); **no RPC failover** — hardcoded `forno.celo.org` / `mainnet.base.org` are single points of failure; pooled custody rather than per-tx settlement; no multisig.

---

## 6. Performance — **7/10**

- **`page.tsx` at 2,686 lines** ships a heavy client bundle and almost certainly causes wide re-renders. Decompose into hooks + memoized children. Biggest available win.
- **Webhook's hardcoded 15-second `setTimeout`** serializes latency on every call. Pragmatic, but a queue would be correct at scale.
- `html2canvas-pro` / `jspdf` correctly **dynamically imported** — good.
- Fresh `createPublicClient` per verification; fine at current volume, would benefit from reuse + fallback transport.
- `cleanupPreflights` throttle is module-scoped — correct and cheap.

---

## 7. User Experience — UI **8/10** · UX **7.5/10** · Accessibility **5/10**

**UI:** Polished, coherent dark mode, well-designed receipts and transactional emails. Strong for a solo build.
**UX:** Good transaction status handling; the sponsored-gas path meaningfully reduces friction on Base; the "payment sent — don't retry" handling on a dropped connection shows real care about the failure modes that actually hurt users.
**Accessibility — the weakest dimension.** Heavy reliance on colour + emoji + `uppercase font-black`; little evidence of ARIA labelling, focus management, or contrast auditing. For a consumer fintech targeting emerging markets and low-end devices, this is a real gap, not a cosmetic one. Run axe/Lighthouse.

---

## 8. Developer Experience — **7.5/10** *(was 5)*

**Transformed.** CI runs typecheck → lint → build → test → audit and is **green**. `npm test`, `npm run test:contracts`, `npm run typecheck` all work. README documents env vars, structure, testing, and migrations. Node version pinned via `engines`.

**Remaining:** no `.env.example`; mixed `.js`/`.ts`; the 2,686-line component would intimidate any new contributor away from the core payment flow.

---

## 9. API Review — **7.5/10**

| Dimension | Status |
|---|---|
| Authentication | Strong where present — admin (signature), internal (HMAC token), webhooks (HMAC), paymaster (allowlist) |
| **Authorization** | ⚠️ **`/api/requery` has none** — and it returns purchased goods (H-1) |
| Validation | Improving; DeAI and OTP validate. Many routes still trust body shape. |
| Rate limiting | Partial — 3 of ~8 abuse-exposed routes (M-1) |
| Versioning | None (`/api/v1/…`). Fine solo; needed before third-party integration. |
| Error responses | Mostly generic to client (correct). Some routes still return `error.message`. |
| Consistency | Response envelopes vary (`{success,status,message}` vs `{error}`). Standardise. |

---

## 10. Testing — **6/10** *(was 0)*

**Real, meaningful progress.**

| Suite | Count | Quality |
|---|---|---|
| `test/AbaPayV2.test.ts` | **21 passing** | Excellent — tests security *properties*, not implementation details |
| `tests/pinSecurity` | ~8 | Good — unique salts, wrong PIN, malformed input, legacy migration |
| `tests/internalAuth` | ~7 | Good — including "fails closed when unconfigured" |
| `tests/paymentVerification` | ~10 | Good — underpayment, dust, zero, decimals confusion |

**Missing (why this is 6 and not 9):**
- **Zero API-route integration tests.** `/api/pay` and `/api/webhook` — the two files where a bug loses money — have **no** tests. `paymentVerification.test.ts` re-implements the comparison logic locally rather than importing it, so it tests *the idea*, not *the shipped code*. **Extract the real verification function and test that.**
- No E2E (Playwright), no component tests.
- No contract coverage report.

---

## 11. Dependency Audit — **7/10**

- Lockfile now **committed and in sync**; CI enforces it. ✅
- Next.js patched to **16.2.10** (was 16.2.2 with XSS/cache-poisoning/SSRF advisories). ✅ **This was the only genuinely production-exposed dependency vulnerability.**
- **28 remaining production advisories**, dominated by `uuid` (via MetaMask SDK → wagmi, and Farcaster → Solana web3.js) marked **"No fix available"**. Unfixable until upstream ships. Every Web3 app has this.
- `lodash` (high) and `ws` (high) are `npm audit fix`-able — **do this**.
- ⚠️ **Never run `npm audit fix --force`** — it proposes downgrading Next 16 → Next 9 and Hardhat 2 → 3. It would destroy the app.
- Pin `@farcaster/miniapp-sdk` (currently `"latest"`).

---

## 12. Production Readiness — **6.5/10** — **Not yet. Blocking list:**

1. 🔴 **Fix H-1** (`/api/requery` auth + CSPRNG request IDs + rate limit). *Exploitable today.*
2. 🔴 **Deploy `AbaPayV2`** — testnet → full E2E → audit → mainnet. Right now all hardening is theoretical.
3. 🔴 **Professional smart-contract audit** before pooled mainnet funds.
4. 🔴 **Safe multisig as contract owner** — without it the timelock is decorative.
5. 🟠 **Apply the `rate_limits` migration** — throttles fail open and silently do nothing until the table exists.
6. 🟠 **Extend rate limiting** to `variations`, `intl`, `foreign`, `requery`, `support`.
7. 🟠 **Verify refunds on-chain** before flipping DB status.
8. 🟠 **Deduplicate on-chain verification** between `/api/pay` and `/api/webhook`.
9. 🟠 **Integration tests for `/api/pay` + `/api/webhook`.**
10. 🟢 CSP header; consolidate env modes; `.js` → `.ts`; RPC failover; V1→V2 migration runbook.

---

## 13. Public Review

**GitHub / open-source maintainer:**
> "Dramatically more credible than a month ago. CI is green, the contract has a real test suite, and the security commentary in the code explains *intent* rather than just describing syntax. I'd still block on the 2,686-line `page.tsx` before accepting community contributions — nobody can safely touch the payment flow. Fix the `/api/requery` auth hole first; it's the kind of thing that ends up in a disclosure post."

**Coinbase / Base ecosystem reviewer:**
> "The Base integration is legitimately strong — EIP-5792 sponsored transactions with a properly-proxied ERC-7677 paymaster, correct ERC-4337 receipt handling in the webhook, builder-code attribution. That's more Base-native depth than most grant applicants show. **Blocking:** the hardened contract isn't deployed, so mainnet still runs a contract where one key drains everything. Deploy V2 behind a Safe, get an audit, and this becomes a strong grant candidate."

**Security firm:**
> "Application-layer security is above average for an indie build — timing-safe comparisons, fail-closed auth, HMAC on every webhook, replay protection done correctly for serverless. We'd issue one High (`/api/requery` unauthenticated bearer-secret disclosure with a `Math.random()` identifier), and require the contract migration before signing off. The V2 contract itself would likely pass with minor findings."

**VC technical reviewer:**
> "Rare solo execution spanning chain, fiat rails, and an agent layer. The remediation velocity between audits is itself a strong signal about the founder. Concerns: single-key contract custody in production, and key-person risk concentrated in one 2,686-line file. De-risk the contract, then this is fundable. The non-custodial positioning is a genuine asset — don't trade it away for the DeAI shortcut."

---

## 14. Scoring

| Dimension | v1 | **v2** | Δ |
|---|---|---|---|
| Architecture | 7.5 | **8.0** | ▲ |
| Code Quality | 7.0 | **7.5** | ▲ |
| Security | 7.0 | **7.5** | ▲ *(would be 8.5 without H-1)* |
| Performance | 7.0 | **7.0** | — |
| **Testing** | **0.0** | **6.0** | ▲▲▲ |
| Documentation | 7.5 | **8.5** | ▲ |
| Developer Experience | 5.0 | **7.5** | ▲▲ |
| UI | 8.0 | **8.0** | — |
| UX | 7.5 | **7.5** | — |
| Accessibility | 5.0 | **5.0** | — |
| Blockchain Best Practices | 6.8 | **7.6** | ▲ |
| Maintainability | 6.5 | **7.0** | ▲ |
| Scalability | 6.5 | **7.0** | ▲ |
| Innovation | 9.0 | **9.0** | — |
| Production Readiness | 5.0 | **6.5** | ▲ |

### **Overall Grade: B+**
### **Overall Score: 80/100** *(was 73)*

*Held back from A− by exactly three things: the live V1 contract, the `/api/requery` hole, and the absence of integration tests on the two money-path routes. All three are fixable in days, not months.*

---

## 15. Final Verdict

| Question | Answer |
|---|---|
| **Approve for production today?** | **No** — fix H-1 (exploitable now) and deploy V2 behind a multisig first. |
| **Approve for an ecosystem grant?** | **Yes, conditionally.** The Base-native work (EIP-5792 + paymaster + ERC-4337-aware webhook) is genuinely grant-worthy. Condition: contract audit + multisig. |
| **Approve for open-source recognition?** | **Yes.** CI is green, tests exist, docs are solid. Decompose `page.tsx` to attract contributors. |
| **Approve after security review?** | **The app layer, yes** — with H-1 fixed. **The contract, yes for V2** after a professional audit. **V1 as currently deployed: no.** |

### Top 20 improvements (ranked by impact)

1. **Fix `/api/requery`** — require ownership proof, use `crypto.randomUUID()`, rate-limit. *(Exploitable today.)*
2. **Deploy `AbaPayV2`** — testnet → E2E → audit → mainnet.
3. **Professional smart-contract audit** before pooled mainnet funds.
4. **Safe multisig as contract owner.**
5. **Apply `001_rate_limits.sql`** — throttles currently fail open and do nothing without it.
6. **Integration tests for `/api/pay` and `/api/webhook`** — test the *shipped* verification function, not a local re-implementation.
7. **Extract a shared `verifyOnChainPayment()`** used by both routes.
8. **Extend rate limiting** to `variations`, `intl`, `foreign`, `requery`, `support`.
9. **Verify refunds on-chain** before marking `REFUNDED`.
10. **Decompose `page.tsx`** (2,686 → hooks + components).
11. **Write the V1→V2 migration runbook** (drain, redeploy, switch addresses, verify).
12. **`npm audit fix`** for `lodash` + `ws`; pin `@farcaster/miniapp-sdk`.
13. **Convert `vtpass.js` / `messaging.js` / `telegram.js` to TypeScript.**
14. **Add a CSP header.**
15. **RPC failover** (fallback transport instead of a single hardcoded URL).
16. **Consolidate `APP_MODE` + `NETWORK`** into one environment mode.
17. **Accessibility pass** (ARIA, focus, contrast — axe/Lighthouse).
18. **Standardise the API response envelope**; stop returning `error.message`.
19. **Structured logging + monitoring** (Sentry) instead of `console.*`.
20. **Publish the trust model** — what's custodial vs not, what the owner key can do. Users and reviewers both need this.

---

*Report ends. The trajectory here is genuinely strong — the remediation between audits closed the two biggest gaps and produced a properly hardened, tested contract. The most urgent item is not any of that work, though: it's the `/api/requery` endpoint, which is giving away purchased electricity tokens and exam PINs to anyone who asks with a guessable ID.*
