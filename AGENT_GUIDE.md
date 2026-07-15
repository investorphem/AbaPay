# AbaPay DeAI Agent — Operator & Developer Guide

> **Read this before enabling agent payments.** The agent can spend real user funds. This
> document explains exactly what it can and cannot do, and why.

---

## 1. What the agent is

A conversational bill-payment agent, available in the **web app** and on **Telegram, WhatsApp
and X**. It understands natural language ("every Tuesday buy ₦200 airtime for 08012345678"),
verifies details against real VTpass data, and either **pays** or **hands the user a link to
sign** — depending on what they've authorised.

All four surfaces share one brain (`/api/deai/core`), one intent engine, and one set of rules.
They cannot drift apart.

---

## 2. The security model (the important part)

### AbaPay never holds user keys or user funds.

There are **three** ways a payment can happen, with very different trust properties:

| Path | Who signs | Agent's power |
|---|---|---|
| **Web app** | The user, in their browser | None — it only pre-fills the form |
| **Chat, no allowance** | The user, via a deep link | None — it only proposes |
| **Chat/schedule, with allowance** | The **relayer**, bounded by an **on-chain cap** | Bounded, provable |

### How the bounded path works

The user, **from their own wallet**, does two things once:

1. `approve(AbaPayV3, X)` — standard ERC-20 approval
2. `setSpendingAllowance(token, X)` — **the cap the agent is bound by**

After that, the relayer may call `payBillFor(user, …)`. **The contract itself** checks and
decrements the remaining allowance on every call.

### What this means concretely

- **The cap is enforced by the blockchain, not by our backend.** If our server were fully
  compromised — database, PIN checks, the LLM, the relayer key — the contract *still* refuses
  to spend more than the user signed for.
- **Only the user can raise their own allowance.** There is deliberately no owner or relayer
  function to grant it.
- **Revocation is instant and unilateral:** `setSpendingAllowance(token, 0)`.
- **The relayer is a hot key.** If stolen, the attacker can spend at most each user's remaining
  allowance, only via `payBillFor`. They cannot drain a wallet, raise an allowance, or touch
  the vault. Kill it with `setRelayer(address(0))`.

This is proven by test, not asserted:
`test/AbaPayV3.test.ts` → *"a stolen relayer key CANNOT drain a user's wallet beyond their
allowance"* — mints 1000 tokens, sets a $10 cap, lets an attacker take everything they can,
and asserts the loss is **exactly $10**.

### The deliberate asymmetry

**Money entering the vault** (`payBillFor`) is capped on-chain → safe to automate.
**Money leaving the vault** (`refundUser`, `withdrawFunds`) is `onlyOwner` → **a human signs.**

Giving the relayer refund power would turn a bounded key into one that can drain the treasury
to any address. That line is not negotiable.

---

## 3. Layers of defence

| Layer | Enforced by | Can be bypassed by a compromised backend? |
|---|---|---|
| Spending allowance | **Smart contract** | ❌ No |
| Per-tx ceiling (`maxAgentPaymentPerTx`) | **Smart contract** | ❌ No |
| Relayer authorisation | **Smart contract** | ❌ No |
| Pause | **Smart contract** | ❌ No |
| Operator kill switches | Database | ✅ Yes |
| Per-tx / daily NGN caps | Database | ✅ Yes |
| Service kill switches | Database | ✅ Yes |
| PIN | Database (scrypt) | ✅ Yes |

**The top four are the real protection.** The rest are operational convenience — valuable, but
they are not what you rely on when things go wrong.

---

## 4. Setup

### Environment

```
ANTHROPIC_API_KEY=sk-ant-...              # Claude powers the intent engine
DEAI_INTERNAL_SECRET=<long random>        # Signs internal calls + payment deep links
RELAYER_PRIVATE_KEY=0x...                 # ⚠️ HOT KEY — gas only, never token balances
NEXT_PUBLIC_APP_URL=https://abapays.com
CRON_SECRET=<long random>                 # Protects /api/schedules/run
```

### Database migrations (`supabase/migrations/`)

Run all of them. Several features **fail silently** without their table:

| Migration | Without it |
|---|---|
| `001_rate_limits` | Rate limiting fails **open** — does nothing |
| `002_customer_details` | Transaction inserts **fail entirely** |
| `003_scheduled_bills` | No automations |
| `agent_links` | Nobody can link a channel |
| `refund_queue` | Failed vends are never refunded |
| `support_tickets` | No support from chat |

