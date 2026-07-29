import Link from "next/link";
import { ShieldCheck, Scale, AlertTriangle, Globe, Bot, Wallet } from "lucide-react";

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
              Effective Date: July 2026
            </p>
          </div>
        </div>

        {/* CONTENT SECTION */}
        <div className="space-y-8 text-sm sm:text-base text-slate-600 dark:text-slate-300 leading-relaxed font-medium">

          <section className="bg-emerald-50/50 dark:bg-emerald-900/10 p-6 rounded-2xl border border-emerald-100 dark:border-emerald-900/30 transition-colors">
            <h2 className="text-lg font-black text-slate-900 dark:text-white mb-3 flex items-center gap-2">
              <Globe size={18} className="text-emerald-500"/> 1. Introduction &amp; Global Acceptance
            </h2>
            <p className="mb-3">
              Welcome to AbaPay. These Terms of Service ("Terms") constitute a legally binding agreement between you ("User", "you", or "your") and <strong>MASONODE TECHNOLOGIES LIMITED</strong> ("Company", "we", "us", or "our"), a company duly registered under the Corporate Affairs Commission (CAC) of the Federal Republic of Nigeria (RC 9524980), operating globally.
            </p>
            <p>
              By accessing or using the AbaPay decentralized application (the "App") — whether through the website, an embedded wallet browser, a chat channel, or an AI agent connected to our MCP server — to process local or cross-border crypto-to-utility payments, you explicitly agree to be bound by these Terms, our <Link href="/privacy" className="underline font-bold">Privacy Policy</Link>, and all applicable domestic and international laws governing your jurisdiction.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-black text-slate-900 dark:text-white mb-3">2. Nature of Services</h2>
            <p className="mb-3">
              AbaPay operates strictly as a <strong>Technology Interface and Borderless Digital Intermediary</strong>. We provide a non-custodial software protocol that allows users to interact with smart contracts on <strong>Celo and Base</strong> (and their respective public test networks) to exchange stablecoins for fiat-denominated utility services in Nigeria, plus international airtime and data top-ups to the countries our aggregator currently covers.
            </p>
            <p className="mb-3">
              <strong>Supported assets and networks are limited to what the App offers you.</strong> Today that is USD₮ and USDC on both Celo and Base, and cUSD/USDm on Celo only. AbaPay does not support any other blockchain, and sending funds to our contract address by hand, on an unsupported network, or in an unsupported token is <em>not</em> a payment, cannot be matched to an order, and is not recoverable by us. Where an asset and network support it, settlement may occur either through a direct smart contract call or via the <strong>x402</strong> HTTP-payment protocol; this is an internal routing decision, both routes deposit funds into the same smart contract vault, and both carry identical obligations and protections under these Terms.
            </p>
            <p className="mb-3">
              <strong>The list of services and providers is not fixed.</strong> Categories currently include Airtime, Mobile Data, Electricity (prepaid and postpaid), Cable TV, Education PINs, Bank Transfers, and international airtime/data. The specific providers within each category — and the minimum and maximum amount each one accepts — are read <strong>live</strong> from our utility aggregator (VTpass) rather than from a list we maintain, and can therefore change at any time without notice or a software update. A provider that stops being purchasable simply stops appearing. Likewise, the countries available for international top-ups are read live from the aggregator's own country list; we publish no fixed count and make no representation as to which specific countries will be available at any given moment. Availability of any service, provider, country, plan or price is never guaranteed.
            </p>
            <p className="mb-3">
              <strong>Education specifically.</strong> WAEC result-checker and WAEC registration PINs are live. Our software also supports JAMB, but JAMB is <strong>not currently enabled on our merchant account</strong> with the aggregator and therefore cannot be purchased today; it does not appear in the live product list. If that changes at the aggregator's end it will become available without any action from you, but we make no commitment as to whether or when.
            </p>
            <p className="mb-3">
              <strong>Wallets and environments.</strong> AbaPay can be used with MiniPay, Valora, MetaMask, Coinbase Smart Wallet / Base Account, and any other wallet reachable over WalletConnect or injected into the browser, and it also runs as a Farcaster Mini App. Where a wallet advertises smart-account gas sponsorship on Base, the App may batch the token approval and the payment into a single sponsored transaction; wallets without that capability pay ordinary network fees. We do not control, endorse, or accept liability for any third-party wallet, and support for any particular wallet or environment may change.
            </p>
            <p className="mb-3">
              <strong>We are not a bank.</strong> We do not hold fiat currency deposits, there is no AbaPay balance to fund, and we never take custody of your wallet or your private keys. All fiat utility vending is processed through licensed domestic and international Third-Party Aggregators (e.g., VTpass) and regulated Payment Solution Service Providers across our active geographic regions.
            </p>
            <p>
              Payments may be initiated directly through the App, through our conversational AI agent ("DeAI") on Telegram, WhatsApp, X, and the in-app chat widget, or through a third-party AI agent (such as Anthropic's Claude) connected via our <strong>MCP (Model Context Protocol) server</strong> — see <strong>Section 7</strong> below for the specific terms governing agent-initiated payments across all of these. Bank transfers are deliberately excluded from the agent channels and must be completed in the App with your own wallet signature.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-black text-slate-900 dark:text-white mb-3">3. Anti-Money Laundering (AML) &amp; Compliance</h2>
            <p className="mb-3">
              To comply with the Special Control Unit Against Money Laundering (SCUML), the Securities and Exchange Commission (SEC) of Nigeria, and international Financial Action Task Force (FATF) guidelines, AbaPay reserves the right to monitor transactions for illicit activities.
            </p>
            <p>
              You agree not to use AbaPay for cross-border terrorism financing, money laundering, fraud, or any illegal activity. We reserve the right to freeze transactions, block wallet addresses, and report suspicious activities to Nigerian and international law enforcement agencies without prior notice.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-black text-slate-900 dark:text-white mb-3 flex items-center gap-2">
              <AlertTriangle size={18} className="text-orange-500"/> 4. Blockchain Irreversibility &amp; User Responsibility
            </h2>
            <ul className="list-disc pl-5 space-y-2">
              <li><strong>Irreversible Transactions:</strong> Blockchain transactions are inherently immutable. Once a payment is confirmed — whether you signed it in your wallet or it was executed within an on-chain allowance you granted — the digital assets cannot be recovered by AbaPay.</li>
              <li><strong>Accuracy of Information:</strong> You are 100% responsible for ensuring the accuracy of the destination country, phone number, meter number, smartcard/IUC number, exam profile ID, or bank account. Where the provider supports it, we verify the account with the biller and show you the returned customer name before you pay, but the final confirmation screen is yours to read. AbaPay is not liable for funds delivered to the wrong recipient because of a typographical error you approved.</li>
              <li><strong>Self-Custody:</strong> AbaPay does not have access to your private keys or recovery phrase. You are solely responsible for the security of your Web3 wallet, your device, and your AbaPay Transaction PIN.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-black text-slate-900 dark:text-white mb-3 flex items-center gap-2">
              <Wallet size={18} className="text-slate-500 dark:text-slate-400"/> 5. Exchange Rates, Fees, Limits and Taxes
            </h2>
            <p className="mb-3">
              <strong>Exchange Rates:</strong> The stablecoin-to-fiat exchange rate applied to your order is set by AbaPay and displayed to you before you pay. Foreign-currency figures shown for international top-ups are indicative and derived from third-party market data. By confirming a payment, you accept the rate displayed at that moment. AbaPay is not liable for crypto or fiat market volatility.
            </p>
            <p className="mb-3">
              <strong>Fees:</strong> AbaPay charges a flat convenience fee on certain heavy-infrastructure categories — currently Electricity, Cable TV, Education and Bank Transfers. Airtime, Data and international top-ups carry no platform fee. The fee, where it applies, is shown explicitly in your total before you confirm. Network "gas" fees charged by the underlying blockchain are separate, are paid by you to the network (not to us), and are not refundable by us under any circumstance.
            </p>
            <p className="mb-3">
              <strong>Promotional discounts:</strong> We may from time to time run discount campaigns. Any discount is applied at our discretion, is subject to per-transaction, per-wallet, per-destination and campaign-wide caps, and may be varied or withdrawn at any time. A displayed discount is an estimate until the payment is verified server-side.
            </p>
            <p className="mb-3">
              <strong>Limits:</strong> Minimum and maximum amounts are set by the biller and the aggregator, vary by network and by provider, and can change without notice. Additional caps apply to agent-initiated payments (see Section 7). A payment outside any applicable limit will be refused before any funds move.
            </p>
            <p>
              <strong>Taxes:</strong> You are solely responsible for determining any tax implications associated with your use of digital assets and paying any applicable taxes to the relevant tax authorities in your geographical jurisdiction (e.g., FIRS in Nigeria).
            </p>
          </section>

          <section>
            <h2 className="text-lg font-black text-slate-900 dark:text-white mb-3">6. Third-Party Services, Availability &amp; Limitation of Liability</h2>
            <p className="mb-3">
              AbaPay relies on external utility providers and international telecommunications networks (e.g., MTN, Airtel, Glo, 9mobile, DStv, GOtv, Startimes, Nigerian electricity distribution companies, examination bodies, and their international equivalents) and on API aggregators. We do not control them and cannot guarantee their uptime, pricing, or delivery.
            </p>
            <p className="mb-3">
              <strong>No guarantee of availability.</strong> AbaPay does not warrant uninterrupted or error-free operation. Any service, or any individual provider within a service, may be paused — by the aggregator, or by us — during an outage, dispute, or security incident. Where we have paused something, the App, the chat agents and the MCP connector all refuse the payment up front rather than accepting funds for something we know cannot be delivered.
            </p>
            <p className="mb-3">
              <strong>Limitation of Liability:</strong> To the maximum extent permitted by law, MASONODE TECHNOLOGIES LIMITED shall not be liable for:
            </p>
            <ul className="list-disc pl-5 space-y-2 mb-3">
              <li>Downtime, delays, or service failures caused by domestic or international telecommunication networks, electricity distribution companies, examination bodies, or utility aggregators.</li>
              <li>Blockchain network congestion, RPC outages, gas costs, or smart contract vulnerabilities outside our direct control.</li>
              <li>Losses arising from a wallet, device, recovery phrase, Transaction PIN, linked messaging account, or AI-agent credential that you failed to keep secure.</li>
              <li>Transactions you (or an agent acting within an allowance you granted) authorised with incorrect details.</li>
              <li>Financial losses resulting from regulatory actions by local or international governments affecting digital assets.</li>
            </ul>
          </section>

          <section className="bg-indigo-50/50 dark:bg-indigo-900/10 p-6 rounded-2xl border border-indigo-100 dark:border-indigo-900/30 transition-colors">
            <h2 className="text-lg font-black text-slate-900 dark:text-white mb-3 flex items-center gap-2">
              <Bot size={18} className="text-indigo-500"/> 7. DeAI Conversational Agent, MCP, Delegated Payments &amp; Autonomous Scheduling
            </h2>
            <p className="mb-3">
              AbaPay provides an AI-powered conversational agent ("<strong>DeAI</strong>") reachable via Telegram, WhatsApp, X, and an in-app chat widget, which lets you check balances and pay bills using natural language instead of the web interface. AbaPay also operates an <strong>MCP (Model Context Protocol) server</strong>, which lets a third-party AI agent you use directly — such as Anthropic's Claude — describe what AbaPay can do, list real purchasable plans, check your balance and pay bills on your behalf once you have connected it. By linking a messaging account, connecting an MCP client, or using DeAI in any form, you agree to the following, in addition to the rest of these Terms:
            </p>
            <ul className="list-disc pl-5 space-y-2 mb-3">
              <li><strong>Two ways the agent moves your funds:</strong> (a) a <strong>signed deep link</strong> — DeAI sends a secure, time-limited link that opens the App pre-filled, and you review and sign the transaction yourself in your own wallet, exactly as on the website; or (b) a <strong>delegated on-chain allowance</strong> — if you have explicitly granted the agent a spending allowance (via "Approve" in the Agent Hub), it may execute a payment on your behalf with no fresh wallet signature, strictly bounded by the remaining amount, stablecoin, and blockchain you approved.</li>
              <li><strong>You control the allowance, at all times.</strong> It is enforced on-chain by the smart contract itself, not by AbaPay's backend — you may lower, raise, or revoke it to zero at any time from your own wallet, and it never grants the agent access to your full wallet balance, your private keys, or any asset besides the specific one and chain you approved.</li>
              <li><strong>Your linked messaging account, connected MCP client, and Transaction PIN are your responsibility.</strong> If a third party gains access to your Telegram, WhatsApp, or X account, your authorized MCP connection, or learns your PIN, they may be able to instruct the agent to spend from your approved allowance up to its bounds. AbaPay is not liable for losses resulting from a compromised messaging account, AI agent account, device, or PIN. Treat your PIN like a banking PIN, and revoke your allowance immediately if you suspect unauthorized access. Whenever an agent payment moves funds, we send an out-of-band alert to the other channels and email address linked to your wallet so that an unauthorised spend is visible to you immediately.</li>
              <li><strong>MCP access specifically.</strong> Connecting an MCP client uses either an <strong>OAuth 2.1</strong> authorization you grant once in your browser (after which the client stays connected without re-entering credentials), or an <strong>API key</strong> you generate in the Agent Hub as the fallback for clients that cannot perform the OAuth flow. Either way, <strong>every individual payment still requires your Transaction PIN</strong> — OAuth (or a stored API key) authorizes the <em>connection</em>, never a specific spend, and a connection with no PIN can only read your balance and the public service catalogue. You may revoke an MCP API key or an OAuth authorization at any time from the Agent Hub; revocation takes effect immediately and invalidates every token issued against it.</li>
              <li><strong>Real plan data, never invented.</strong> The MCP server exposes a <code className="text-xs font-bold">list_plans</code> tool so a connected agent reads the actual, currently purchasable plans, codes and prices from our aggregator rather than guessing them. Prices and plan availability come from the aggregator and can change between the moment they are listed and the moment you pay.</li>
              <li><strong>Autonomous / Scheduled Payments.</strong> If you configure a recurring or scheduled bill payment and explicitly enable automatic execution, you authorize AbaPay's agent to execute it when due without further confirmation — bounded by the same on-chain allowance and by our per-transaction and daily caps. Schedules that you do not opt into automatic execution for are notify-only. A schedule runs at most once per due date, is re-checked against every service rule before it executes, is paused automatically after repeated failures, and may be cancelled by you at any time before it executes.</li>
              <li><strong>Operator controls.</strong> We reserve the right to pause, rate-limit, or disable services and agent-initiated payments at any time, without prior notice, for security, regulatory, or operational reasons. These controls operate at two levels — a master switch for a whole service category, and a switch for an individual provider within it — and are applied identically to the App, the chat channels, the MCP connector and the scheduler. Separately, we may disable all agent payments, disable only autonomous/scheduled execution, or lower the per-transaction and per-day ceilings on agent spending. These operator controls sit on top of your on-chain allowance and never replace it.</li>
              <li><strong>AI limitations.</strong> DeAI, and any third-party AI agent connected via MCP, uses a large language model to interpret your messages and may occasionally misread a request. You are responsible for reviewing the confirmation details (service, provider, account/meter/phone number, amount, chain, and token) presented before entering your PIN or signing — that confirmation is your final authorization.</li>
              <li><strong>Optional email receipts.</strong> You may provide an email address in chat to receive a transaction receipt; this is never required to complete a payment.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-black text-slate-900 dark:text-white mb-3">8. Refunds and Reversals</h2>
            <p className="mb-3">
              <strong>What is refundable.</strong> A refund arises in exactly one situation: your payment was confirmed on-chain and received into our vault, and the third-party utility provider then failed to deliver the service (e.g. a failed meter-token generation, a rejected top-up, or an aggregator error). If a blockchain transaction reverts or never lands, no funds ever left your wallet and there is nothing for us to refund.
            </p>
            <p className="mb-3">
              <strong>How it works.</strong> A failed delivery after funds are received is flagged and queued for refund automatically — you do not need to open a ticket to start it. You are notified straight away on the channel you used and, if you supplied one, by email; you are notified again once the refund is actually sent. The refund is paid to the same wallet address that made the payment, in the same stablecoin.
            </p>
            <p className="mb-3">
              <strong>Timing and process.</strong> Queued refunds are reviewed and released by an operator rather than paid out instantly. We target <strong>24 to 72 hours</strong>, but this is a good-faith operational target and not a contractual guarantee — a refund may take longer during an outage or an investigation. Every refund is verified against the blockchain (correct token, correct recipient, sufficient amount) before it is recorded as refunded, so a refund can never be marked as paid without actually having been paid.
            </p>
            <p>
              <strong>What is not covered.</strong> Blockchain gas fees you paid to submit the original transaction are not recoverable and are not included in the refund. Refunds are not available for a service that was delivered correctly to details you supplied incorrectly. If you believe a failure has been missed, use the Support button on the receipt — the ticket carries your transaction hash automatically.
            </p>
          </section>

          <section className="bg-slate-100 dark:bg-[#1a1a1f] p-6 rounded-2xl transition-colors">
            <h2 className="text-lg font-black text-slate-900 dark:text-white mb-3 flex items-center gap-2">
              <Scale size={18} className="text-slate-700 dark:text-slate-400"/> 9. Governing Law &amp; Dispute Resolution
            </h2>
            <p className="mb-3">
              Because MASONODE TECHNOLOGIES LIMITED is headquartered in Nigeria, these Terms shall be governed by and construed in accordance with the laws of the Federal Republic of Nigeria, without regard to international conflict of law principles.
            </p>
            <p>
              In the event of a dispute, parties shall first attempt to resolve the matter amicably through our support channels. If unresolved within 30 days, the dispute shall be subject to binding arbitration in Nigeria under the Arbitration and Mediation Act, 2023. International users expressly consent to this jurisdiction.
            </p>
          </section>

          {/* ⚠️ NOT LEGALLY REVIEWED — this notice must survive any rewrite of this page.
              See CLAUDE.md: the legal copy here has not been reviewed by a qualified lawyer,
              and saying so plainly is deliberate, not an oversight to be tidied away. */}
          <section className="bg-amber-50 dark:bg-amber-900/10 p-6 rounded-2xl border border-amber-200 dark:border-amber-900/40 transition-colors">
            <h2 className="text-lg font-black text-slate-900 dark:text-white mb-3 flex items-center gap-2">
              <AlertTriangle size={18} className="text-amber-500"/> Important notice about this document
            </h2>
            <p className="text-amber-900 dark:text-amber-200">
              This document is a <strong>good-faith, plain-language description of how AbaPay actually behaves</strong>, written by the team that builds it and checked against the product's real source code. It has <strong>not been reviewed by a qualified lawyer</strong>. It is not legal advice, it should not be treated as a complete or legally vetted statement of your rights or ours, and it should not be relied upon as such until it has been professionally reviewed. Where this document and the product's real behaviour ever disagree, please tell us at <a href="mailto:support@abapays.com" className="underline font-bold">support@abapays.com</a> — we will correct it.
            </p>
          </section>

        </div>

        {/* FOOTER */}
        <div className="mt-12 pt-8 border-t border-slate-100 dark:border-slate-800/60 text-center transition-colors">
          <p className="text-xs font-bold text-slate-400 dark:text-slate-500 mb-4">
            If you have any questions regarding these Terms, please contact us at support@abapays.com
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link href="/docs">
              <button className="bg-slate-100 dark:bg-[#1a1a1f] hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 px-6 py-3 rounded-xl font-black text-sm transition-all border border-slate-200 dark:border-slate-800 active:scale-95">
                Docs &amp; FAQ
              </button>
            </Link>
            <Link href="/">
              <button className="bg-slate-900 dark:bg-white hover:bg-black dark:hover:bg-slate-200 text-white dark:text-slate-900 px-6 py-3 rounded-xl font-black text-sm transition-all shadow-md hover:shadow-xl active:scale-95 flex items-center gap-2 mx-auto shadow-slate-900/20 dark:shadow-white/10">
                Return to AbaPay
              </button>
            </Link>
          </div>
        </div>

      </div>
    </main>
  );
}
