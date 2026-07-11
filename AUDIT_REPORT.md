# AbaPay — Comprehensive Codebase Audit

**Auditor role:** Principal Engineer / Security Researcher / Smart-Contract Auditor / Product Reviewer
**Scope:** Full repository (~8,300 LOC, 55 source files, 1 smart contract, 25 API routes)
**Stack:** Next.js 16 (App Router, React 19, Turbopack) · TypeScript · Solidity ^0.8.20 · Supabase (Postgres) · viem/wagmi · Celo + Base
**Purpose:** Non-custodial crypto→fiat utility bill payments (airtime, data, electricity, cable, bank, education, international) via VTpass, with a conversational DeAI agent layer.

> **Important honesty note on method:** This audit is a static read of the source. I was **not able to run a build, the test suite, or a live transaction** in this environment (no npm registry / RPC access). Findings are evidence-based from code, but anything marked *"verify at runtime"* should be confirmed on your side. A static audit cannot replace a paid smart-contract audit before the contract holds significant funds.

---

## Executive Summary

AbaPay is a genuinely impressive **solo-built, full-stack Web3 fintech** with real payment rails, multi-chain support, and a security posture well above typical hackathon/indie projects. The payment-verification logic in particular (on-chain receipt checks, payload-tamper detection, amount enforcement, replay protection via a DB uniqueness constraint) shows real security maturity that most projects at this stage lack.

However, it is **not yet production-grade by enterprise/ecosystem-grant standards**, for three structural reasons:

1. **The smart contract is unaudited, non-upgradeable, and minimal** — no pause, no reentrancy guard, single-owner custody of the vault.
2. **Zero automated tests and zero CI/CD** — for a system that moves money, this is the single biggest gap.
3. **No rate limiting** on public, cost-incurring endpoints (VTpass verify, OTP, AI).

None of these are unusual for where the project is — but they are exactly the things a Coinbase/Base grant reviewer or a security firm would flag first.

**Overall: B / 72–75 out of 100.** Strong and legitimately innovative; needs tests, a contract audit, and rate limiting before it's "production ready" in the formal sense.

---

## 1. Architecture Review — **7.5/10**

**Strengths**
- Clean Next.js App Router layout; API routes are logically grouped (`/api/pay`, `/api/webhook`, `/api/admin/*`, `/api/deai/*`).
- Good separation of concerns emerging: `utils/` (auth, db, pin, internal-auth), `lib/` (vtpass, telegram, messaging, cleanup), `constants/`.
- Recent refactors show healthy instincts — extracting `cleanupPreflights.ts` into a shared lib so both a route and the webhook reuse it is exactly right.

**Weaknesses**
- **Mixed `.js` and `.ts` in `lib/`** (`vtpass.js`, `telegram.js`, `messaging.js`, `admin/health/route.js`) — these dodge type-checking on critical paths (VTpass calls are money-adjacent and untyped). Convert to `.ts`.
- **`page.tsx` is ~2,700 lines** — a monolith holding the entire payment UI, wallet logic, state machine, and history. Hard to maintain/test. Should be decomposed into hooks (`usePayment`, `useWalletTx`) and sub-components.
- **Vend logic is inlined in `/api/pay`** rather than a reusable service — which is why the DeAI agent can't cleanly reuse it. A `services/vend.ts` abstraction would pay off.
- Duplicated on-chain verification logic between `/api/pay` and `/api/webhook` (both decode/verify) — should share a module.

**Dead/duplicate code:** minor — some duplicated token-decimals logic (`cUSD/USDm → 18 else 6`) appears in 3+ places; centralize it (you already started with `resolveTokenOnChain`).

---

## 2. Code Quality — per folder

