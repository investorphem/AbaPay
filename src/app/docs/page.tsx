"use client";

import { useState } from "react";
import Link from "next/link";
import { 
  ArrowLeft, ShieldCheck, Zap, Globe, 
  Lock, Wallet, RefreshCw, ChevronDown, BookOpen
} from "lucide-react";

export default function DocsPage() {
  return (
    <main className="min-h-screen bg-slate-50 text-slate-900 font-sans p-4 flex flex-col items-center pb-20">
      <div className="w-full max-w-2xl">
        
        {/* HEADER */}
        <div className="flex items-center justify-between bg-white p-4 rounded-3xl shadow-sm border border-slate-100 mb-6 sticky top-4 z-10">
          <Link href="/" className="flex items-center gap-2 text-slate-500 hover:text-emerald-600 transition-colors bg-slate-50 p-2 rounded-xl">
            <ArrowLeft size={18} />
          </Link>
          <div className="flex items-center gap-3">
            <BookOpen className="text-emerald-500" size={24} />
            <h1 className="text-xl font-black text-slate-900 tracking-tight">AbaPay <span className="text-slate-400 font-light">DOCS</span></h1>
          </div>
          <div className="w-10"></div> {/* Spacer for alignment */}
        </div>

        <div className="space-y-6">
          
          {/* THE VISION */}
          <section className="bg-white border border-slate-100 rounded-[2.5rem] p-8 shadow-sm animate-in fade-in zoom-in-95">
            <div className="bg-emerald-50 w-14 h-14 rounded-2xl flex items-center justify-center mb-6 border border-emerald-100">
              <Globe className="text-emerald-500" size={28} />
            </div>
            <h2 className="text-2xl font-black mb-4 tracking-tight">The Vision: Real-World Utility</h2>
            <p className="text-slate-600 leading-relaxed font-medium">
              AbaPay is a decentralized payment gateway designed to bridge the gap between global Web3 liquidity and local African utility systems. 
              Traditional utility apps require you to deposit fiat and trust centralized servers. AbaPay reimagines this by allowing users to pay for real-world bills—Electricity, Data, Airtime, Cable TV, and Education PINs—directly from their self-custodial wallets using stablecoins, settled in seconds on the blockchain.
            </p>
          </section>

          {/* THE DIFFERENCE */}
          <section className="bg-white border border-slate-100 rounded-[2.5rem] p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4">
            <h2 className="text-xl font-black mb-6 tracking-tight flex items-center gap-2">
              <Zap className="text-emerald-500" size={20} /> The AbaPay Difference
            </h2>
            <div className="space-y-6">
              <FeatureBlock 
                icon={<Wallet />} title="No Deposits. No Fiat Wallets." 
                desc="You never have to 'fund' an AbaPay account. Your money stays securely in your own wallet (MetaMask, Trust Wallet, etc.) until the exact moment you pay a bill."
              />
              <FeatureBlock 
                icon={<Lock />} title="Smart Contract Escrow" 
                desc="Your crypto isn't blindly sent to an admin. It is locked in our secure Smart Contract on the Celo network. The contract only releases the funds to our treasury after the local utility provider confirms the transaction."
              />
              <FeatureBlock 
                icon={<Globe />} title="Borderless Payments" 
                desc="You do not need a Nigerian bank account to pay bills in Nigeria. Whether you are in Lagos, London, or Los Angeles, as long as you have stablecoins on a supported network, you can vend utilities instantly."
              />
            </div>
          </section>

          {/* SECURITY & FAILSAFES */}
          <section className="bg-white border border-slate-100 rounded-[2.5rem] p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4">
             <h2 className="text-xl font-black mb-6 tracking-tight flex items-center gap-2">
              <ShieldCheck className="text-blue-500" size={20} /> Security & Failsafes
            </h2>
            <p className="text-slate-600 font-medium mb-6">
              African utility networks can occasionally experience downtime. AbaPay is built with <strong className="text-slate-900">Defensive Programming</strong> to ensure you never lose money to a dropped connection.
            </p>
            <ul className="space-y-4">
              <li className="bg-slate-50 p-4 rounded-2xl border border-slate-100">
                <strong className="block text-sm font-black text-slate-800 mb-1">Strict Token Requirements</strong>
                <span className="text-sm text-slate-600">If a provider claims "Success" but fails to generate your 20-digit Electricity Token, our system refuses to accept it. Your transaction goes into a PENDING state while our Requery Engine safely hunts down your token.</span>
              </li>
              <li className="bg-slate-50 p-4 rounded-2xl border border-slate-100">
                <strong className="block text-sm font-black text-slate-800 mb-1">Rate Mismatch Protection</strong>
                <span className="text-sm text-slate-600">Our platform locks in your exchange rate at the moment of the transaction. If you underpay due to slippage, the smart contract instantly reverts the transaction to protect your funds.</span>
              </li>
              <li className="bg-slate-50 p-4 rounded-2xl border border-slate-100">
                <strong className="block text-sm font-black text-slate-800 mb-1">Guaranteed Auto-Refunds</strong>
                <span className="text-sm text-slate-600">If a utility provider is completely offline and rejects the payment, your transaction is FAILED. Because funds are held in escrow, you become immediately eligible for a crypto refund.</span>
              </li>
            </ul>
          </section>

          {/* FAQ */}
          <section className="bg-white border border-slate-100 rounded-[2.5rem] p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4">
            <h2 className="text-xl font-black mb-6 tracking-tight">Frequently Asked Questions</h2>
            <div className="space-y-3">
              <FAQItem q="What cryptocurrencies do you accept?" a="Currently, AbaPay supports major stablecoins designed for everyday commerce. We accept USD₮ (Tether), USDC, and cUSD natively." />
              <FAQItem q="Which blockchain networks are supported?" a="AbaPay is currently live on the Celo Network, chosen for its blazing-fast transaction speeds, sub-cent gas fees, and mobile-first architecture." />
              <FAQItem q="Do you charge hidden fees?" a="No. The live Crypto-to-Naira exchange rate is openly displayed. Certain complex utilities (like Electricity Meter Verification or Education PINs) carry a flat ₦100 network fee, which is explicitly shown in your total before you pay." />
              <FAQItem q="How long does a transaction take?" a="Because we build on high-speed EVM networks, the blockchain portion confirms in roughly 3 to 5 seconds. The utility delivery typically arrives immediately after block confirmation." />
              <FAQItem q="What happens if I pay, but my electricity token isn't generated?" a="Utility networks occasionally lag. If this happens, your dashboard will display a 'Transaction Processing' badge. Our backend Requery API will continuously ping the utility provider until they generate your 20-digit token." />
              <FAQItem q="Who controls the funds?" a="You do. AbaPay is a non-custodial gateway. We do not have access to your private keys, and we cannot move your funds without you explicitly signing a transaction in your wallet." />
            </div>
          </section>

        </div>

        <footer className="mt-12 w-full pt-8 pb-4 flex flex-col items-center gap-4">
          <div className="flex items-center gap-2.5 bg-white px-4 py-1.5 rounded-full shadow-sm border border-slate-200">
             <ShieldCheck size={16} className="text-emerald-600" />
             <span className="text-[11px] font-bold text-slate-500 uppercase tracking-widest">Secured by Celo Network</span>
          </div>
          <p className="text-[9px] font-medium text-slate-400 uppercase tracking-[0.2em] mt-2">© 2026 MASONODE ORGANISATION</p>
        </footer>

      </div>
    </main>
  );
}

