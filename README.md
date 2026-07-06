# ⚡ AbaPay Protocol

AbaPay is a decentralized, Web3-native utility payment platform built on **Celo** and **Base**. It lets users pay for real-world bills — Airtime, Mobile Data, Electricity, Cable TV, Bank Transfers, Education PINs, and International Airtime/Data — using on-chain stablecoins (**USDT**, **USDC**, **cUSD**), with instant fiat settlement handled server-side via the VTpass API.

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
* **Conversational AI Agent ("DeAI"):** A natural-language assistant (`/api/deai`) that lets users check balances and pay bills via chat-style commands, backed by Google Gemini.
* **Dynamic Exchange Engine:** Live market rate conversions with admin-configurable exchange rate and automated profit spread calculation, verified server-side to prevent underpayment exploits.
* **Executive Admin Dashboard:** Real-time monitoring of VTpass fiat balance, on-chain vault balances per token/chain, transaction analytics, manual refund tools, and CSV export — protected behind admin auth.
* **Farcaster Mini App Ready:** Ships with Farcaster frame metadata so AbaPay can be launched directly inside Farcaster clients.

---

## 🛠️ Tech Stack

* **Frontend:** Next.js 16 (App Router, React 19), Tailwind CSS 4, Lucide Icons, next-themes (dark mode)
* **Web3 / Wallets:** Wagmi, Viem, WalletConnect Modal, Base Account SDK, Solidity smart contract (Hardhat)
* **Backend:** Next.js Route Handlers (serverless functions)
* **AI:** Google Generative AI (Gemini) for the DeAI conversational agent
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
├── components/                 # Shared UI (AppFooter, Modals, tabs, etc.)
├── config/wagmi.ts             # Wallet/chain configuration
├── constants/                  # Supported tokens, services, providers
├── lib/                        # VTpass, Telegram, WhatsApp, messaging helpers
└── utils/                      # Supabase client, admin auth
contracts/AbaPay.sol            # On-chain escrow/vault smart contract
scripts/deploy.ts               # Hardhat deployment script
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
GEMINI_API_KEY=your_gemini_api_key
```

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
npx hardhat compile        # Compile contracts/AbaPay.sol
npx hardhat test           # Run contract tests (if present)
npx hardhat run scripts/deploy.ts --network <network>   # Deploy
```

Configure your target networks and private key in `hardhat.config.ts` / `.env.local` before deploying.

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
* **On-Chain Verification:** Every payment is independently verified against the blockchain (transaction receipt, contract address, and amount) server-side before any bill is vended — the client-submitted payload is never trusted blindly.
* **Rate Verification:** The crypto amount paid is checked server-side against the platform's live exchange rate before vending, preventing underpayment exploits even if the client is tampered with.
* **Smart Contract Vault:** User stablecoins go directly into the immutable `AbaPay.sol` smart contract vault. Only the contract owner's cryptographically signed transaction can withdraw funds — no backend service ever holds custody of user funds directly.
* **Automatic Refunds:** If a verified on-chain payment fails to vend (provider outage, invalid details, etc.), the transaction is flagged and refunded back to the user's wallet, with the refund transaction hash recorded on the ledger.
* **Admin Auth:** Admin-only API routes and the `/admin` dashboard are gated behind dedicated authentication (`src/utils/adminAuth.ts`), separate from the public storefront.

---

## 🏢 Legal Entity

AbaPay is operated by **Masonode Technologies Limited**, a company registered with the Corporate Affairs Commission (CAC) of the Federal Republic of Nigeria under **RC 9524980**.

---

## 👨‍💻 Maintainer

Built and maintained by **Oluwafemi Olagoke** ([@investorphem](https://x.com/investorphem)).

*Focusing on Web3, Decentralized AI, and scalable blockchain applications.*