| Folder | Rating | Notes |
|---|---|---|
| `contracts/` | 6/10 | Correct and readable, but minimal; comments are informal ("The Boss variable", "CEO function"). Fine for clarity, unprofessional for an audited contract. |
| `src/app/api/` | 7.5/10 | Generally solid, heavy inline logic, good recent security comments. `pay/route.ts` is doing far too much (verification + vending + email + SMS + points + telegram in one 300-line function). |
| `src/utils/` | 8.5/10 | Best code in the repo. `adminAuth`, `pinSecurity`, `internalAuth` are clean, well-commented, security-conscious. |
| `src/lib/` | 6/10 | Untyped `.js` files on money paths. Works, but no type safety. |
| `src/components/` | 7/10 | Reasonable, but `Modals.tsx` and `page.tsx` are large. |
| `src/constants/` | 7/10 | Central config is good; some very long inline arrays. |

**Cross-cutting:** naming is consistent and readable; comments are plentiful (sometimes *too* casual for a financial product). Complexity is concentrated in `pay/route.ts` and `page.tsx`.

---

## 3. Security Audit

The application-layer security is the strongest part of this project. Below are the real findings.

### CRITICAL

**C-1 — Smart contract is unaudited and holds pooled user funds with single-key custody.**
`withdrawFunds` sends the entire token vault to a single `owner` EOA. If that key is compromised, **all pooled funds across all users are drained instantly.** There's no timelock, no multisig, no cap.
- *Impact:* Total loss of vault.
- *Fix:* Move `owner` to a multisig (Safe). Add a timelock on `withdrawFunds`. Consider per-transaction sweep rather than pooling. **Get a professional contract audit before mainnet volume.**

**C-2 — No reentrancy guard on `payBill` / `refundUser` / `withdrawFunds`.**
Currently *low practical risk* because the whitelisted tokens (USDC/USDT/cUSD) are standard non-callback ERC-20s, and state changes are minimal. But if a token with transfer hooks (ERC-777-style) is ever whitelisted via `setTokenSupport`, `payBill` becomes reentrant.
- *Fix:* Add OpenZeppelin `ReentrancyGuard` + `nonReentrant` on all three functions. Follow checks-effects-interactions. It's cheap insurance.

### HIGH

**H-1 — No rate limiting anywhere.** Confirmed: no `upstash`/ratelimit/middleware. Public endpoints that cost you money or send messages are exposed to abuse:
- `/api/verify/*` and `/api/variations` → each hits VTpass (billable).
- `/api/verify/request` → sends WhatsApp OTP (billable, SMS-bomb vector; you added a 60s cooldown per phone, good, but no global IP cap).
- `/api/deai/intent` → burns Gemini quota (now internal-auth gated — good — but still no throttle).
- *Fix:* Add IP-based rate limiting (Upstash Ratelimit + Vercel Edge Middleware, or a Supabase counter). This is the highest-value quick win.

**H-2 — No smart-contract pause / kill switch.** If a vulnerability is found post-deploy, there is no way to halt `payBill`. Your DB has `kill_switches` (good, app-level), but the contract itself can't be stopped.
- *Fix:* Add `Pausable` to the contract.

**H-3 — `supabaseAdmin` service-role client falls back to a dummy key silently.** In `utils/supabase.ts`, if `SUPABASE_SERVICE_ROLE_KEY` is missing, it constructs with `'dummy-key-to-prevent-client-crash'`. This means a misconfigured deploy fails *silently at runtime* (every admin query fails) instead of loudly at boot — exactly the class of bug behind the "admin loads but no data" issue you hit.
- *Fix:* On the server, throw if the service key is absent, rather than papering over it.

### MEDIUM

**M-1 — Refund is a DB-only status flip.** `/api/admin/refund` marks a transaction `REFUNDED` with a `refund_hash` the admin pastes in, but doesn't verify that hash on-chain. A careless/malicious admin could mark refunds that never happened. Lower risk (admin-gated) but not verified.
- *Fix:* Verify the refund tx on-chain (recipient, token, amount) before flipping status — mirror the inbound verification you already do.

**M-2 — `NEXT_PUBLIC_APP_MODE` gates sandbox vs live VTpass, but rate/verification uses a different `NEXT_PUBLIC_NETWORK` check.** These two flags being independently set invites a misconfiguration where you're on mainnet chain but sandbox VTpass, or vice versa. Consolidate into one environment mode.

