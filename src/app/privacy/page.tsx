import Link from "next/link";
import { ShieldCheck, Lock, Database, Share2, Trash2, UserCheck, Mail, Globe, Bot } from "lucide-react";

export default function PrivacyPolicy() {
  return (
    <main className="min-h-screen bg-slate-50 dark:bg-black text-slate-900 dark:text-slate-100 font-sans p-4 sm:p-8 flex flex-col items-center pb-20 transition-colors">
      <div className="w-full max-w-4xl bg-white dark:bg-[#111114] border border-slate-200 dark:border-slate-800/60 rounded-[2.5rem] p-8 sm:p-12 shadow-xl shadow-slate-200/50 dark:shadow-black/50 transition-colors">

        {/* HEADER SECTION */}
        <div className="border-b border-slate-100 dark:border-slate-800/60 pb-8 mb-8 text-center sm:text-left flex flex-col sm:flex-row items-center sm:items-start justify-between gap-4 transition-colors">
          <div>
            <div className="flex items-center justify-center sm:justify-start gap-3 mb-2">
              <Lock className="text-emerald-500" size={32} />
              <h1 className="text-3xl font-black text-slate-900 dark:text-white tracking-tight">Privacy Policy</h1>
            </div>
            <p className="text-sm font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">AbaPay Global Web3 Protocol</p>
          </div>
          <div className="text-right">
            <p className="text-xs font-bold text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-[#1a1a1f] px-3 py-1.5 rounded-lg inline-block transition-colors">
              Effective Date: July 2026
            </p>
          </div>
        </div>

        {/* CONTENT SECTION */}
        <div className="space-y-8 text-sm sm:text-base text-slate-600 dark:text-slate-300 leading-relaxed font-medium">

          <section className="bg-emerald-50/50 dark:bg-emerald-900/10 p-6 rounded-2xl border border-emerald-100 dark:border-emerald-900/30 transition-colors">
            <h2 className="text-lg font-black text-slate-900 dark:text-white mb-3 flex items-center gap-2">
              <Globe size={18} className="text-emerald-500"/> 1. Introduction & Global Data Controller
            </h2>
            <p className="mb-3">
              <strong>MASONODE TECHNOLOGIES LIMITED</strong> (RC 9524980) ("we", "us", or "our"), the operator of the AbaPay decentralized application, is committed to protecting your personal data across all jurisdictions we serve. 
            </p>
            <p>
              This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you use AbaPay to bridge digital assets with domestic and international utility services. As a company headquartered in Nigeria, we operate in strict compliance with the <strong>Nigeria Data Protection Act (NDPA) 2023</strong>, while extending globally recognized privacy principles (such as GDPR) to protect our international users.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-black text-slate-900 dark:text-white mb-3 flex items-center gap-2">
              <Database size={18} className="text-slate-400 dark:text-slate-500"/> 2. The Data We Collect
            </h2>
            <p className="mb-3">To provide you with seamless borderless utility vending, we must collect specific data points. We classify this into two categories:</p>

            <h3 className="font-bold text-slate-800 dark:text-slate-200 mt-4 mb-2">A. On-Chain & Web3 Data</h3>
            <ul className="list-disc pl-5 space-y-2 mb-4">
              <li><strong>Public Wallet Addresses:</strong> We collect your Base, Celo, or other EVM public wallet addresses to facilitate stablecoin escrow and transaction tracking.</li>
              <li><strong>Transaction Hashes:</strong> Public blockchain metadata confirming your payment.</li>
              <li><strong className="text-emerald-600 dark:text-emerald-400">Strict Self-Custody Guarantee:</strong> AbaPay NEVER collects, stores, or requests access to your private keys, seed phrases, or wallet passwords.</li>
            </ul>

            <h3 className="font-bold text-slate-800 dark:text-slate-200 mt-4 mb-2">B. Utility & Fiat Data</h3>
            <ul className="list-disc pl-5 space-y-2 mb-4">
              <li><strong>Utility Identifiers:</strong> Local and international phone numbers, Smartcard numbers, Meter numbers, and Bank Account numbers you provide for vending.</li>
              <li><strong>Verified KYC Data:</strong> When you verify an account, our API may retrieve the associated <strong>Customer Name, physical meter address, and Account Type</strong> from the relevant national or international grid/banking network to ensure you are paying the correct bill.</li>
              <li><strong>Contact Information:</strong> Email addresses optionally provided for transaction receipts or support tickets.</li>
            </ul>

            <h3 className="font-bold text-slate-800 dark:text-slate-200 mt-4 mb-2">C. DeAI Agent & Messaging Data</h3>
            <ul className="list-disc pl-5 space-y-2">
              <li><strong>Messaging Platform Identifiers:</strong> Your Telegram Chat ID, WhatsApp phone number, or X User ID, linked to your wallet address so the agent can recognize you across conversations.</li>
              <li><strong>Chat Message Content:</strong> Messages you send to the DeAI agent are processed to determine your intent (e.g. "top up my phone with 500 naira") — including by our AI provider, Anthropic (Claude API). We do not use this content for advertising or sell it to third parties.</li>
              <li><strong>Hashed Transaction PIN:</strong> Your DeAI transaction PIN is stored as a salted cryptographic hash — never in plaintext. AbaPay staff cannot view your actual PIN.</li>
              <li><strong>On-Chain Allowance Data:</strong> The stablecoin, blockchain, and spending limit you've approved for the agent — this is public on-chain data, visible to anyone who inspects the blockchain, not private data we control.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-black text-slate-900 dark:text-white mb-3">3. How We Use Your Data</h2>
            <p className="mb-3">We strictly use your data for the following purposes:</p>
            <ul className="list-disc pl-5 space-y-2">
              <li><strong>Service Execution:</strong> To route your payment accurately to the specified domestic or international DisCo, Telco, or Bank.</li>
              <li><strong>Transaction History:</strong> To maintain an encrypted ledger so you can track your past cross-border payments and request refunds if a network fails.</li>
              <li><strong>Fraud Prevention & AML:</strong> To monitor for duplicate transactions, prevent API abuse, and comply with global Anti-Money Laundering (AML) and Counter-Terrorism Financing (CTF) directives.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-black text-slate-900 dark:text-white mb-3 flex items-center gap-2">
              <Share2 size={18} className="text-slate-400 dark:text-slate-500"/> 4. Third-Party & Cross-Border Data Sharing
            </h2>
            <p className="mb-3">
              AbaPay is a global aggregator interface. To successfully vend your utility, <strong>we must securely share your Utility Identifiers (Phone/Meter numbers) with licensed domestic and international third parties.</strong>
            </p>
            <ul className="list-disc pl-5 space-y-2 mb-3">
              <li><strong>Utility Aggregators:</strong> We share necessary vending data with our API partners (e.g., VTpass Global) strictly for the purpose of executing your transaction across borders.</li>
              <li><strong>Blockchain Networks:</strong> Your public wallet address and transaction amount are permanently broadcasted to the public, immutable Base or Celo blockchains.</li>
              <li><strong>AI Processing Partner:</strong> Chat messages sent to the DeAI agent are transmitted to Anthropic (Claude API) solely to interpret your request. Anthropic never receives your private keys, PIN, or any ability to sign transactions.</li>
              <li><strong>Messaging Platforms:</strong> To operate the agent, we exchange data with Telegram, Meta (WhatsApp), and X's respective bot/webhook infrastructure.</li>
              <li><strong>Law Enforcement:</strong> If compelled by a valid subpoena or directive from relevant local or international law enforcement (e.g., EFCC, SEC, or FATF-aligned agencies), we may disclose metadata to prevent cross-border financial crimes.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-black text-slate-900 dark:text-white mb-3 flex items-center gap-2">
              <UserCheck size={18} className="text-slate-400 dark:text-slate-500"/> 5. Data Security & Retention
            </h2>
            <p className="mb-3">
              Your transaction metadata and utility identifiers are stored securely on encrypted cloud servers. We implement strict access controls and API rate limiting to protect our database from unauthorized access, regardless of your geographical location.
            </p>
            <p>
              <strong>Retention:</strong> We retain your transaction history for a minimum of five (5) years as required by international financial compliance regulations, after which it may be anonymized or securely deleted.
            </p>
          </section>

          <section className="bg-red-50 dark:bg-red-900/10 p-6 rounded-2xl border border-red-100 dark:border-red-900/30 transition-colors">
            <h2 className="text-lg font-black text-red-900 dark:text-red-400 mb-3 flex items-center gap-2">
              <Trash2 size={18} className="text-red-600 dark:text-red-500"/> 6. Your Privacy Rights & Data Deletion
            </h2>
            <p className="mb-3 text-red-800 dark:text-red-300">
              Under the NDPA 2023 and equivalent global privacy laws, you possess the right to access, rectify, and request the erasure of your personal data. 
            </p>
            <p className="mb-3 text-red-800 dark:text-red-300">
              <strong>Account & Data Deletion Request:</strong> If you wish to permanently delete your transaction history and associated utility data from the AbaPay servers, you may submit a formal Data Deletion Request. 
            </p>
            <p className="text-red-800 dark:text-red-300 font-bold mb-3">
              To request deletion, please email <a href="mailto:privacy@abapays.com" className="underline hover:text-red-600 dark:hover:text-red-400 transition-colors">privacy@abapays.com</a> with your connected Wallet Address. We will process your deletion request within 30 days, subject to mandatory global AML retention laws.
            </p>
            <p className="text-red-800 dark:text-red-300">
              <strong>Unlinking a Messaging Account or Revoking Agent Access:</strong> You can unlink your Telegram, WhatsApp, or X account from your wallet, or revoke the DeAI agent's on-chain spending allowance, at any time from the Agent Hub in the App — no email required. Revoking the allowance takes effect on-chain immediately.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-black text-slate-900 dark:text-white mb-3 flex items-center gap-2">
              <Mail size={18} className="text-slate-400 dark:text-slate-500"/> 7. Contact Our Data Protection Officer (DPO)
            </h2>
            <p>
              If you have any questions, complaints, or require clarification regarding how MASONODE TECHNOLOGIES LIMITED handles your international data, please contact our support team and Data Protection Officer at:
            </p>
            <div className="mt-3 bg-slate-100 dark:bg-[#1a1a1f] p-4 rounded-xl inline-block transition-colors">
              <p className="font-bold text-slate-800 dark:text-slate-200">Email: <a href="mailto:support@abapays.com" className="text-emerald-600 dark:text-emerald-400 hover:underline">support@abapays.com</a></p>
            </div>
          </section>

        </div>

        {/* FOOTER */}
        <div className="mt-12 pt-8 border-t border-slate-100 dark:border-slate-800/60 text-center transition-colors">
          <Link href="/">
            <button className="bg-slate-900 dark:bg-white hover:bg-black dark:hover:bg-slate-200 text-white dark:text-slate-900 px-6 py-3 rounded-xl font-black text-sm transition-all shadow-md hover:shadow-xl active:scale-95 shadow-slate-900/20 dark:shadow-white/10">
              Return to AbaPay
            </button>
          </Link>
        </div>

      </div>
    </main>
  );
}
