# AbaPay — Environment Variable Setup Guide

Step-by-step instructions for obtaining every environment variable AbaPay needs, whether each
provider is free or paid, and how to wire it into both local development (`.env.local`) and
production (Vercel → Project → Settings → Environment Variables).

**General rule:** any `NEXT_PUBLIC_*` variable is baked into the client bundle at build time —
changing it in Vercel requires a **redeploy** to take effect, not just a restart. Non-public
variables are read at request time by server code, but Vercel still requires a redeploy to pick
up a changed value for most deployment types.

---

## 1. App / Network Config

| Variable | Cost |
|---|---|
| `NEXT_PUBLIC_APP_MODE` | Free — just a string |
| `NEXT_PUBLIC_NETWORK` | Free — just a string|
| `NEXT_PUBLIC_FIXED_RATE` | Free — just a number |
| `NEXT_PUBLIC_APP_URL` | Free — your own domain |

No account needed. Set directly:
```
NEXT_PUBLIC_APP_MODE=sandbox        # or "live" once ready for real VTpass transactions
NEXT_PUBLIC_NETWORK=celo-sepolia    # or "celo" / "base" / "base-sepolia"
NEXT_PUBLIC_FIXED_RATE=1550.00      # fallback NGN/USD rate if the live rate lookup fails
NEXT_PUBLIC_APP_URL=https://abapays.com
```