**M-3 — SSRF surface in `/api/paymaster`.** You correctly restricted it to an allowlist of RPC methods (good), and the upstream URL is server-controlled — so this is largely mitigated. Keep it that way; never let the upstream URL come from the request.

**M-4 — Error messages leak internals in a few places.** `verify/request` returns `error.message` directly to the client; `pay` returns generic messages (good). Standardize on generic client messages + server-side logging everywhere.

### LOW

- **L-1** `console.error`/`console.log` of transaction detail throughout — fine for Vercel logs, but ensure no secrets are logged. (Spot-check clean.)
- **L-2** OTP is 4 digits (10k space). With the 60s cooldown and 10-min expiry the brute-force window is small, but 6 digits is stronger. Verify `/api/verify/confirm` also rate-limits *attempts* (it uses `timingSafeEqual` — good — but confirm attempt-count lockout exists).
- **L-3** No CSRF tokens on form posts — acceptable for a wallet-signature / bearer-style API with no cookie auth, but worth a conscious note.
- **L-4** Dependencies include many `latest`-pinned packages (`@farcaster/miniapp-sdk: latest`) — non-deterministic builds. Pin versions.

### Things done RIGHT (credit where due)
- On-chain payload tamper detection (service, account, amount) in `/api/pay`.
- Replay protection via DB unique constraint on `tx_hash` (correct for serverless — in-memory would be unsafe).
- Webhook returns 2xx on benign no-match (prevents Alchemy auto-disable).
- PIN hashing (scrypt + salt + timing-safe), internal-service auth, admin signature auth with session expiry and timestamp replay protection.
- OTP timing-safe comparison and resend cooldown.
- Paymaster proxy method allowlist.

---

## 4. Smart Contract Audit — **6/10**

`AbaPay.sol` — 84 lines, single contract.

| Aspect | Assessment |
|---|---|
| Logic | Correct for its scope. `payBill` pulls via `transferFrom` (user must be signer — this is why the DeAI custody model is blocked). |
| Storage | Minimal, fine. |
| Events | Good — `PaymentReceived` carries all fields the webhook cross-checks. |
| Modifiers | Only `onlyOwner`. No `nonReentrant`, no `whenNotPaused`. |
| Ownership | Single EOA owner, no 2-step transfer, no renounce, no multisig. |
| Upgradeability | None (not proxied). A bug = redeploy + migrate. |
| Standards | Uses a raw `IERC20` interface, not OpenZeppelin's `SafeERC20`. Non-standard tokens that don't return `bool` would break `require(transfer(...))`. USDC/USDT/cUSD are fine, but `SafeERC20` is the correct pattern. |
| Access control | Adequate for current scope. |

**Top contract fixes:** OpenZeppelin `Ownable2Step` + `Pausable` + `ReentrancyGuard` + `SafeERC20`; multisig owner; professional audit before scaling.

---

## 5. Blockchain Best Practices — **68/100**

- **Celo/Base alignment:** Good — correct chains, correct stablecoins, MiniPay + Farcaster frame support, EIP-5792 sponsored transactions via paymaster (genuinely advanced). Builder-code attribution on Base txs is a nice ecosystem-native touch.
- **Gaps:** raw `IERC20` instead of `SafeERC20`; no contract-level pausing; pooled custody rather than non-custodial routing; hardcoded RPC URLs (`forno.celo.org`, `mainnet.base.org`) with no fallback provider (single point of failure if that RPC is down).
- **Improve:** add RPC failover, adopt OZ libraries, consider per-tx settlement to reduce custodial risk.

---

## 6. Performance — **7/10**

- **`page.tsx` (2,700 lines)** ships a large client bundle; heavy single-component re-renders likely. Decompose + memoize.
- **`html2canvas-pro`, `jspdf`** are dynamically imported (good — lazy).
- **Webhook has a hardcoded 15s `setTimeout`** — pragmatic but crude; it serializes latency. Acceptable given the design, but a queue would be cleaner at scale.
- **RPC calls:** each verification spins a fresh `createPublicClient`; fine at current volume, would benefit from connection reuse and a fallback transport.
- No obvious memory leaks in the API layer (stateless). The module-scoped throttle in `cleanupPreflights` is fine.