function FeatureBlock({ icon, title, desc }: { icon: any, title: string, desc: string }) {
  return (
    <div className="flex gap-4 items-start">
      <div className="bg-slate-50 p-3 rounded-xl border border-slate-100 text-slate-500 shrink-0">
        {icon}
      </div>
      <div>
        <h3 className="text-md font-black text-slate-900 mb-1">{title}</h3>
        <p className="text-sm text-slate-600 leading-relaxed font-medium">{desc}</p>
      </div>
    </div>
  );
}

function FAQItem({ q, a }: { q: string, a: string }) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <div className="border border-slate-100 rounded-2xl overflow-hidden bg-slate-50 transition-all">
      <button 
        onClick={() => setIsOpen(!isOpen)} 
        className="w-full text-left p-4 flex justify-between items-center hover:bg-slate-100 transition-colors"
      >
        <span className="font-bold text-sm text-slate-800 pr-4">{q}</span>
        <ChevronDown size={18} className={`text-slate-400 transition-transform duration-300 shrink-0 ${isOpen ? 'rotate-180' : ''}`} />
      </button>
      <div className={`overflow-hidden transition-all duration-300 ease-in-out ${isOpen ? 'max-h-48 opacity-100' : 'max-h-0 opacity-0'}`}>
        <p className="p-4 pt-0 text-sm text-slate-600 leading-relaxed font-medium">
          {a}
        </p>
      </div>
    </div>
  );
}
