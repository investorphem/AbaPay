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
| Telegram | Yes, always free | — |
| WhatsApp Cloud API | Yes, limited | Paid per-conversation beyond free tier |
| X (Twitter) API | No | Paid tier required for webhook/DM access |
| Alchemy | Yes | Paid plans at higher request volume |
| Etherscan | Yes, always free | — |
| WalletConnect/Reown | Yes, always free | — |
| Coinbase Paymaster | Pay-as-you-go | You fund the gas being sponsored |
