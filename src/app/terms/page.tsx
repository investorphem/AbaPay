import Link from "next/link";
import { ShieldCheck, Scale, AlertTriangle, FileText, Globe, Bot } from "lucide-react";

export default function TermsOfService() {
  return (
    <main className="min-h-screen bg-slate-50 dark:bg-black text-slate-900 dark:text-slate-100 font-sans p-4 sm:p-8 flex flex-col items-center pb-20 transition-colors">
      <div className="w-full max-w-4xl bg-white dark:bg-[#111114] border border-slate-200 dark:border-slate-800/60 rounded-[2.5rem] p-8 sm:p-12 shadow-xl shadow-slate-200/50 dark:shadow-black/50 transition-colors">

        {/* HEADER SECTION */}
        <div className="border-b border-slate-100 dark:border-slate-800/60 pb-8 mb-8 text-center sm:text-left flex flex-col sm:flex-row items-center sm:items-start justify-between gap-4 transition-colors">
          <div>
            <div className="flex items-center justify-center sm:justify-start gap-3 mb-2">
              <ShieldCheck className="text-emerald-500" size={32} />
              <h1 className="text-3xl font-black text-slate-900 dark:text-white tracking-tight">Terms of Service</h1>
            </div>
            <p className="text-sm font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">AbaPay Global Web3 Protocol</p>
          </div>
          <div className="text-right">
            <p className="text-xs font-bold text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-[#1a1a1f] px-3 py-1.5 rounded-lg inline-block transition-colors">
              Effective Date: April 2026
            </p>
          </div>
        </div>

        {/* CONTENT SECTION */}
        <div className="space-y-8 text-sm sm:text-base text-slate-600 dark:text-slate-300 leading-relaxed font-medium">

          <section className="bg-emerald-50/50 dark:bg-emerald-900/10 p-6 rounded-2xl border border-emerald-100 dark:border-emerald-900/30 transition-colors">
            <h2 className="text-lg font-black text-slate-900 dark:text-white mb-3 flex items-center gap-2">
              <Globe size={18} className="text-emerald-500"/> 1. Introduction & Global Acceptance
            </h2>
            <p className="mb-3">
              Welcome to AbaPay. These Terms of Service ("Terms") constitute a legally binding agreement between you ("User", "you", or "your") and <strong>MASONODE TECHNOLOGIES LIMITED</strong> ("Company", "we", "us", or "our"), a company duly registered under the Corporate Affairs Commission (CAC) of the Federal Republic of Nigeria (RC 9524980), operating globally.
            </p>
            <p>
              By accessing or using the AbaPay decentralized application (the "App") to process local or cross-border crypto-to-utility payments, you explicitly agree to be bound by these Terms, our Privacy Policy, and all applicable domestic and international laws governing your jurisdiction.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-black text-slate-900 dark:text-white mb-3">2. Nature of Services</h2>
            <p className="mb-3">
              AbaPay operates strictly as a <strong>Technology Interface and Borderless Digital Intermediary</strong>. We provide a non-custodial software protocol that allows users to interact with smart contracts on
              {/* ⚡ MULTI-CHAIN UPDATE HERE ⚡ */}
              <strong> Base, Celo, and other supported EVM Blockchains</strong> to exchange digital assets (such as cUSD, USDC, or USDT) for fiat-denominated utility services (Airtime, Data, Electricity, and Bank Transfers) across Nigeria and supported international countries.
            </p>
            <p className="mb-3">
              <strong>We are not a bank.</strong> We do not hold fiat currency deposits. All fiat utility vending is processed through licensed domestic and international Third-Party Aggregators (e.g., VTpass) and regulated Payment Solution Service Providers across our active geographic regions.
            </p>
            <p>
              Payments may be initiated directly through the App, or through our conversational AI agent ("DeAI") on Telegram, WhatsApp, X, and the in-app chat widget — see <strong>Section 7</strong> below for the specific terms governing agent-initiated payments. Depending on the asset and network, on-chain settlement may occur either through a direct smart contract call or via the <strong>x402</strong> HTTP-payment protocol; both routes deposit funds into the same audited smart contract vault and carry identical obligations and protections under these Terms.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-black text-slate-900 dark:text-white mb-3">3. Anti-Money Laundering (AML) & Compliance</h2>
            <p className="mb-3">
              To comply with the Special Control Unit Against Money Laundering (SCUML), the Securities and Exchange Commission (SEC) of Nigeria, and international Financial Action Task Force (FATF) guidelines, AbaPay reserves the right to monitor transactions for illicit activities. 
            </p>
            <p>
              You agree not to use AbaPay for cross-border terrorism financing, money laundering, fraud, or any illegal activity. We reserve the right to freeze transactions, block wallet addresses, and report suspicious activities to Nigerian and international law enforcement agencies without prior notice.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-black text-slate-900 dark:text-white mb-3 flex items-center gap-2">
              <AlertTriangle size={18} className="text-orange-500"/> 4. Blockchain Irreversibility & User Responsibility
            </h2>
            <ul className="list-disc pl-5 space-y-2">
              <li><strong>Irreversible Transactions:</strong> Blockchain transactions are inherently immutable. Once you confirm a payment via your Web3 wallet, the digital assets cannot be recovered by AbaPay.</li>
              <li><strong>Accuracy of Information:</strong> You are 100% responsible for ensuring the accuracy of the destination country code, phone number, meter number, or bank account. AbaPay is not liable for funds sent to incorrect accounts or foreign destinations due to user typographical errors.</li>
              <li><strong>Self-Custody:</strong> AbaPay does not have access to your private keys. You are solely responsible for the security of your Web3 wallet.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-black text-slate-900 dark:text-white mb-3">5. Exchange Rates, Fees, and Taxes</h2>
            <p className="mb-3">
              <strong>Exchange Rates:</strong> The cryptocurrency-to-fiat exchange rate (e.g., NGN, GHS, KES, ZAR, USD) is determined dynamically at the time of your transaction via live international market APIs. By clicking "Pay", you lock in the displayed rate. AbaPay is not liable for crypto market volatility.
            </p>
            <p className="mb-3">
              <strong>Fees:</strong> AbaPay charges a transparent convenience fee for certain heavy-infrastructure utility categories. Additionally, network "Gas" fees charged by the underlying blockchain may apply.
            </p>
            <p>
              <strong>Taxes:</strong> You are solely responsible for determining any tax implications associated with your use of digital assets and paying any applicable taxes to the relevant tax authorities in your geographical jurisdiction (e.g., FIRS in Nigeria).
            </p>
          </section>

          <section>
            <h2 className="text-lg font-black text-slate-900 dark:text-white mb-3">6. Third-Party Services & Limitation of Liability</h2>
            <p className="mb-3">
              AbaPay relies on external utility providers and international telecommunications networks (e.g., MTN Global, Airtel Africa, DSTV, global electricity boards) and API aggregators. 
            </p>
            <p className="mb-3">
              <strong>Limitation of Liability:</strong> To the maximum extent permitted by law, MASONODE TECHNOLOGIES LIMITED shall not be liable for:
            </p>
            <ul className="list-disc pl-5 space-y-2 mb-3">
              <li>Downtime, delays, or service failures caused by domestic or international telecommunication networks or utility providers.</li>
              <li>Blockchain network congestion or smart contract vulnerabilities outside our direct control.</li>
              <li>Financial losses resulting from regulatory actions by local or international governments affecting digital assets.</li>
            </ul>
          </section>

          <section className="bg-indigo-50/50 dark:bg-indigo-900/10 p-6 rounded-2xl border border-indigo-100 dark:border-indigo-900/30 transition-colors">
            <h2 className="text-lg font-black text-slate-900 dark:text-white mb-3 flex items-center gap-2">
              <Bot size={18} className="text-indigo-500"/> 7. DeAI Conversational Agent, Delegated Payments & Autonomous Scheduling
            </h2>
            <p className="mb-3">
              AbaPay provides an AI-powered conversational agent ("<strong>DeAI</strong>") reachable via Telegram, WhatsApp, X, and an in-app chat widget, which lets you check balances and pay bills using natural language instead of the web interface. By linking a messaging account to your wallet or using DeAI in any form, you agree to the following, in addition to the rest of these Terms:
            </p>
            <ul className="list-disc pl-5 space-y-2 mb-3">
              <li><strong>Two ways the agent moves your funds:</strong> (a) a <strong>signed deep link</strong> — DeAI sends a secure, time-limited link that opens the App pre-filled, and you review and sign the transaction yourself in your own wallet, exactly as on the website; or (b) a <strong>delegated on-chain allowance</strong> — if you have explicitly granted the agent a spending allowance (via "Approve" in the Agent Hub), it may execute a payment on your behalf with no fresh wallet signature, strictly bounded by the remaining amount, stablecoin, and blockchain you approved.</li>
              <li><strong>You control the allowance, at all times.</strong> It is enforced on-chain by the smart contract itself, not by AbaPay's backend — you may lower, raise, or revoke it to zero at any time from your own wallet, and it never grants the agent access to your full wallet balance, your private keys, or any asset besides the specific one and chain you approved.</li>
              <li><strong>Your linked messaging account and Transaction PIN are your responsibility.</strong> If a third party gains access to your Telegram, WhatsApp, or X account, or learns your PIN, they may be able to instruct the agent to spend from your approved allowance up to its bounds. AbaPay is not liable for losses resulting from a compromised messaging account, device, or PIN. Treat your PIN like a banking PIN, and revoke your allowance immediately if you suspect unauthorized access.</li>
              <li><strong>Autonomous / Scheduled Payments.</strong> If you configure a recurring or scheduled bill payment, you authorize AbaPay's agent to execute it automatically when due, without further confirmation — bounded by the same on-chain allowance and per-transaction/daily caps. You may cancel a schedule at any time before it executes.</li>
              <li><strong>Operator controls.</strong> We reserve the right to pause, rate-limit, or disable agent-initiated payments (in whole or per-channel) at any time, including via an emergency kill switch, without prior notice, for security, regulatory, or operational reasons.</li>
              <li><strong>AI limitations.</strong> DeAI uses a third-party large language model (Anthropic's Claude) to interpret your messages and may occasionally misread a request. You are responsible for reviewing the confirmation details (service, account/meter/phone number, amount, chain, and token) presented before entering your PIN or signing — that confirmation is your final authorization.</li>
              <li><strong>Optional email receipts.</strong> You may provide an email address in chat to receive a transaction receipt; this is never required to complete a payment.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-black text-slate-900 dark:text-white mb-3">8. Refunds and Reversals</h2>
            <p>
              If your Web3 transaction is successfully confirmed but the Third-Party utility provider fails to deliver the service (e.g., failed token generation or foreign network rejection), AbaPay will automatically flag the transaction. Upon verification of the failure, AbaPay will issue a refund in the original stablecoin asset (less blockchain gas fees) to your connected wallet within 24 to 72 hours.
            </p>
          </section>

          <section className="bg-slate-100 dark:bg-[#1a1a1f] p-6 rounded-2xl transition-colors">
            <h2 className="text-lg font-black text-slate-900 dark:text-white mb-3 flex items-center gap-2">
              <Scale size={18} className="text-slate-700 dark:text-slate-400"/> 9. Governing Law & Dispute Resolution
            </h2>
            <p className="mb-3">
              Because MASONODE TECHNOLOGIES LIMITED is headquartered in Nigeria, these Terms shall be governed by and construed in accordance with the laws of the Federal Republic of Nigeria, without regard to international conflict of law principles.
            </p>
            <p>
              In the event of a dispute, parties shall first attempt to resolve the matter amicably through our support channels. If unresolved within 30 days, the dispute shall be subject to binding arbitration in Nigeria under the Arbitration and Mediation Act, 2023. International users expressly consent to this jurisdiction.
            </p>
          </section>

        </div>

        {/* FOOTER */}
        <div className="mt-12 pt-8 border-t border-slate-100 dark:border-slate-800/60 text-center transition-colors">
          <p className="text-xs font-bold text-slate-400 dark:text-slate-500 mb-4">
            If you have any questions regarding these Terms, please contact us at support@abapays.com
          </p>
          <Link href="/">
            <button className="bg-slate-900 dark:bg-white hover:bg-black dark:hover:bg-slate-200 text-white dark:text-slate-900 px-6 py-3 rounded-xl font-black text-sm transition-all shadow-md hover:shadow-xl active:scale-95 flex items-center gap-2 mx-auto shadow-slate-900/20 dark:shadow-white/10">
              Return to AbaPay
            </button>
          </Link>
        </div>

      </div>
    </main>
  );
}