---

## 7. User Experience — UI **8/10** · UX **7.5/10** · Accessibility **5/10**

- **UI:** Polished, modern, dark-mode, thoughtful receipt design and email templates. Strong for a solo build.
- **UX:** Good transaction flow, status handling, recent responsive header fix. The multi-step wallet→approve→pay flow is inherently heavy but handled with clear status messages.
- **Accessibility:** Weakest UX area — heavy reliance on color, emoji, and `font-black` uppercase; limited evidence of ARIA labels, focus management, or screen-reader consideration. For a consumer fintech targeting broad markets, this matters. Audit with axe/Lighthouse.

---

## 8. Developer Experience — **5/10**

- **Setup:** README is now strong (env vars documented, structure mapped) — a real asset.
- **Blocking gaps:** no tests, no CI, no `.env.example` file, mixed JS/TS, one giant component. A new contributor could *run* it from the README but couldn't safely *change* the payment path without fear, because nothing would catch a regression.
- `AGENTS.md` / `CLAUDE.md` present (good for AI-assisted dev).

---

## 9. API Review — **7/10**

- **Validation:** Improving — OTP/support now validate input; DeAI validates payload. But many routes still trust body shape.
- **AuthN/AuthZ:** Strong where it counts — admin (signature), internal (token), webhooks (HMAC), paymaster (allowlist).
- **Rate limiting:** **Absent** (see H-1).
- **Versioning:** None (`/api/v1/…`) — fine for now, worth adopting before third parties integrate.
- **Consistency:** Response shapes vary (`{success,status,message}` vs `{error}`). Standardize an envelope.
- **Error responses:** Mostly generic to the client (good), some leak `error.message` (M-4).

---

## 10. Testing — **0/10**

**No unit, integration, or E2E tests. No coverage tooling.** For a money-moving system this is the most serious non-security gap. Priority test targets, in order:
1. `/api/pay` verification branches (tamper, underpayment, smart-wallet path, replay).
2. `/api/webhook` cross-validation (the sender/token/amount/account checks).
3. `pinSecurity`, `adminAuth`, `internalAuth` (pure, easy, high-value).
4. Contract tests (Hardhat) — `payBill`, `withdrawFunds`, `refundUser`, access control, and the reentrancy/pause behaviors once added.

---

## 11. Dependency Audit — **6/10**

- **`latest`-pinned packages** (`@farcaster/miniapp-sdk`) → non-reproducible builds. Pin them.
- **Many deprecated transitive deps** (from WalletConnect/MetaMask/Safe SDKs) — noisy but not directly exploitable; keep an eye via `npm audit`.
- `html2canvas` → correctly replaced with `html2canvas-pro` for Tailwind v4 oklch support.
- No lockfile-integrity CI step. Add `npm audit --production` to CI once CI exists.
- Recommend: add `@upstash/ratelimit`, OpenZeppelin contracts, and a test runner (Vitest + Hardhat).

---

## 12. Production Readiness — **Not yet (blocking list)**

1. **Professional smart-contract audit** (blocking for real volume).
2. **Automated tests + CI/CD** (blocking for safe iteration).
3. **Rate limiting** on public/billable endpoints (blocking for cost control & abuse).
4. **Contract hardening:** multisig owner, Pausable, ReentrancyGuard, SafeERC20.
5. **Remove silent service-key fallback** (fail loud on misconfig).
6. **On-chain refund verification.**
7. **Consolidate env-mode flags** to prevent sandbox/mainnet mismatch.
8. Convert money-path `.js` → `.ts`.

---

## 13. Public Review (as different reviewers)