### `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`
**Free.**
1. Go to [cloud.reown.com](https://cloud.reown.com) (formerly WalletConnect Cloud) → sign up.
2. Create a new project, name it "AbaPay".
3. Copy the **Project ID** shown on the project dashboard.

### `NEXT_PUBLIC_WC_RELAY_URL` (optional — blocked networks)
**Free, and only needed if your users are on a network that filters WalletConnect.**

Some Nigerian mobile networks (MTN most reported) block `relay.walletconnect.org`. The relay
is a WebSocket, so the block is silent: no QR code, no error, the Connect button just sits
there. There is only ONE WalletConnect relay network — you can't switch provider — but you
can change the URL your app reaches it through.

1. Stand up a WebSocket reverse proxy on a subdomain you control, forwarding to
   `wss://relay.walletconnect.org`. **Vercel cannot do this** — its functions don't proxy
   long-lived WebSockets. Use Cloudflare Workers (free tier is enough), Fly.io, Railway, or a
   VPS with nginx `proxy_pass` plus the `Upgrade`/`Connection` headers.
2. Set `NEXT_PUBLIC_WC_RELAY_URL=wss://relay.yourdomain.com`.

Leave it unset to use WalletConnect's own relay. Relay traffic is end-to-end encrypted
between wallet and dApp, so the proxy can't read sessions — but it does become an
availability dependency, so monitor it. Confirm what's actually blocked with `/network-check`
before building the proxy: if a carrier filters by IP rather than by domain, a proxy on
different infrastructure is required.

### `ADMIN_WALLET_ADDRESS`
Free — this is just the wallet address (yours) that's allowed to sign into `/admin`. No
account needed, just paste your own `0x...` address.

### `PAYMASTER_URL` (Base sponsored gas — optional)
**Paid** — you fund the gas being sponsored; Coinbase doesn't charge a platform fee on top, but
every sponsored transaction costs real gas from your CDP balance.
1. Sign up at [coinbase.com/developer-platform](https://www.coinbase.com/developer-platform).
2. Create a project → **Paymaster & Bundler** → copy the RPC URL (this is `PAYMASTER_URL`).
3. Under **Paymaster → Policies**, allowlist your `NEXT_PUBLIC_ABAPAY_BASE_ADDRESS` contract
   (and ideally the specific `payBill`/`approve` selectors), and fund a budget.
4. This only matters if you want Base users to pay with zero gas fees — skip it entirely for
   Celo-only operation.

---

## 2. Smart Contracts / Deploy Keys

| Variable | Cost |
|---|---|
| `CELO_PRIVATE_KEY` | Free to hold — deploying/calling contracts costs gas (a few cents in CELO per tx) |
| `RELAYER_PRIVATE_KEY` / `RELAYER_ADDRESS` | Same — gas only |
| `ABAPAY_OWNER` | Free — optional, defaults to the deployer address |
| `ETHERSCAN_API_KEY` | Free |

### `CELO_PRIVATE_KEY`
This is **your own wallet's private key** — the one that deploys and owns the contracts. Not
issued by anyone; export it from whatever wallet you use (MetaMask → Account Details → Export
Private Key, or similar). ⚠️ Never commit this file or share this key. Fund the address with a
small amount of real CELO for gas before deploying.

### `RELAYER_PRIVATE_KEY` / `RELAYER_ADDRESS`
Generate a **new, separate** wallet for this — never reuse your owner key. E.g.:
```
node -e "const {privateKeyToAccount} = require('viem/accounts'); const pk = '0x' + require('crypto').randomBytes(32).toString('hex'); console.log('Key:', pk); console.log('Address:', privateKeyToAccount(pk).address);"
```
Fund the resulting address with a small amount of CELO (gas only — it should never hold token
balances, since a leaked relayer key can only spend within on-chain allowances, not drain
anything, but there's no reason to give it more exposure than necessary).

### `ETHERSCAN_API_KEY`
**Free.**
1. Sign up at [etherscan.io](https://etherscan.io) → **My Profile → API Keys → Add**.
2. This single key works for contract verification across chains (including Celoscan) via
   Etherscan's V2 unified API — no separate Celoscan account needed.

---

## 3. `AbaPayV3` Contract Address

```
NEXT_PUBLIC_ABAPAY_CELO_ADDRESS=0x...
NEXT_PUBLIC_ABAPAY_BASE_ADDRESS=0x...
```
Free — these are just the addresses printed by `npx hardhat run scripts/deployV3.ts --network
<network>`. **This is the single source of truth for where all payments land** — the classic
contract flow, the admin dashboard's balance/refund/withdrawal tools, and x402's `payTo` all
read this same value. Keep local and production in sync; a mismatch here is exactly what caused
the x402 payTo confusion earlier — always double check Vercel's value matches what you actually
deployed.

---

## 4. Agent Identity — ERC-8004 (one-time registration)

```
ERC8004_AGENT_URI=https://<your-domain>/.well-known/agent.json
NEXT_PUBLIC_ERC8004_AGENT_ID=          # filled in AFTER registering
```
**Free** — registration only costs the gas to call `register()` (a few cents in CELO).
1. Edit `public/.well-known/agent.json` — set `endpoints[0].address` to your real
   `RELAYER_ADDRESS`.
2. Deploy so it's reachable at `https://<your-domain>/.well-known/agent.json`.
3. Set `ERC8004_AGENT_URI` to that URL.
4. `npx hardhat run scripts/register8004.ts --network sepolia` first (testnet dry run), then
   `--network celo` for real.
5. The script prints an agent ID — set `NEXT_PUBLIC_ERC8004_AGENT_ID` to it. Look it up at
   [8004scan.io](https://8004scan.io) once indexed.

---

## 5. x402 Settlement — Celo's own facilitator + thirdweb (client-side only)

```
CELO_X402_API_KEY=x402_...                 # Server-side: settles via api.x402.celo.org
NEXT_PUBLIC_THIRDWEB_CLIENT_ID=...          # Client-side only: wallet-signing plumbing
```
**Free** — no billing plan required, unlike thirdweb (see below). Celo's facilitator charges
a flat **$0.001 per settlement** from a prepaid USDC credit balance instead of a percentage
cut or a subscription — you get free credits just for connecting a wallet (500 mainnet /
1,000 testnet at time of writing).

1. Go to [x402.celo.org](https://x402.celo.org) → **Connect wallet** (signs a free message,
   no gas, no transaction).
2. Copy the API key shown — **it's only displayed once**, so save it immediately
   (`CELO_X402_API_KEY`). The same key works for both `api.x402.celo.org` (mainnet) and
   `api.x402.sepolia.celo.org` (testnet), tracked as separate credit pools.
3. When credits run low, deposit USDC from the same dashboard (~$1 ≈ 1,000 credits). At 0
   credits the facilitator returns 402 until topped up — the app sends a Telegram alert when
   this happens rather than failing silently.
4. `NEXT_PUBLIC_THIRDWEB_CLIENT_ID` is still needed for the **client-side only** — the wallet
   connects and signs the payment through thirdweb's SDK regardless of which facilitator
   actually settles it (the protocol is generic). Sign up at [thirdweb.com](https://thirdweb.com)
   → **Add New → Create Project** → set **Allowed Domains** → copy the **Client ID**. No
   secret key or server wallet needed — thirdweb no longer does the settling.

**Why not thirdweb's own facilitator?** It requires a paid billing plan just to settle on
mainnet at all (`DELEGATION_CHECK_FAILED` — "Mainnets not enabled for this account" —
otherwise), plus a ~0.3% per-transaction cut on top, and routes funds through its own server
wallet before forwarding them on rather than paying the destination directly. Celo's
facilitator has none of those drawbacks for a Celo-only app.

---

## 6. Supabase (Database)

```
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
```
**Free tier available**, paid plans for higher usage/storage/compute — check
[supabase.com/pricing](https://supabase.com/pricing) for current tiers.
1. Sign up at [supabase.com](https://supabase.com) → **New Project**.
2. Once created: **Project Settings → API** → copy **Project URL**
   (`NEXT_PUBLIC_SUPABASE_URL`), **anon/public key** (`NEXT_PUBLIC_SUPABASE_ANON_KEY`), and
   **service_role key** (`SUPABASE_SERVICE_ROLE_KEY` — ⚠️ full DB access, server-only, never
   expose client-side).
3. Run every migration in `supabase/migrations/`, **in numeric order**, in the SQL Editor.

---

## 7. Email — Resend

```
RESEND_API_KEY=re_...
```
**Free tier available** (limited sends/month), paid plans beyond that — check
[resend.com/pricing](https://resend.com/pricing).
1. Sign up at [resend.com](https://resend.com) → **API Keys → Create API Key**.
2. Verify your sending domain (`abapays.com`) under **Domains** so `receipts@abapays.com` /
   `support@abapays.com` can actually send — unverified domains are heavily rate-limited or
   blocked.

---

## 8. AI — Claude (Anthropic)

```
ANTHROPIC_API_KEY=sk-ant-...
DEAI_INTERNAL_SECRET=<any long random string you generate yourself>
```
**Paid, pay-as-you-go** — no meaningful free tier for sustained production use; billed per
token. Check [anthropic.com/pricing](https://www.anthropic.com/pricing) for current rates.
1. Sign up at [console.anthropic.com](https://console.anthropic.com).
2. **Settings → API Keys → Create Key.**
3. Add a payment method under **Settings → Billing** — the API won't work without credits/a
   payment method attached.
4. `DEAI_INTERNAL_SECRET` isn't from Anthropic — generate it yourself:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

---

## 9. VTpass (Bill Payment Provider)

```
VTPASS_API_KEY=...
VTPASS_PUBLIC_KEY=PK_...
VTPASS_SECRET_KEY=SK_...
VTPASS_MSG_TOKEN=VT_PK_...
VTPASS_MSG_SECRET=VT_SK_...
```
**This is a commercial business relationship, not a SaaS free/paid tier.** VTpass is a Nigerian
bill-payment aggregator — you need a registered VTpass merchant/business account, and your
VTpass wallet needs to be funded (in Naira) to actually vend airtime/data/electricity/etc., since
VTpass pays the underlying telco/disco/etc. out of your float balance.
1. Sign up at [vtpass.com](https://vtpass.com) as a business/developer account.
2. Get sandbox credentials first (**Sandbox → API Keys**) for `VTPASS_API_KEY`,
   `VTPASS_PUBLIC_KEY`, `VTPASS_SECRET_KEY` — test with `NEXT_PUBLIC_APP_MODE=sandbox`.
3. Once ready for real money, apply for/fund a **live** account, get live keys, and switch
   `NEXT_PUBLIC_APP_MODE=live`.
4. `VTPASS_MSG_TOKEN` / `VTPASS_MSG_SECRET` are separate credentials for VTpass's SMS messaging
   API (used for DND-fallback SMS delivery of electricity tokens) — requested separately from
   VTpass support/dashboard.

---

## 9b. Monnify (Moniepoint's API — Bank Transfer Provider)

```
MONNIFY_MODE=sandbox
MONNIFY_API_KEY=MK_TEST_...
MONNIFY_SECRET_KEY=...
MONNIFY_CONTRACT_CODE=...
MONNIFY_SOURCE_ACCOUNT_NUMBER=...
```
Your money sits at **Moniepoint Microfinance Bank** (the actual bank holding the current/
business account), but the API that triggers transfers, verifies account numbers, and lists
banks is **Monnify** — Moniepoint Inc.'s own API product, same parent company, but **NOT the
same login as your Moniepoint business app**. Confirmed the hard way: a Moniepoint app
username/password gets "Invalid username or password combination" on Monnify — you need a
separate Monnify merchant account.
1. Sign up directly at [app.monnify.com](https://app.monnify.com) (or monnify.com's "Get
   Started" flow) — a fresh registration, not your Moniepoint app credentials. Expect a KYB
   step (CAC registration, BVN, etc.) before live/disbursement access is approved.
2. Once in, get **sandbox** credentials first from **Settings → API Keys & Webhooks** (or a
   "Developers" menu item) for `MONNIFY_API_KEY` / `MONNIFY_SECRET_KEY`; the Contract Code is
   under **Settings → Contracts** → `MONNIFY_CONTRACT_CODE`.
3. `MONNIFY_SOURCE_ACCOUNT_NUMBER` is the wallet/account number disbursements are debited
   from — shown on the same developer page as "Wallet Account Number."
4. `MONNIFY_MODE` is Monnify's **own** sandbox/live switch, deliberately separate from
   `NEXT_PUBLIC_APP_MODE` (which governs VTpass) — this lets you test Monnify sandbox
   credentials while VTpass keeps running live in production, and vice versa. Falls back to
   `NEXT_PUBLIC_APP_MODE` if unset. Set `MONNIFY_MODE=sandbox` for testing (base URL
   `sandbox.monnify.com`).
5. **Turn OFF transaction MFA/OTP approval for this API credential.** With it on, every
   transfer sits at `PENDING_AUTHORIZATION` until a human clicks an email approval link —
   incompatible with AbaPay's automated flow. Look for this under the API credential's
   security settings; the app sends a Telegram alert if it ever hits this state anyway, as a
   safety net.
6. Register a webhook — **Developers → Webhook URLs** has separate fields for *Transaction
   completion*, *Refund completion*, *Disbursement*, and *Settlement*. Put
   `https://www.abapays.com/api/monnify/webhook` specifically in the **Disbursement** field
   (verify your canonical domain first — Monnify does not follow redirects, same trap as every
   other webhook in this app). The webhook is signed with `MONNIFY_SECRET_KEY`
   (HMAC-SHA512, `monnify-signature` header) — nothing extra to generate.
7. Once ready for real money: apply for/fund a **live** Monnify account, rotate all four values
   above to the live equivalents, and set `MONNIFY_MODE=live` (or just delete it, since it then
   falls back to `NEXT_PUBLIC_APP_MODE`, which is already `live`).

**Optional — low-balance alerting:**
```
VTPASS_LOW_BALANCE_THRESHOLD_NGN=5000    # default 5000 if unset
MONNIFY_LOW_BALANCE_THRESHOLD_NGN=5000   # default 5000 if unset
```
Free — just numbers you set yourself. `src/lib/balanceAlerts.ts` checks both providers'
float every time `/api/cleanup` runs (same external cron already recommended for the stuck-
transaction sweep) and sends a Telegram alert when either drops below its threshold, with a 6h
cooldown per provider so a cron running every few minutes doesn't spam the same warning.

---

## 10. Telegram

```
TELEGRAM_BOT_TOKEN=...            # Admin alerts bot
TELEGRAM_CHAT_ID=...
TELEGRAM_ADMIN_CHAT_ID=...
TELEGRAM_WEBHOOK_SECRET=<any long random string you generate yourself>
DEAI_TELEGRAM_BOT_TOKEN=...        # The user-facing DeAI agent bot
SUPPORT_TELEGRAM_BOT_TOKEN=...     # Support ticket bot
```
**Completely free** — Telegram doesn't charge for Bot API usage at any volume.

This app uses **three separate bots** — don't mix up their tokens:
1. **Admin alerts bot** (`TELEGRAM_BOT_TOKEN`) — sends you (the operator) sale/refund/fraud
   alerts. Message [@BotFather](https://t.me/BotFather) → `/newbot` → follow the prompts → copy
   the token it gives you.
2. **DeAI agent bot** (`DEAI_TELEGRAM_BOT_TOKEN`) — the user-facing bot at `@AbaPayAgentBot`
   that lets users pay bills via chat. Same `/newbot` process with BotFather, separate bot.
3. **Support bot** (`SUPPORT_TELEGRAM_BOT_TOKEN`) — routes support tickets. Same process again.

**Chat IDs:** message your own bot (or the group you want alerts in) once, then call
`https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser — the `chat.id` field in the
response is what you need for `TELEGRAM_CHAT_ID` / `TELEGRAM_ADMIN_CHAT_ID`.

**Webhook registration (critical — this is what broke earlier):**
```
node -e "fetch('https://api.telegram.org/bot' + process.env.DEAI_TELEGRAM_BOT_TOKEN + '/setWebhook', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({url:'https://www.abapays.com/api/telegram/webhook', secret_token: process.env.TELEGRAM_WEBHOOK_SECRET})}).then(r=>r.json()).then(console.log)"
```
⚠️ **Use your actual canonical domain** (check whether it's `abapays.com` or
`www.abapays.com` by hitting either in a browser and seeing which one it redirects to —
Telegram does **not** follow redirects, so registering the wrong one silently breaks
everything). Verify anytime with:
```
curl "https://api.telegram.org/bot<DEAI_TELEGRAM_BOT_TOKEN>/getWebhookInfo"
```

---

## 11. WhatsApp Cloud API (Meta)

```
WHATSAPP_ACCESS_TOKEN=...
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_VERIFY_TOKEN=<any string you make up yourself>
WHATSAPP_APP_SECRET=...
```
**Free tier for a limited number of conversations/month, then paid per-conversation** — Meta's
WhatsApp Business Platform pricing is conversation-based; check
[developers.facebook.com/docs/whatsapp/pricing](https://developers.facebook.com/docs/whatsapp/pricing)
for current rates.
1. Create a Meta App at [developers.facebook.com](https://developers.facebook.com) → add the
   **WhatsApp** product.
2. Under **WhatsApp → API Setup**: copy the temporary access token to start (generate a
   permanent one later via a System User for production), and the **Phone Number ID**.
3. `WHATSAPP_VERIFY_TOKEN` isn't issued by Meta — you make it up (any random string) and enter
   the *same* string in Meta's webhook config field.
4. `WHATSAPP_APP_SECRET`: **App Settings → Basic → App Secret**.
5. **Webhook config** (same redirect trap as Telegram applies here): **WhatsApp → Configuration
   → Webhook**, callback URL `https://www.abapays.com/api/whatsapp/webhook` (verify which
   domain is canonical first), verify token = your `WHATSAPP_VERIFY_TOKEN`. Subscribe to the
   `messages` field.

---

## 12. X (Twitter)

```
X_BEARER_TOKEN=...
X_CONSUMER_SECRET=...
X_BOT_ACCOUNT_ID=...
```
**Paid** — X's API has required a paid tier (Basic or higher) for meaningful Account
Activity/webhook access since the free tier was largely eliminated; check
[developer.x.com/en/products/x-api](https://developer.x.com/en/products/x-api) for current
plans.
1. Apply for API access at [developer.x.com](https://developer.x.com), subscribe to a paid tier
   that includes Account Activity API / webhook (DM) access.
2. Create a Project + App → **Keys and Tokens** → generate/copy the **Bearer Token**
   (`X_BEARER_TOKEN`) and **API Secret Key** (`X_CONSUMER_SECRET`).
3. `X_BOT_ACCOUNT_ID` is your bot account's numeric user ID (look it up via any "tweet ID
   lookup" tool using your bot's handle, or via the API itself).
4. **Webhook config** (same redirect trap applies): register
   `https://www.abapays.com/api/x/webhook` as the webhook URL via the Account Activity API's
   registration endpoint — this is API-driven, not a dashboard toggle, so double check the exact
   domain before registering.

---

## 13. On-Chain Webhooks — Alchemy

```
ALCHEMY_WEBHOOK_SECRET=...
ALCHEMY_CELO_WEBHOOK_SECRET=...
```
**Free tier available**, paid plans for higher request volume — check
[alchemy.com/pricing](https://www.alchemy.com/pricing).
1. Sign up at [alchemy.com](https://alchemy.com) → create an app for Base and one for Celo.
2. **Notify → Webhooks → Create Webhook** — Address Activity type, pointed at
   `https://www.abapays.com/api/webhook` (again — verify the canonical domain first).
3. Copy the **Signing Key** shown for each webhook — that's `ALCHEMY_WEBHOOK_SECRET` (Base) /
   `ALCHEMY_CELO_WEBHOOK_SECRET` (Celo).
4. Make sure the **Token** activity category is enabled, not just **External** — under Base
   sponsored-gas transactions, the top-level `to` is the bundler contract, not AbaPay directly;
   only Token-category (ERC-20 Transfer log) monitoring reliably fires regardless of call depth.

---

## 14. Cron / Maintenance

```
CRON_SECRET=<any long random string you generate yourself>
```
Free — not issued by anyone, just protects the manual `/api/cleanup` endpoint. Generate with:
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

---

## 15. Dune Analytics (dashboard refresh)

```
DUNE_API_KEY=<from dune.com → abapay team → Settings → API keys>
ABAPAY_BASE_CONTRACTS="0xC0A4…=AbaPayV4 (current),0xF3AeFF…=AbaPay V1 (original)"
```
**Free** on the Community plan. `DUNE_API_KEY` is required by `/api/cron/dune-refresh`, which
re-runs the analytics queries behind the two public dashboards so neither goes stale:

* `?dashboard=main` — the original combined Celo + Base dashboard (7 queries)
* `?dashboard=base` — **Base mainnet only** (9 queries), SQL in `dune/base-chain/`

Needed because Dune's own **query** scheduler only runs on the **medium/large** engines, which the
Community plan cannot use (`medium` returns *"Performance medium is not supported for this
dataset"*). The API path works on `small`, so a cron calling this route is the only way to update
the dashboard **panels** on a free plan. `.github/workflows/dune-refresh.yml` does that daily —
set the repository secrets `APP_URL` and `CRON_SECRET` (Settings → Secrets and variables →
Actions) and it runs itself; nothing to register at cron-job.org.

⚠️ That cron is only half of the refresh. The **data** behind both dashboards lives in
materialized views, which Dune refreshes on its own matview cron at 02:00 UTC — matview crons
*do* work on the Community plan, unlike the query scheduler. A matview refresh does not count as
an execution of the query, so it never updates a panel on its own; and the cron above only
re-aggregates whatever the matviews last wrote. Both halves are required. See
`dune/base-chain/README.md`.

`ABAPAY_BASE_CONTRACTS` is only read by `scripts/dune-base-setup.mjs`, which renders and deploys
the Base dashboard's SQL. It lists **every** AbaPay deployment on Base, not just the current one,
so a redeploy doesn't truncate the dashboard's history. Format is `address=label`, comma-separated.
⚠️ Make sure the API key belongs to the **abapay team**, not your personal account, or the queries
are created in the wrong place.

Budget: ~12 credits per full refresh of the main dashboard against a 2,500/month quota; the Base
dashboard adds a similar amount. A daily run of both costs roughly 700–800 credits/month —
still inside the free tier.

---

## Quick checklist: what's actually paid

| Provider | Free tier? | Paid requirement |
|---|---|---|
| Celo / Base gas | — | Real gas costs (cents per tx), not a subscription |
| Celo x402 facilitator | Yes, free credits on connect | Flat $0.001/settlement, prepaid USDC credits |
| thirdweb | Free (client-side only now) | No longer used for settlement — just wallet-signing plumbing |
| Supabase | Yes | Paid plans at higher usage |
| Resend | Yes | Paid plans at higher volume |
| Anthropic (Claude) | No meaningful free tier | Pay-as-you-go per token, always |
| VTpass | — | Business account + funded Naira float balance |
| Monnify (Moniepoint) | — | Business account + funded Moniepoint balance to disburse from |
| Telegram | Yes, always free | — |
| WhatsApp Cloud API | Yes, limited | Paid per-conversation beyond free tier |
| X (Twitter) API | No | Paid tier required for webhook/DM access |
| Alchemy | Yes | Paid plans at higher request volume |
| Etherscan | Yes, always free | — |
| WalletConnect/Reown | Yes, always free | — |
| Coinbase Paymaster | Pay-as-you-go | You fund the gas being sponsored |