### Contract deployment

```bash
npx hardhat compile
npm run test:contracts        # V2 (21 tests) + V3 (13 tests)
npx hardhat run scripts/deployV2.ts --network celo-sepolia
```

Then, **from the owner wallet**:
- `setTokenSupport(token, true)` for each stablecoin
- `setMaxRefund(token, cap)` — **refunds revert until this is set**
- `setMaxAgentPayment(token, cap)` — **agent payments revert until this is set**
- `setRelayer(<relayer address>)` — enables agent payments

⚠️ **Set `ABAPAY_OWNER` to a multisig (Safe).** With a single EOA, the 24h withdrawal timelock
only buys detection time — an attacker with the key simply waits it out.

---

## 5. What the agent can and cannot do

| | Chat | Why |
|---|---|---|
| Airtime, Data, Electricity, Cable | ✅ Executes | |
| International (live VTpass countries) | ✅ Guided | |
| Automations (daily/weekly/monthly) | ✅ Executes | |
| Balance, History (incl. **tokens/PINs**) | ✅ | |
| Support tickets | ✅ | |
| **Bank transfer** | ❌ App only | Sends funds to a **third party** — a compromised agent could redirect them. Airtime/electricity are bounded (worst case: someone else's meter is credited). Bank transfer is not. |
| **Education PINs** | ❌ App only | Needs profile codes/exam years that are error-prone in chat. |

---

## 6. Rules the agent enforces (parity with the web form)

Extracted from the frontend's `isFormValid` into `src/lib/parity.ts`. **Change it there, not in
two places.**

- **Phone required** — electricity, cable, bank, education (the token is delivered by SMS)
- **Valid email required** — all international payments
- **Nigerian numbers** — 11 digits, starting `0`
- **Minimums** — airtime ₦50, electricity ₦500, cable ₦100; plus any VTpass-returned minimum
- **Duplicate electricity guard** — blocks the same meter + amount twice in one day
- **Currency conversion shown** before the PIN
- **Kill switches** — a disabled service stops the agent too, and it tells the user why

---

## 7. Operational runbook

### Something is wrong — how do I stop it?

| Situation | Action | Effect |
|---|---|---|
| A service is broken (VTpass outage) | Admin → System → kill switch | Agent refuses it and tells users why |
| Agent behaving badly | Admin → Agent → **Agent payments: OFF** | All agent spending stops (~30s) |
| Only schedules are the problem | Admin → Agent → **Autonomous: OFF** | Unattended payments stop; chat still works |
| **Relayer key leaked** | `setRelayer(address(0))` **on-chain** | Agent spending dies instantly, permanently |
| Vulnerability found | `pause()` **on-chain** | All payments halt; refunds still work |

The last two are the ones that matter — they don't depend on our backend being honest.

### A payment failed. What happens?

1. VTpass rejects → refund **auto-queued**
2. Operator alerted: `💸 REFUND QUEUED · Source: 🤖 Autonomous Schedule`
3. User told **immediately, on their channel**
4. Admin → Ops → Refunds → one click → **your wallet signs** `refundUser()`
5. Backend **verifies the refund on-chain** before recording it
6. User confirmed

**Refunds are only queued when funds were actually received on-chain.** Refunding a reverted
transaction would pay someone out of the treasury for nothing.

---

## 8. Chains & tokens

| Chain | Tokens |
|---|---|
| **Celo** | USD₮, USDC, USDm (cUSD) |
| **Base** | USD₮, USDC |

The agent asks the user to pick a chain, then offers **only the tokens that exist on it**,
with their real on-chain balances. Sourced from `SUPPORTED_TOKENS` — the same constant the web
app uses, so they cannot disagree.

> Note the real symbols are **`USD₮`** and **`USDm`** (not "USDT"/"cUSD"). Using the wrong
> string breaks token resolution at the relayer.

---

## 9. Known limitations — be honest about these

1. **AbaPayV3 is not audited.** It moves user funds via a hot key. Use **testnet**, or mainnet
   with **small caps**, until audited.
2. **The relayer is a single hot key.** Bounded, but not zero-risk. Fund with gas only.
3. **Bank transfer and Education are app-only** — deliberate, see §5.
4. **The LLM can misparse.** This is why every payment passes through the feasibility engine,
   the parity contract, and the on-chain cap. The model proposes; the contract disposes.