- **GitHub open-source maintainer:** "Impressive scope and recent security discipline. Blocked on: no tests, no CI, one 2,700-line file. Would request those before merging community contributions."
- **Coinbase / Base ecosystem reviewer:** "Strong Base-native integration (paymaster, EIP-5792, builder codes). The unaudited pooled-custody contract is the blocker for any grant or featured placement. Fund a contract audit and add a multisig."
- **Security firm:** "App-layer verification is notably good for an indie build. Contract needs hardening + audit. Add rate limiting. Then we'd sign off on a review pass."
- **VC technical reviewer:** "Rare solo execution across chain + fiat rails + agent layer. De-risk the smart contract and prove reliability with tests before we'd back scaling. The non-custodial positioning is a strength — don't compromise it with the custodial DeAI shortcut."

---

## 14. Scoring

| Dimension | Score |
|---|---|
| Architecture | 7.5/10 |
| Code Quality | 7/10 |
| Security | 7/10 |
| Performance | 7/10 |
| Testing | 0/10 |
| Documentation | 7.5/10 |
| Developer Experience | 5/10 |
| UI | 8/10 |
| UX | 7.5/10 |
| Blockchain Best Practices | 6.8/10 |
| Maintainability | 6.5/10 |
| Scalability | 6.5/10 |
| Innovation | 9/10 |
| Production Readiness | 5/10 |

**Overall Grade: B** · **Overall Score: ~73/100**

(Innovation and app-layer security pull it up; the zero on testing and the unaudited contract pull it down. Close the testing + contract gaps and this becomes a solid A-/85+.)

---

## 15. Final Verdict

- **Approve for production today?** Not yet — after tests, rate limiting, and contract hardening/audit: yes.
- **Approve for an ecosystem grant?** Promising and fundable on merit/innovation, **conditional on a smart-contract audit** and a multisig owner. The Base-native work is genuinely grant-worthy.
- **Approve for open-source recognition?** Yes on ambition/execution; add tests + CI to be taken seriously by contributors.
- **Approve after security review?** The *application* layer would likely pass a review with minor fixes. The *contract* would not pass without hardening.

### Top 20 improvements (highest impact first)

1. **Get a professional smart-contract audit** before scaling volume.
2. **Add automated tests** — start with `/api/pay` and `/api/webhook` verification branches.
3. **Add CI/CD** (GitHub Actions: typecheck + lint + test + `npm audit` on every push).
4. **Add rate limiting** (Upstash + Edge Middleware) to verify/OTP/AI/variations.
5. **Move contract ownership to a multisig (Safe)** + add a `withdrawFunds` timelock.
6. **Add `Pausable` + `ReentrancyGuard` + `SafeERC20` + `Ownable2Step`** to the contract.
7. **Remove the silent `dummy-key` Supabase fallback** — fail loudly on missing service key.
8. **Verify refunds on-chain** before flipping DB status.
9. **Decompose `page.tsx`** into hooks + components.
10. **Extract a shared `vend`/`verifyOnChain` service** reused by `/api/pay`, `/api/webhook`, and eventually DeAI.
11. **Convert `lib/*.js` money-path files to TypeScript.**
12. **Pin all dependency versions** (no `latest`); commit lockfile; add `npm audit` to CI.
13. **Consolidate `NEXT_PUBLIC_APP_MODE` + `NEXT_PUBLIC_NETWORK`** into one environment mode to prevent mismatch.
14. **Add RPC failover** (fallback transport) instead of single hardcoded RPC URLs.
15. **Standardize the API response envelope** and stop leaking `error.message` to clients.
16. **Accessibility pass** (ARIA, focus, contrast; run axe/Lighthouse).
17. **Add a `.env.example`** and a one-command bootstrap.
18. **Add attempt-count lockout on OTP confirm** (and consider 6-digit codes).
19. **Add structured logging + monitoring** (Sentry) rather than `console.*`.
20. **Document the trust model** (what's custodial vs not, what the admin key can do) for users and reviewers.

---

*End of report. Because this was a static review without a build/test run, treat the contract and money-path findings as the priority items to confirm and remediate with a runtime + professional audit before production scale.*
