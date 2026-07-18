# ⚡ AbaPay Protocol

AbaPay is a decentralized, Web3-native utility payment platform built on **Celo** and **Base**. It lets users pay for real-world bills — Airtime, Mobile Data, Electricity, Cable TV, Bank Transfers, Education PINs, and International Airtime/Data — using on-chain stablecoins (**USDT**, **USDC**, **cUSD/USDm**), with instant fiat settlement handled server-side via the VTpass API. Payments can be made directly in the web app, or hands-free through a conversational AI agent ("DeAI") on Telegram, WhatsApp, and X, spending from a bounded, user-revocable on-chain allowance — no custody, no server-side keys.

Designed for low fees, cross-border utility vending (Nigeria + supported international countries), and mobile-first accessibility (optimized for Celo MiniPay, Farcaster Mini Apps, and any WalletConnect/MetaMask-compatible wallet).

**Operator:** Masonode Technologies Limited (RC 9524980), Nigeria.

---

## 🌟 Key Features

* **Multi-Chain Payments:** Pay bills directly with USDT, USDC, or cUSD on Celo (Mainnet/Alfajores) or Base (Mainnet/Sepolia). The app auto-detects the connected chain and filters/reorders available stablecoins accordingly (e.g. cUSD is Celo-exclusive; USDT defaults first on Celo).
* **International Bill Pay:** Users can select a country and pay for foreign airtime/data in that country's own currency and rate — transaction history and receipts reflect the *local* currency, not just Naira.
* **Instant Vending:** Automated API integration with VTpass for instant token generation, airtime top-ups, and data bundle delivery.
* **Smart Merchant Verification:** Validates electricity meters, smartcard/IUC numbers, and account details *before* accepting crypto payments, eliminating user errors and failed vends.
* **AbaPoints Loyalty System:** Users earn points pegged 1:1 to stablecoin value spent, trackable via the in-app points badge and a dedicated API endpoint.
* **Automatic Refund Safety Net:** Failed vends after confirmed on-chain payment are automatically flagged, verified, and refunded on-chain to the user's wallet.
* **DND-Fallback SMS:** Automated SMS delivery of electricity tokens/PINs, bypassing the Nigerian Do-Not-Disturb (DND) registry for critical transaction alerts.
* **Multi-Channel Support & Notifications:** Built-in support ticketing, plus webhook integrations for Telegram, WhatsApp, and X (Twitter) so users and admins can transact/get notified from their preferred channel.
* **Conversational AI Agent ("DeAI"):** A natural-language assistant (`/api/deai`) that lets users check balances and pay bills via chat-style commands, backed by Claude (Anthropic). Reachable via Telegram, WhatsApp, X, and an in-app chat widget (`src/components/AIChat.tsx`) on the storefront itself. Understands intent, not just menu numbers — replying "Celo" or "usdt" works exactly like replying "1" or "2" — and shows the live balance and approved agent limit for every token at the moment you're asked to pick one, so you're never choosing blind. If a session goes cold (network drop, abandoned mid-flow) it's recognised and cleaned up automatically rather than left dangling; and if a network hiccup happens right after you enter your PIN, the payment is never silently lost or double-spent — it's tracked through to a confirmed on-chain outcome before the agent reports back.
* **Agent-Initiated Payments (AbaPayV3):** Users can grant the DeAI agent a bounded, on-chain, revocable spending allowance (`setSpendingAllowance`) — chosen independently per chain and per stablecoin from the Agent Hub tab — so it can pay bills on their behalf from Telegram/WhatsApp/X with no wallet signature needed at payment time and no custody of user funds. If no allowance is approved for the chain/token a chat payment needs, the agent detects that up front and offers a straight choice: approve it now, or complete this one payment via a signed deep link instead. See [AbaPayV3 — agent allowances](#abapayv3sol--agent-initiated-payments-️-not-audited) below.
* **On-Chain Attribution:** Celo transactions carry an ERC-8021 attribution tag (`src/lib/attribution.ts`) crediting the Celo Builders program; a no-op on Base.
* **On-Chain Agent Identity (ERC-8004):** AbaPay's DeAI agent is registered as a real on-chain identity on Celo via the ERC-8004 "Trustless Agents" registry, so it's discoverable on 8004scan.io / AgentScan — independent of, and unrelated to, how it moves money. See [ERC-8004 agent identity](#erc-8004-agent-identity) below.
* **x402 Settlement (main app, Celo + USDC/USDT):** Payments made directly in the web app — where the user is present and signing — settle automatically via the [x402](https://x402.org) HTTP-payment protocol against Celo's own facilitator whenever the user pays with **USDC or USD₮ on Celo** (no user-facing toggle), so they're genuinely indexed on x402scan, not just relabeled contract calls. Everything else (Base, cUSD/USDm) uses the original on-chain `payBill` flow, including Base's sponsored-gas path, unchanged — and the signature-free agent-initiated flow above is completely untouched, since x402 requires a fresh signature per payment, incompatible with unattended agent payments. See [x402 settlement](#x402-settlement-main-app-only) below.
* **Dynamic Exchange Engine:** Live market rate conversions with admin-configurable exchange rate and automated profit spread calculation, verified server-side to prevent underpayment exploits.
* **Executive Admin Dashboard:** Real-time monitoring of VTpass fiat balance, on-chain vault balances per token/chain, transaction analytics, manual refund tools, and CSV export — protected behind admin auth.
* **Sponsored Gas on Base:** Coinbase Smart Wallet / Base Account users can pay with zero gas fees — the app detects paymaster support via EIP-5792 and batches approval + payment into a single sponsored transaction. Wallets without this capability (MetaMask, WalletConnect, Valora, etc.) transparently fall back to the normal self-paid flow.
* **Shareable & Downloadable Receipts:** Every receipt can be shared as an image straight to WhatsApp/Telegram/etc. via the device's native share sheet, or saved directly as a PNG or PDF.
* **Farcaster Mini App Ready:** Ships with Farcaster frame metadata so AbaPay can be launched directly inside Farcaster clients.

---

## 🛠️ Tech Stack

* **Frontend:** Next.js 16 (App Router, React 19), Tailwind CSS 4, Lucide Icons, next-themes (dark mode)
* **Web3 / Wallets:** Wagmi, Viem (incl. EIP-5792 `sendCalls` for sponsored transactions), WalletConnect Modal, Base Account SDK, Solidity smart contract (Hardhat)
* **Backend:** Next.js Route Handlers (serverless functions)
* **Receipts:** html2canvas (image capture), jsPDF (PDF export)
* **AI:** Claude (Anthropic API) for the DeAI conversational agent and in-app chat widget
* **Agent Identity & Payments:** ERC-8004 (on-chain agent identity, Celo) and x402 (`thirdweb` SDK) for HTTP-native, facilitator-settled payments in the main app
* **Utility Provider:** VTpass API (bills, airtime, data, education, international airtime)
* **Database / Ledger:** Supabase (PostgreSQL) — transactions, platform settings, points, refunds
* **Email:** Resend (transactional receipt emails)
* **Notifications & Bots:** Telegram Bot API, WhatsApp Cloud API, X (Twitter) API, VTpass Messaging API (SMS)

---

## 📁 Project Structure

```
src/
├── app/
│   ├── page.tsx              # Main storefront (pay flow, wallet connect, history)
│   ├── admin/page.tsx         # Admin ops dashboard
│   ├── docs/page.tsx          # Docs & FAQ
│   ├── terms/, privacy/       # Legal pages
│   └── api/
│       ├── pay/                # Core payment + vending endpoint
│       ├── paymaster/           # Server-side proxy for Base gas-sponsorship (keeps the CDP paymaster key off the client)
│       ├── requery/             # Delayed/timeout transaction requery
│       ├── rate/, admin/rate/   # Exchange rate endpoints
│       ├── variations/          # VTpass service variation lookups
│       ├── intl/, foreign/      # International bill pay (products/operators/rates)
│       ├── verify/              # Meter/account/customer verification
│       ├── admin/                # Admin data, actions, refunds, health
│       ├── user/points/          # AbaPoints balance
│       ├── deai/                 # Conversational AI agent
│       ├── webhook/, webhook/vtpass/  # VTpass + on-chain webhooks
│       ├── telegram/webhook/, whatsapp/webhook/, x/webhook/  # Bot channel webhooks
│       └── support/              # Support ticket submission
├── components/                 # Shared UI (AppFooter, Modals, tabs, AIChat, AdminAgentPanel, etc.)
├── config/wagmi.ts             # Wallet/chain configuration
├── constants/                  # Supported tokens, services, providers
├── lib/
│   ├── attribution.ts           # Celo Builders on-chain attribution tag (ERC-8021 dataSuffix)
│   ├── deai/                    # Intent parsing, capability rules, agent relayer (payBillFor)
│   └── ...                      # VTpass, Telegram, WhatsApp, messaging helpers
└── utils/                      # Supabase client, admin auth
contracts/
├── AbaPay.sol                   # V1 — original escrow/vault smart contract
├── AbaPayV2.sol                 # V2 — hardened (see below)
└── AbaPayV3.sol                 # V3 — adds agent-initiated payments (⚠️ NOT AUDITED)
scripts/
├── deploy.ts                     # Deploy V1
├── deployV2.ts                   # Deploy V2
└── deployV3.ts                   # Deploy V3 (whitelists tokens, sets relayer + per-tx caps)
```

---

## ⚙️ Environment Variables

Create a `.env.local` file in the project root. **Never commit this file to GitHub.**

### App / Network Config
```
NEXT_PUBLIC_APP_MODE=sandbox                     # sandbox | production
NEXT_PUBLIC_NETWORK=celo-sepolia                 # celo-sepolia | celo | base | base-sepolia
NEXT_PUBLIC_FIXED_RATE=1550.00                    # Fallback NGN exchange rate
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=your_walletconnect_project_id
```

### Smart Contracts (per chain)
```
NEXT_PUBLIC_ABAPAY_ADDRESS=0xYourDefaultContractAddress
NEXT_PUBLIC_ABAPAY_CELO_ADDRESS=0xYourCeloContractAddress
NEXT_PUBLIC_ABAPAY_BASE_ADDRESS=0xYourBaseContractAddress
ADMIN_WALLET_ADDRESS=0xYourAdminWalletAddress
CELO_PRIVATE_KEY=your_deployer_private_key         # Used only by Hardhat for deployment — never expose client-side
```

### Paymaster (Base Gas Sponsorship)
```
PAYMASTER_URL=https://api.developer.coinbase.com/rpc/v1/base/your_cdp_api_key   # Server-only — never NEXT_PUBLIC. The app proxies wallet paymaster requests through /api/paymaster so this key never reaches the browser.
```
⚠️ Two things this env var alone won't cover, both configured in external dashboards:
- **Coinbase Developer Platform:** create a Paymaster Policy allowlisting your `NEXT_PUBLIC_ABAPAY_BASE_ADDRESS` contract (and ideally the specific `payBill`/`approve` selectors), with a funded/budgeted balance to sponsor from.
- **Alchemy webhook config:** make sure the **"Token"** activity category is enabled on your Base webhook (not just "External"). Under gas sponsorship, the top-level transaction's `to` is the bundler/EntryPoint contract, not your AbaPay contract directly — only Token-category (ERC-20 Transfer log) monitoring reliably fires regardless of call depth.

### VTpass (Bill Payment Provider)
```
VTPASS_API_KEY=your_api_key
VTPASS_PUBLIC_KEY=PK_your_public_key
VTPASS_SECRET_KEY=SK_your_secret_key
VTPASS_MSG_TOKEN=VT_PK_your_token
VTPASS_MSG_SECRET=VT_SK_your_secret
```

### Supabase (Database)
```
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key    # Server-side only — full DB access
```

### Email (Resend)
```
RESEND_API_KEY=re_your_resend_key
```

### AI Agent (DeAI)
```
ANTHROPIC_API_KEY=sk-ant-...                  # Claude powers the DeAI intent engine (replaced Gemini).
DEAI_INTERNAL_SECRET=any_long_random_string   # Optional. Signs internal calls to the DeAI brain so /api/deai/* can't be hit directly from the internet, AND signs the agent's payment deep links. Falls back to SUPABASE_SERVICE_ROLE_KEY if unset.
```

**How DeAI actually pays (non-custodial):** there is no server-side key for the user (there
must never be one; that would make AbaPay a custodian), so the agent does everything *except*
hold keys. Two paths exist:

1. **Deep link (V1/V2 contracts, or a user without an allowance):** the agent parses the
   request with Claude, verifies the meter/account against real VTpass, confirms details in
   chat, then returns a **signed, 15-minute deep link** that opens the app pre-filled. The user
   taps, their own wallet signs, and the payment runs through the same verified pipeline as the
   web app.
2. **Delegated allowance (AbaPayV3, `src/lib/deai/relayer.ts`):** if the user has granted an
   on-chain `spendingAllowance` (see [AbaPayV3](#abapayv3sol--agent-initiated-payments-️-not-audited)
   below), the relayer calls `payBillFor()` directly — no deep link, no signature at payment
   time — bounded entirely by the allowance the user set and revocable by them at any moment.
   Before broadcasting, a `preflight_<wallet>_<timestamp>` transaction row is written (the same
   pattern the web app uses ahead of a signature), then renamed to the real tx hash once
   confirmed — so the payment is vended through the exact same verified pipeline as every other
   rail, and a stale/abandoned attempt is swept automatically rather than left dangling. If the
   RPC can't confirm the receipt in time (a network hiccup right after broadcast — including
   right after the user enters their PIN), the agent reports it as *pending*, not failed, and
   will never hand out a duplicate payment link for that same intent — avoiding both a lost
   payment and a double-charge. If no allowance is approved for the chain/token a payment needs,
   the agent detects that before ever attempting the relay and offers a choice: approve it now
   in the Agent Hub, or complete just this one payment via a signed deep link.

### Telegram
```
TELEGRAM_BOT_TOKEN=your_admin_bot_token
TELEGRAM_ADMIN_CHAT_ID=your_admin_chat_id
TELEGRAM_CHAT_ID=your_default_chat_id
TELEGRAM_WEBHOOK_SECRET=your_webhook_secret
SUPPORT_TELEGRAM_BOT_TOKEN=your_support_bot_token
DEAI_TELEGRAM_BOT_TOKEN=your_deai_bot_token
```

### WhatsApp Cloud API
```
WHATSAPP_ACCESS_TOKEN=your_whatsapp_access_token
WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id
WHATSAPP_VERIFY_TOKEN=your_verify_token
WHATSAPP_APP_SECRET=your_meta_app_secret   # Optional but strongly recommended: verifies the X-Hub-Signature-256 on inbound webhooks so senders can't be spoofed.
```

### X (Twitter)
```
X_BEARER_TOKEN=your_bearer_token
X_CONSUMER_SECRET=your_consumer_secret
X_BOT_ACCOUNT_ID=your_bot_account_id
```

### On-Chain Webhooks (Alchemy)
```
ALCHEMY_WEBHOOK_SECRET=your_alchemy_base_webhook_secret
ALCHEMY_CELO_WEBHOOK_SECRET=your_alchemy_celo_webhook_secret
```

### Contract Verification
```
ETHERSCAN_API_KEY=your_etherscan_or_celoscan_api_key
```

### Agent Relayer (AbaPayV3 — autonomous bill payments)
```
RELAYER_PRIVATE_KEY=0x...        # ⚠️ HOT KEY. Only needed if you deploy AbaPayV3 and enable agent payments.
NEXT_PUBLIC_APP_URL=https://abapays.com   # Used to build agent payment deep links.
```
⚠️ **Understand the blast radius before enabling this.** The relayer key can spend **at most each user's remaining on-chain allowance**, and only via `payBillFor`. It **cannot** drain a user's wallet, raise anyone's allowance, or withdraw the vault — those bounds are enforced by the *contract*, not the backend. If the key leaks, the owner calls `setRelayer(address(0))` and it is instantly dead. Fund it with gas only; it should never hold token balances.

### Agent Identity (ERC-8004) — one-time registration only
```
ERC8004_AGENT_URI=https://abapays.com/.well-known/agent.json   # Used only by scripts/register8004.ts
ERC8004_REGISTRY_CELO_MAINNET=0x8004A169FB4a3325136EB29fA0ceB6D2e539a432   # Optional override
ERC8004_REGISTRY_CELO_SEPOLIA=0x8004A818BFB912233c491871b3d84c89A494BD9e  # Optional override
NEXT_PUBLIC_ERC8004_AGENT_ID=                                  # Optional. Set after registering, for UI display.
```
Uses the same `CELO_PRIVATE_KEY` Hardhat already has configured — this is identity registration only, it never touches payments.

**How to register:**
1. Deploy `public/.well-known/agent.json` (edit its `wallet.address` to your real `RELAYER_ADDRESS` first) so it's reachable at `https://<your-domain>/.well-known/agent.json`.
2. Set `ERC8004_AGENT_URI` above to that URL.
3. `npx hardhat run scripts/register8004.ts --network sepolia` first — confirm the tx on [Celo Sepolia Celoscan](https://sepolia.celoscan.io) and check the `Registered` event for the correct URI and agent ID.
4. Only after that passes: `npx hardhat run scripts/register8004.ts --network celo` — spends real gas, mints the identity permanently.
5. Set `NEXT_PUBLIC_ERC8004_AGENT_ID` to the agent ID the script prints. Look it up at [8004scan.io](https://8004scan.io).

### x402 Settlement (main app, Celo + USDC)
```
CELO_X402_API_KEY=your_x402_celo_org_api_key   # Server-side: settles via api.x402.celo.org
NEXT_PUBLIC_THIRDWEB_CLIENT_ID=your_thirdweb_client_id    # Client-side only: useFetchWithPayment's signing infra
```
Distinct infra from `RELAYER_PRIVATE_KEY` above. This is not optional/toggleable in the UI — the main app's "Confirm & Pay" button automatically routes through x402 whenever the user pays with USDC on Celo (the only asset/chain combination supported today — see below), and through the normal contract call for everything else. It never touches the agent-initiated flow.

Settlement runs through **Celo's own x402 facilitator** (`api.x402.celo.org` mainnet /
`api.x402.sepolia.celo.org` testnet — built by Celo Core Co.), not thirdweb. thirdweb is
still used client-side only, for `useFetchWithPayment`'s wallet-signing plumbing (protocol-
generic — it reads the payment challenge from the response body, which works against any
compliant facilitator, not just thirdweb's own). Chosen over thirdweb's own facilitator
because: flat **$0.001/settlement** via prepaid credits vs. thirdweb's ~0.3% cut, **no
billing plan required** to settle on mainnet (thirdweb requires one or every mainnet
settlement fails with `DELEGATION_CHECK_FAILED`), and genuinely non-custodial — the signed
payment authorization pays the vault directly, with no intermediate hop through the
facilitator's own wallet.

**How to get the API key:**
1. Go to [x402.celo.org](https://x402.celo.org) → **Connect wallet** (any wallet works — this is just to sign a free, gasless message, not a transaction).
2. You're issued an API key instantly, plus free credits (500 mainnet, 1000 testnet at time of writing) — **the full key is shown only once**, copy it immediately.
3. Set `CELO_X402_API_KEY` to that key — the same key works for both the mainnet and testnet endpoints, which are tracked as separate credit pools.
4. Top up credits (USDC deposit, $1 ≈ 1,000 credits) from the same dashboard before you run out — `/settle` starts returning 402 at 0 credits, and the app sends a Telegram alert when that happens (see `src/app/api/pay/x402/route.ts`).
5. `NEXT_PUBLIC_THIRDWEB_CLIENT_ID` still needs a thirdweb project for the client-side pieces — sign up at [thirdweb.com](https://thirdweb.com) → **Add New → Create Project**, set **Allowed Domains**, and copy the **Client ID** (no secret key or server wallet needed anymore, since thirdweb no longer does the settling).
6. Add both vars to `.env.local` **and** your hosting provider's production environment variables, then redeploy — `NEXT_PUBLIC_*` vars are baked in at build time, so existing deployments won't pick up a change without a rebuild.

### Cron / Maintenance
```
CRON_SECRET=any_long_random_string   # Optional. Protects /api/cleanup and both /api/schedules/run* endpoints.
```
Stale abandoned pre-flight intents are swept automatically and opportunistically from inside the webhook (throttled, non-blocking) — this needs **no Vercel cron and works on the free/Hobby plan**. `/api/cleanup` remains available for manual runs or an external free scheduler (cron-job.org, GitHub Actions) if you want a guaranteed cadence during quiet periods.

**Scheduled Bills / Autopay Agent — these two DO need an external cron to actually run:**
unlike the webhook-driven cleanup above, nothing calls these on its own.
- `/api/schedules/run` — recurring bills (monthly/weekly/daily). Register once or twice a
  day at [cron-job.org](https://cron-job.org) (free) hitting `POST https://<your-domain>/api/schedules/run`
  with header `Authorization: Bearer <CRON_SECRET>` (or `x-cron-secret: <CRON_SECRET>`).
- `/api/schedules/run-instant` — one-off future payments from the DeAI chat ("buy me MTN
  airtime in the next 10 minutes"). Needs a much tighter cadence to actually land close to
  the requested time — register a **separate** free cron-job.org job hitting
  `POST https://<your-domain>/api/schedules/run-instant` every **1–5 minutes**. It's cheap
  even at that frequency: the query is scoped to `frequency = 'once'` rows only, so most
  ticks find nothing due and return immediately.

Without registering these, users can still create schedules (recurring or one-off) from the
chat, but nothing will ever execute them — they'll sit `is_active` forever with no cron to
pick them up.

---

## 🚀 Installation & Setup

1. **Clone the repository**
   ```
   git clone https://github.com/investorphem/abapay.git
   cd abapay
   ```

2. **Install dependencies**
   ```
   npm install
   ```

3. **Set up environment variables** — copy the variables above into `.env.local`.

4. **Run the development server**
   ```
   npm run dev
   ```

5. **Access the application**
   * User Storefront: http://localhost:3000
   * Docs & FAQ: http://localhost:3000/docs
   * Admin Ops Center: http://localhost:3000/admin

### Smart Contract Development (Hardhat)

```
npx hardhat compile          # Compile contracts
npm run test:contracts       # Run the Solidity test suite
npx hardhat run scripts/deployV2.ts --network <network>   # Deploy the hardened V2
npx hardhat run scripts/deployV3.ts --network <network>     # Deploy V3 (agent-initiated payments)
npx hardhat run scripts/register8004.ts --network <network> # Register the agent identity (ERC-8004)
```

#### `AbaPayV2.sol` — hardened contract (⚠️ NOT YET AUDITED)

`contracts/AbaPayV2.sol` is a security-hardened successor to the original `AbaPay.sol`,
addressing the findings in `AUDIT_REPORT.md`. **`payBill`'s signature and the
`PaymentReceived` event are byte-for-byte identical to V1**, so the frontend, the `/api/pay`
calldata decoder, and the webhook's event cross-validation all work with no backend changes.

| Hardening | Why |
|---|---|
| `SafeERC20` | Non-compliant tokens (e.g. some USDT deployments) don't return a bool; raw `require(transfer(...))` breaks on them. |
| `ReentrancyGuard` | `setTokenSupport` can whitelist *any* token; a hook-bearing token would otherwise make `payBill` reentrant. |
| `Pausable` | V1 had no kill switch — a post-deploy vulnerability could not be stopped. Refunds stay live while paused so users can be made whole. |
| `Ownable2Step` | Prevents permanently bricking the contract by transferring ownership to a typo'd address. |
| **Timelocked withdrawals** | **The biggest V1 risk:** a single compromised owner key could drain the entire pooled vault instantly. Withdrawals must now be queued, then executed after a 24h delay — alert on `WithdrawalQueued` and cancel if it wasn't you. |
| **Capped refunds** | V1's `refundUser` was an unrestricted "send any amount anywhere" path that bypassed any withdrawal control. Now bounded per-token (and fails closed until a cap is set). |
| Balance-delta accounting | Emits the amount *actually received*, so fee-on-transfer tokens can't cause the backend to over-vend. |

**Before mainnet:**
1. **Get a professional audit.** This contract holds pooled customer funds; a static review is not sufficient.
2. **Set `ABAPAY_OWNER` to a multisig (Safe), not an EOA.** The timelock buys detection time — it only *stops* an attacker if a stolen key can't unilaterally cancel and re-queue.
3. Deploy to testnet and run the full payment flow end-to-end first.
4. Call `setMaxRefund` for each token — **refunds revert until a cap is configured.**

> `payBill` still uses `transferFrom(msg.sender, …)`, so the payer must be the signer. Delegated
> spending (the DeAI "pay from social media" feature) needs an additional on-chain allowance
> mechanism and is deliberately **out of scope** for this hardening pass — it should be designed
> and audited as its own change.

#### `AbaPayV3.sol` — agent-initiated payments (⚠️ NOT AUDITED)

`contracts/AbaPayV3.sol` builds on V2 to solve the problem above: on Telegram/WhatsApp there is
no wallet to sign with, so the agent could previously only hand the user a deep link to sign in
the app. V3 adds a **session-key / delegated-spend** pattern instead:

1. The user, from their own wallet, does two things once: a standard ERC-20 `approve(AbaPayV3, X)`,
   and `setSpendingAllowance(token, X)` — an on-chain cap **they** control.
2. After that, the authorised **relayer** (a backend hot key, `RELAYER_PRIVATE_KEY`) may call
   `payBillFor()` on their behalf — but the *contract itself* checks and decrements the remaining
   allowance on every call, so the cap is enforced on-chain, not by the backend.

| Bound | Enforced by |
|---|---|
| Per-user total exposure | `spendingAllowance[user][token]` — settable only by the user, revocable instantly to 0 |
| Per-transaction ceiling | `maxAgentPaymentPerTx[token]` — owner-set, a second bound on top of the user's own allowance |
| Blast radius of a stolen relayer key | Can spend **at most** a user's remaining allowance, only via `payBillFor` — cannot drain a wallet, raise anyone's allowance, or withdraw the vault |
| Kill switch | Owner calls `setRelayer(address(0))` to instantly disable the agent, or `pause()` to halt all payments |

**⚠️ Not audited.** The contract itself carries this warning in its header. Deploy to testnet for
demos; on mainnet, keep `maxAgentPaymentPerTx` and `maxRefundPerTx` small (`scripts/deployV3.ts`
defaults to a $10-equivalent per token) until a professional audit is done, then raise them via
`setMaxAgentPayment` / `setMaxRefund`.

`payBillFor` emits the same `PaymentReceived` event as V1/V2 (so the webhook needs no changes),
plus an additional `AgentPayment` event so the backend/any observer can distinguish "the user
signed" from "the agent spent an allowance."

#### ERC-8004 Agent Identity

`scripts/register8004.ts` registers AbaPay's DeAI agent as a real on-chain identity on Celo via
the [ERC-8004 "Trustless Agents"](https://eips.ethereum.org/EIPS/eip-8004) registry
(`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` on mainnet), so it's discoverable and browsable on
8004scan.io / AgentScan the same way any on-chain identity is. Registration mints an ERC-721
whose tokenId is the agent's ID, pointing at a public agent card (`public/.well-known/agent.json`)
that names the operational relayer wallet as the agent's on-chain address.

**This is identity only — it does not touch payments.** The relayer's signature-free
`payBillFor` flow above is completely unaffected; registering (or not) has zero effect on how
bills get paid. Before running on mainnet, verify the `register(string)` selector against the
registry's verified source on Celoscan — see the script's header comment.

#### x402 Settlement (main app only)

The main web app's payment flow settles automatically via [x402](https://x402.org) — through
**Celo's own facilitator** (`api.x402.celo.org`, built by Celo Core Co. — see
`src/app/api/pay/x402/route.ts`), not thirdweb — whenever the user is paying with **USDC or
USD₮ on Celo**. Each token settles against its own EIP-712 domain (`X402_TOKEN_EIP712` in that
route) since Circle's USDC and Tether's USD₮ deployments don't share one. There's no
user-facing toggle: the same "Confirm & Pay" button routes through x402 for either token on
Celo and through the normal `payBill` contract call for everything else (Base, cUSD/USDm, or
x402 unconfigured). This makes the payment genuinely visible on x402scan — not a relabeled
transaction — because x402 settlement requires an EIP-3009 (`transferWithAuthorization`)
signature from the payer for that specific payment.

The **402 challenge itself is built in-house** (a plain x402 v1, body-based response) rather
than relying on any SDK's default — that's a deliberate choice, since thirdweb's own
`settlePayment()` always delivers a fresh challenge via a base64 header with an empty JSON
body, which generic x402 scanners (x402scan's discovery crawler included) don't parse,
causing registration to silently fail with a correct-looking 402 status but no usable
challenge. Client-side, `thirdweb`'s `useFetchWithPayment` (still used for its wallet-signing
plumbing in `src/app/page.tsx`) is unaffected by any of this — it's protocol-generic and reads
the challenge from the response body whenever there's no header present, so it works against
this route exactly the same as it would against thirdweb's own.

That signature requirement is exactly why this is **scoped to the main app only**: the
agent-initiated flow above depends on paying with *zero* signature at payment time (the whole
point of `setSpendingAllowance`), which is fundamentally incompatible with x402's
per-payment-signature model. Telegram/WhatsApp/X and the autonomous scheduler never use x402 and
are unaffected — those payments already execute from `RELAYER_ADDRESS`, the same wallet
registered under the ERC-8004 identity below, so they're already attributable to the agent
without needing x402.

- **Scope: Celo + USDC/USD₮, confirmed live** — not just a caution. Native Celo USDC (Circle's
  FiatTokenV2) and native Celo USD₮ (Tether's deployment) both implement EIP-3009
  `transferWithAuthorization`; cUSD/USDm doesn't, so there's no signature scheme to settle it
  with. Not a self-imposed limit — if support is added for another token later, no code change
  is needed beyond adding its EIP-712 domain, since the token/decimals are already resolved
  generically via `resolveTokenOnChain`.
- **Prepaid credits, not a billing subscription.** Celo's facilitator charges a flat
  $0.001/settlement from a prepaid USDC credit balance (`CELO_X402_API_KEY`) — top up at
  x402.celo.org. At 0 credits, `/settle` starts returning 402 and the app sends a Telegram
  alert (this is an operator problem, not a payer one — retrying won't help until topped up).
- **No automatic fallback to the contract-call flow on x402 failure.** If x402 errors after
  reaching the server, retrying via the contract-call path could double-charge the user if the
  facilitator's settlement actually landed but the response was lost in transit — the same class
  of risk `processBlockchainPayment`'s own paymaster-fallback logic is careful about. The user
  sees a clear error and can retry manually instead.
- **Funds land in the same vault.** `payTo` is set to the existing `AbaPayV3` contract address —
  the same one the admin dashboard already reads balances from and manages refunds/withdrawals
  for. The vault's `balanceOf` doesn't care how tokens arrived, so x402-settled funds are
  indistinguishable from contract-call funds to all existing admin tooling. No contract changes.
- **Vend/refund logic is shared, not duplicated.** Both the on-chain path (`/api/pay`) and the
  x402 path (`/api/pay/x402`) call the same `executeVend()` (`src/lib/vend.ts`) once payment is
  verified — so the automatic refund safety net applies identically to both rails.
- `transactions.payment_method` (`010_x402_payment_method.sql`) distinguishes `CONTRACT` from
  `X402` at a glance, alongside the existing `source_channel` (a different axis — UI channel vs.
  settlement rail).

---

## 🧪 Testing & CI

```
npm test              # Run the unit test suite (Vitest)
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report
npm run typecheck     # tsc --noEmit — catches type errors before they hit a deploy
```

Tests currently cover the security-critical pure logic: PIN hashing/verification, internal
service auth, and the payment amount/token verification invariants (the checks that stand
between a user and an unpaid bill).

**CI** runs on every push/PR via `.github/workflows/ci.yml`: typecheck → lint → build → tests →
dependency audit. The typecheck step exists specifically to catch TypeScript errors *before*
they reach a production deploy.

---

## 🗄️ Database Setup

Beyond the core tables, run the migrations in `supabase/migrations/` **in order** in the Supabase SQL editor:

* `001_rate_limits.sql` — creates the `rate_limits` table required by `src/lib/rateLimit.ts`.
  **Rate limiting silently fails open without this table**, so apply it before relying on the
  throttles protecting your billable VTpass / WhatsApp / Claude endpoints.
* `002_customer_details.sql` — customer details captured on receipts.
* `003_scheduled_bills.sql` — Bill Pay & Autopay Agent scheduling.
* `004_agent_links.sql` — links a wallet to a Telegram/WhatsApp/X identity so the DeAI agent
  can recognise a user. **The security boundary is the on-chain `spendingAllowance` in
  AbaPayV3, not this table** — it's a UX mirror only.
* `005_autonomous_schedules.sql` — upgrades scheduled bills for true unattended execution,
  safe specifically because AbaPayV3's on-chain allowance bounds worst-case exposure.
* `006_agent_admin_controls.sql` — operator kill switches for the agent (`agent_enabled`,
  `agent_autonomous_enabled`, `ai_chat_enabled`, per-tx/daily NGN caps), settable from the
  admin dashboard's Agent tab without a redeploy or contract call.
* `007_transaction_source_channel.sql` — records which channel (web app / Telegram / WhatsApp /
  X / an unattended schedule) originated each transaction, for operator alerting.
* `008_refund_queue.sql` — queued refund pipeline for vends that fail after payment is taken.
* `009_support_tickets.sql` — support tickets from the web app and every social channel, with
  admin replies routed back to the user's original chat.
* `010_x402_payment_method.sql` — adds `payment_method` (`CONTRACT` | `X402`) to `transactions`,
  distinguishing the settlement rail (see [x402 settlement](#x402-settlement-main-app-only)).
* `011_one_off_schedules.sql` — adds `run_once_at` and `batch_id` to `scheduled_bills`, so a
  single chat request can create a one-time future payment (`frequency = 'once'`) or a
  multi-recipient batch, on top of the existing recurring monthly/weekly/daily schedules.

---

## 📱 Testing with MiniPay

AbaPay is highly optimized for mobile Web3 experiences. To test the dApp within the Celo MiniPay environment:
1. Deploy the project (e.g. to Vercel).
2. Set `NEXT_PUBLIC_NETWORK` to `celo-sepolia` (testnet) or `celo` (mainnet), and `NEXT_PUBLIC_APP_MODE` to `sandbox` or `production` accordingly.
3. Open the Opera Mini browser on Android, navigate to the MiniPay tab, and enter your deployed URL.

### Testing as a Farcaster Mini App

The app ships with Farcaster frame metadata (`public/.well-known/farcaster.json` and frame config in `layout.tsx`). Deploy to a public URL, then share the link in a Farcaster client that supports Mini Apps to launch it directly.

---

## 🛡️ Security Architecture

* **No-Log Keys:** VTpass secret keys, Supabase service role key, Telegram tokens, and all other secrets are strictly contained within server-side API routes — never exposed to the client bundle.
* **Replay Protection:** Every blockchain transaction hash is recorded and checked against a **persistent ledger** (a Supabase table with a unique constraint on the tx hash) before a utility vend is triggered. ⚠️ In-memory tracking alone is **not safe** in serverless environments: state resets on cold starts and isn't shared across concurrent instances, which would allow the same transaction hash to be replayed for multiple vends.
* **On-Chain Verification:** Every payment is independently verified against the blockchain (transaction receipt, contract address, and amount) server-side before any bill is vended — the client-submitted payload is never trusted blindly. Under Base gas sponsorship, the top-level transaction's `to` can be a bundler/EntryPoint contract rather than the AbaPay contract itself, so the webhook additionally decodes the transaction's logs and requires that the AbaPay contract genuinely emitted `PaymentReceived` — this holds regardless of how deeply nested the call was.
* **Event Cross-Validation:** The webhook decodes the `PaymentReceived` event and requires that its **payer, token, amount, and account number all match the pending record** before vending. This blocks the class of attack where a user has a small pending intent and then manually sends a different (or larger/smaller) transfer to the contract hoping it gets attached to the wrong record.
* **Stale Intent Expiry:** Pre-flight intents (records created before signing) that never result in an on-chain transaction are automatically expired by a scheduled cleanup (`/api/cleanup`, every 15 min) so they don't linger as `PENDING` forever. This only ever touches `preflight_`-prefixed rows, so a real broadcast transaction can never be expired.
* **Webhook Acknowledgment:** The webhook always returns 2xx once a request passes signature verification, even when no matching transaction record is found (test pings, unrelated activity, or a payment intent that hasn't synced yet are normal, expected outcomes — not delivery failures). Returning a non-2xx here would cause Alchemy to eventually auto-disable the webhook after repeated "failures" that were never really failures.
* **Rate Verification:** The crypto amount paid is checked server-side against the platform's live exchange rate before vending, preventing underpayment exploits even if the client is tampered with.
* **Smart Contract Vault:** User stablecoins go directly into the immutable `AbaPay.sol` smart contract vault. Only the contract owner's cryptographically signed transaction can withdraw funds — no backend service ever holds custody of user funds directly.
* **Automatic Refunds:** If a verified on-chain payment fails to vend (provider outage, invalid details, etc.), the transaction is flagged and refunded back to the user's wallet, with the refund transaction hash recorded on the ledger.
* **Refund Verification:** `/api/admin/refund` verifies the refund on-chain (token, recipient, and amount all decoded from the transaction's ERC-20 Transfer logs) before marking a transaction `REFUNDED` — an admin cannot record a refund that never actually happened.
* **RPC Failover:** On-chain reads use viem's `fallback()` transport across multiple RPC endpoints (`src/lib/chain.ts`), so a single downed provider doesn't halt payment verification.
* **Content-Security-Policy:** Shipped in `Content-Security-Policy-Report-Only` mode (`next.config.ts`) — surfaces violations without risking breakage to wallet connections. Promote to enforcing (`Content-Security-Policy`) once verified against real wallet flows.
* **Admin Auth:** Admin-only API routes and the `/admin` dashboard are gated behind dedicated authentication (`src/utils/adminAuth.ts`), separate from the public storefront. Auth is a wallet-signature challenge verified against the contract owner, with a 12-hour session expiry and timestamp replay protection.
* **Internal-Only AI Routes:** The DeAI "brain" (`/api/deai/*`) is reachable only by the app's own bot webhooks via a signed internal-service token (`src/utils/internalAuth.ts`). This prevents the public internet from impersonating any user by their chat ID / phone number / X ID, or burning the Claude API budget.
* **Bot Webhook Signatures:** The WhatsApp and X webhooks verify Meta's `X-Hub-Signature-256` / X's `x-twitter-webhooks-signature` HMAC on every inbound payload (when the corresponding secret is configured), and Telegram verifies its secret token — so message events can't be forged.
* **Hashed Transaction PINs:** DeAI PINs are stored as salted scrypt hashes (`src/utils/pinSecurity.ts`), never plaintext, with legacy plaintext values transparently upgraded on next use and a 4-attempt lockout.
* **Scoped Paymaster Proxy:** The gas-sponsorship proxy (`/api/paymaster`) allowlists only ERC-7677 paymaster JSON-RPC methods, so it can't be abused as a general-purpose RPC relay running on your CDP key.

---

## 🏢 Legal Entity

AbaPay is operated by **Masonode Technologies Limited**, a company registered with the Corporate Affairs Commission (CAC) of the Federal Republic of Nigeria under **RC 9524980**.

---

## 👨‍💻 Maintainer

Built and maintained by **Oluwafemi Olagoke** ([@investorphem](https://github.com/investorphem)).

*Focusing on Web3, Decentralized AI, and scalable blockchain applications.*
