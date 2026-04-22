import Link from "next/link";
import { ShieldCheck, Scale, AlertTriangle, FileText, Globe } from "lucide-react";

export default function TermsOfService() {
  return (
    <main className="min-h-screen bg-slate-50 text-slate-900 font-sans p-4 sm:p-8 flex flex-col items-center pb-20">
      <div className="w-full max-w-4xl bg-white border border-slate-200 rounded-[2.5rem] p-8 sm:p-12 shadow-xl shadow-slate-200/50">

        {/* HEADER SECTION */}
        <div className="border-b border-slate-100 pb-8 mb-8 text-center sm:text-left flex flex-col sm:flex-row items-center sm:items-start justify-between gap-4">
          <div>
            <div className="flex items-center justify-center sm:justify-start gap-3 mb-2">
              <ShieldCheck className="text-emerald-500" size={32} />
              <h1 className="text-3xl font-black text-slate-900 tracking-tight">Terms of Service</h1>
            </div>
            <p className="text-sm font-bold text-slate-400 uppercase tracking-widest">AbaPay Global Web3 Protocol</p>
          </div>
          <div className="text-right">
            <p className="text-xs font-bold text-slate-500 bg-slate-100 px-3 py-1.5 rounded-lg inline-block">
              Effective Date: April 2026
            </p>
          </div>
        </div>

        {/* CONTENT SECTION */}
        <div className="space-y-8 text-sm sm:text-base text-slate-600 leading-relaxed font-medium">

          <section className="bg-emerald-50/50 p-6 rounded-2xl border border-emerald-100">
            <h2 className="text-lg font-black text-slate-900 mb-3 flex items-center gap-2">
              <Globe size={18} className="text-emerald-500"/> 1. Introduction & Global Acceptance
            </h2>
            <p className="mb-3">
              Welcome to AbaPay. These Terms of Service ("Terms") constitute a legally binding agreement between you ("User", "you", or "your") and <strong>MASONODE TECHNOLOGIES LIMITED</strong> ("Company", "we", "us", or "our"), a company duly registered under the Corporate Affairs Commission (CAC) of the Federal Republic of Nigeria, operating globally.
            </p>
            <p>
              By accessing or using the AbaPay decentralized application (the "App") to process local or cross-border crypto-to-utility payments, you explicitly agree to be bound by these Terms, our Privacy Policy, and all applicable domestic and international laws governing your jurisdiction.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-black text-slate-900 mb-3">2. Nature of Services</h2>
            <p className="mb-3">
              AbaPay operates strictly as a <strong>Technology Interface and Borderless Digital Intermediary</strong>. We provide a non-custodial software protocol that allows users to interact with smart contracts on the Celo Blockchain to exchange digital assets (such as cUSD or USDT) for fiat-denominated utility services (Airtime, Data, Electricity, and Bank Transfers) across Nigeria and supported international countries.
            </p>
            <p>
              <strong>We are not a bank.</strong> We do not hold fiat currency deposits. All fiat utility vending is processed through licensed domestic and international Third-Party Aggregators (e.g., VTpass) and regulated Payment Solution Service Providers across our active geographic regions.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-black text-slate-900 mb-3">3. Anti-Money Laundering (AML) & Compliance</h2>
            <p className="mb-3">
              To comply with the Special Control Unit Against Money Laundering (SCUML), the Securities and Exchange Commission (SEC) of Nigeria, and international Financial Action Task Force (FATF) guidelines, AbaPay reserves the right to monitor transactions for illicit activities. 
            </p>
            <p>
              You agree not to use AbaPay for cross-border terrorism financing, money laundering, fraud, or any illegal activity. We reserve the right to freeze transactions, block wallet addresses, and report suspicious activities to Nigerian and international law enforcement agencies without prior notice.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-black text-slate-900 mb-3 flex items-center gap-2">
              <AlertTriangle size={18} className="text-orange-500"/> 4. Blockchain Irreversibility & User Responsibility
            </h2>
            <ul className="list-disc pl-5 space-y-2">
              <li><strong>Irreversible Transactions:</strong> Blockchain transactions are inherently immutable. Once you confirm a payment via your Web3 wallet, the digital assets cannot be recovered by AbaPay.</li>
              <li><strong>Accuracy of Information:</strong> You are 100% responsible for ensuring the accuracy of the destination country code, phone number, meter number, or bank account. AbaPay is not liable for funds sent to incorrect accounts or foreign destinations due to user typographical errors.</li>
              <li><strong>Self-Custody:</strong> AbaPay does not have access to your private keys. You are solely responsible for the security of your Web3 wallet.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-black text-slate-900 mb-3">5. Exchange Rates, Fees, and Taxes</h2>
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
            <h2 className="text-lg font-black text-slate-900 mb-3">6. Third-Party Services & Limitation of Liability</h2>
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

          <section>
            <h2 className="text-lg font-black text-slate-900 mb-3">7. Refunds and Reversals</h2>
            <p>
              If your Web3 transaction is successfully confirmed but the Third-Party utility provider fails to deliver the service (e.g., failed token generation or foreign network rejection), AbaPay will automatically flag the transaction. Upon verification of the failure, AbaPay will issue a refund in the original stablecoin asset (less blockchain gas fees) to your connected wallet within 24 to 72 hours.
            </p>
          </section>

          <section className="bg-slate-100 p-6 rounded-2xl">
            <h2 className="text-lg font-black text-slate-900 mb-3 flex items-center gap-2">
              <Scale size={18} className="text-slate-700"/> 8. Governing Law & Dispute Resolution
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
        <div className="mt-12 pt-8 border-t border-slate-100 text-center">
          <p className="text-xs font-bold text-slate-400 mb-4">
            If you have any questions regarding these Terms, please contact us at support@abapay.com
          </p>
          <Link href="/">
            <button className="bg-slate-900 hover:bg-black text-white px-6 py-3 rounded-xl font-black text-sm transition-all shadow-md hover:shadow-xl active:scale-95 flex items-center gap-2 mx-auto">
              Return to AbaPay
            </button>
          </Link>
        </div>

      </div>
    </main>
  );
}
