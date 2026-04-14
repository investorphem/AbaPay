# ⚡ AbaPay Protocol

AbaPay is a decentralized, Web3-native utility payment platform built on the **Celo Blockchain**. It allows users to seamlessly pay for real-world utilities (Electricity, Cable TV, Airtime, and Data) using **USDT**,**USDC**,**CUSD** with instant fiat settlement via the VTpass API. 

Designed for low fees, instant cross-border utility vending, and mobile-first accessibility (optimized for Celo MiniPay and MetaMask).

---

## 🌟 Key Features

* **Web3 Payments:** Pay bills directly with USDT on Celo Mainnet or Celo Sepolia.
* **Instant Vending:** Automated API integration with VTpass for instant token generation and airtime top-ups.
* **Smart Merchant Verification:** Validates electricity meters and smartcard IUC numbers *before* accepting crypto payments, eliminating user errors.
* **DND-Fallback SMS:** Automated SMS delivery of elecricity tokens bypassing the Nigerian Do-Not-Disturb (DND) registr
* **Dynamic Exchange Engine:** Live market rate conversions with automated profit spread calculation.
* **Executive Admn Dahboard:** Real-time monitoring of VTpass fiat balances, blockchain USDT vaults, and cloud transacton leger.
* **Telegram Integration:** Instant admin notifications for successful sales and multimodal customer support tickets.
---

## 🛠️ Tech Stack

* **Frontend:** Next.js (React), Tailwind CSS, Lucide Icons
* **Web3 / Blockchain:** Viem, Solidity Smart Contracts, Celo Network
* **Backend API Routes:** Next.js Serverless Functions
* **Utility Provider:** VTpass API
* **Database / Ledger:** Supabase (PostgreSQL)
* **Notifications:** Telegram Bot API, VTpass Messaging API

---

## ⚙️ Environment Variables

To run AbaPay locally, create a `.env.local` file in the root directory. **Never commit this file to GitHub.**

NEXT_PUBLIC_APP_MODE=sandbox
NEXT_PUBLIC_NETWORK=celo-sepolia
NEXT_PUBLIC_ABAPAY_ADDRESS=0xYourSmartContractAddressHere
NEXT_PUBLIC_FIXED_RATE=1550.00
VTPASS_API_KEY=your_api_key
VTPASS_PUBLIC_KEY=PK_your_public_key
VTPASS_SECRET_KEY=SK_your_secret_key
VTPASS_MSG_TOKEN=VT_PK_your_token
VTPASS_MSG_SECRET=VT_SK_your_secret
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_ADMIN_CHAT_ID=your_chat_id

---

## 🚀 Installation & Setup

1. Clone the repository:
   git clone https://github.com/investorphem/abapay.git
   cd abapay

2. Install dependencies:
   npm install

3. Run the development server:
   npm run dev

4. Access the application:
   * User Storefront: http://localhost:3000
   * Admin Ops Center: http://localhost:3000/admin

---

## 📱 Testing with MiniPay

AbaPay is highly optimized for mobile Web3 experiences. To test the dApp within the Celo MiniPay environment:
1. Deploy the project to Vercel.
2. Ensure environent variables are set to `celo-sepolia` and `sandbox`.
3. Open the Opera Mini browser on Android, navigate to the MiniPay tab, and enter your Vercel URL.

---

## 🛡️ Security Architecture

* **No-Log Keys:** VTpass secret keys and Telegram tokens are strictly contained within server-side API routes using the `server-only` directive.
* **Replay Protection:** In-memory tracking prevents duplicate blockchain transaction hashes from triggering multiple utility vends.
* **Smart Contract Vault:** User USDT goes directly to the immutable smart contract, requiring the Admin's cryptographically signed transaction to withdraw profits.

---

## 👨‍💻 Maintainer

Built and maintained by **Oluwafemi Olagoke** (@investorphem).

*Focusing on Web3, Decentralized AI, and scalable blockchain applications.*
EOF
