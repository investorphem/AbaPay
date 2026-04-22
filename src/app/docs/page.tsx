"use client";

import { useState } from "react";
import Link from "next/link";
import { 
  ArrowLeft, ShieldCheck, Zap, Globe, 
  Lock, Wallet, ChevronDown, BookOpen,
  Star, Gift, Smartphone, Share2, HelpCircle,
  Send 
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
            <h2 className="text-2xl font-black mb-4 tracking-tight">The Vision: Global Web3 Utility</h2>
            <p className="text-slate-600 leading-relaxed font-medium">
              AbaPay is a decentralized payment gateway designed to bridge the gap between global Web3 liquidity and real-world utility systems across Africa and the globe. 
              Traditional utility apps require you to deposit local fiat and trust centralized servers. AbaPay reimagines this by allowing users to pay for real-world bills—International Airtime/Data, domestic Electricity, Cable TV, and Bank Transfers—directly from their self-custodial wallets using stablecoins, settled in seconds on the blockchain.
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
                desc="You never have to 'fund' an AbaPay account. Your money stays securely in your own wallet (MetaMask, MiniPay, Trust Wallet, etc.) until the exact moment you pay a bill."
              />
              <FeatureBlock 
                icon={<Lock />} title="Smart Contract Escrow" 
                desc="Your crypto isn't blindly sent to an admin. It is locked in our secure Smart Contract on the Celo network. The contract only releases the funds to our treasury after the utility provider confirms the transaction."
              />
              <FeatureBlock 
                icon={<Globe />} title="Borderless Payments" 
                desc="You do not need a local bank account to pay bills in supported countries. Whether you are in Lagos, London, or Los Angeles, as long as you have stablecoins, you can top-up phones in Ghana, pay electricity in Nigeria, or send data to Kenya instantly."
              />
            </div>
          </section>

          {/* ABAPOINTS & REWARDS */}
          <section className="bg-white border border-slate-100 rounded-[2.5rem] p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4">
            <h2 className="text-xl font-black mb-6 tracking-tight flex items-center gap-2">
              <Star className="text-purple-500" size={20} /> AbaPoints & Rewards
            </h2>
            <p className="text-slate-600 font-medium mb-6 leading-relaxed">
              AbaPoints (⚡) are our way of rewarding loyal users. You can see your live AbaPoints balance glowing in the top right corner of the app next to your region selector.
            </p>

            <div className="bg-purple-50 border border-purple-100 p-6 rounded-3xl mb-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
                <h3 className="text-sm font-black text-purple-900 uppercase tracking-widest">Earning Ratio</h3>
                <p className="text-2xl font-black text-emerald-600 bg-white px-4 py-2 rounded-2xl shadow-sm border border-purple-100">₦1,000 = <span className="text-purple-600">1.00 Point</span></p>
              </div>
              <p className="text-sm text-purple-800 font-medium">Points are calculated automatically based on your total transaction volume. Spend the equivalent of ₦500 in any currency? You earn 0.50 points instantly!</p>
            </div>

            <div className="bg-slate-50 border border-slate-100 p-5 rounded-2xl flex items-start gap-4">
              <Gift className="text-purple-500 shrink-0 mt-0.5" size={20} />
              <div>
                 <h4 className="text-sm font-black text-slate-900">Future Utility Plans</h4>
                 <p className="text-sm text-slate-600 mt-1 leading-relaxed font-medium">
                   Keep stacking your points! In future updates, you will be able to redeem AbaPoints for free Airtime/Data, use them to cover transaction fees, or qualify for exclusive ecosystem airdrops.
                 </p>
              </div>
            </div>
          </section>

          {/* MANAGING BENEFICIARIES */}
          <section className="bg-white border border-slate-100 rounded-[2.5rem] p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4">
             <h2 className="text-xl font-black mb-6 tracking-tight flex items-center gap-2">
              <Smartphone className="text-blue-500" size={20} /> Saved Beneficiaries (Recents)
            </h2>
            <p className="text-slate-600 font-medium mb-6 leading-relaxed">
               Typing the same meter number or international phone number every time is stressful. AbaPay automatically saves your successful transactions as "Recent" shortcuts right below the input field.
            </p>

            <div className="bg-blue-50 border border-blue-100 p-6 rounded-3xl">
               <h4 className="text-sm font-black text-blue-900 mb-3">How to Delete a Saved Number</h4>
               <p className="text-sm text-blue-800 font-medium leading-relaxed mb-4">
                 Did you save a number by mistake or no longer need it? You can easily remove it from your recents list:
               </p>
               <div className="flex flex-col gap-3">
                  <div className="flex items-center gap-4 text-sm text-blue-900 font-medium bg-white px-5 py-4 rounded-2xl border border-blue-100 shadow-sm">
                     <span className="bg-blue-100 text-blue-700 font-black w-6 h-6 flex items-center justify-center rounded-full shrink-0">1</span>
                     <p><strong>Press and hold</strong> (Long-press) on the saved name/number pill for 1 second.</p>
                  </div>
                  <div className="flex items-center gap-4 text-sm text-blue-900 font-medium bg-white px-5 py-4 rounded-2xl border border-blue-100 shadow-sm">
                     <span className="bg-blue-100 text-blue-700 font-black w-6 h-6 flex items-center justify-center rounded-full shrink-0">2</span>
                     <p>The pill will turn red and say "Delete". Click it to remove it forever!</p>
                  </div>
               </div>
            </div>
          </section>

          {/* RECEIPTS & SUPPORT */}
          <section className="bg-white border border-slate-100 rounded-[2.5rem] p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4">
             <h2 className="text-xl font-black mb-6 tracking-tight flex items-center gap-2">
              <Share2 className="text-orange-500" size={20} /> Receipts & Support
            </h2>
            <div className="space-y-4">
              <div className="bg-slate-50 p-5 rounded-3xl border border-slate-100">
                <h4 className="text-sm font-black text-slate-800 mb-2">Sharing Your Receipt</h4>
                <p className="text-sm text-slate-600 font-medium leading-relaxed">
                  Click the dark "SHARE" button at the bottom of any successful transaction receipt. AbaPay will automatically generate a beautiful, clean image of your receipt that you can send directly to WhatsApp, Telegram, or save to your phone's gallery.
                </p>
                <p className="text-[11px] font-bold text-slate-400 mt-3 uppercase tracking-wider">
                  Note: The dopamine "+AbaPoints" animation happens on the app screen to celebrate your purchase, but it is intentionally hidden from the final receipt image so your receipts look professional when shared.
                </p>
              </div>

              <div className="bg-orange-50 p-5 rounded-3xl border border-orange-100 flex items-start gap-4">
                <HelpCircle className="text-orange-500 shrink-0 mt-0.5" size={20} />
                <div>
                   <h4 className="text-sm font-black text-orange-900 mb-1">In-App Support System</h4>
                   <p className="text-sm text-orange-800 font-medium leading-relaxed">
                     Did a transaction fail or is a token delayed? Click the "Support" button on any receipt to instantly send a ticket, complete with your transaction hash, directly to our admin ops center.
                   </p>
                </div>
              </div>
            </div>
          </section>

          {/* SECURITY & FAILSAFES */}
          <section className="bg-white border border-slate-100 rounded-[2.5rem] p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4">
             <h2 className="text-xl font-black mb-6 tracking-tight flex items-center gap-2">
              <ShieldCheck className="text-emerald-500" size={20} /> Security & Failsafes
            </h2>
            <p className="text-slate-600 font-medium mb-6">
              Domestic and international utility networks can occasionally experience downtime. AbaPay is built with <strong className="text-slate-900">Defensive Programming</strong> to ensure you never lose money to a dropped connection.
            </p>
            <ul className="space-y-4">
              <li className="bg-slate-50 p-5 rounded-2xl border border-slate-100">
                <strong className="block text-sm font-black text-slate-800 mb-1">Strict Token Requirements</strong>
                <span className="text-sm text-slate-600 font-medium leading-relaxed">If a provider claims "Success" but fails to generate your Electricity Token or Airtime PIN, our system refuses to accept it. Your transaction goes into a PENDING state while our Requery Engine safely hunts down your token.</span>
              </li>
              <li className="bg-slate-50 p-5 rounded-2xl border border-slate-100">
                <strong className="block text-sm font-black text-slate-800 mb-1">Rate Mismatch Protection</strong>
                <span className="text-sm text-slate-600 font-medium leading-relaxed">Our platform locks in your exchange rate at the moment of the transaction. If you underpay due to crypto market slippage, the smart contract instantly reverts the transaction to protect your funds.</span>
              </li>
              <li className="bg-slate-50 p-5 rounded-2xl border border-slate-100">
                <strong className="block text-sm font-black text-slate-800 mb-1">Guaranteed Auto-Refunds</strong>
                <span className="text-sm text-slate-600 font-medium leading-relaxed">If an international telco or utility provider is completely offline and rejects the payment, your transaction is FAILED. Because funds are held in escrow, you become immediately eligible for a crypto refund.</span>
              </li>
            </ul>
          </section>

          {/* FAQ */}
          <section className="bg-white border border-slate-100 rounded-[2.5rem] p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4">
            <h2 className="text-xl font-black mb-6 tracking-tight">Frequently Asked Questions</h2>
            <div className="space-y-3">
              <FAQItem q="Which countries do you support?" a="We support comprehensive utility payments (Electricity, Transfers, Cable TV, Education) in Nigeria, and Mobile Airtime/Data top-ups across 30+ international countries including Ghana, Kenya, South Africa, the US, and the UK." />
              <FAQItem q="What cryptocurrencies do you accept?" a="Currently, AbaPay supports major stablecoins designed for everyday commerce. We accept USD₮ (Tether), USDC, and cUSD natively." />
              <FAQItem q="Which blockchain networks are supported?" a="AbaPay is currently live on the Celo Network, chosen for its blazing-fast transaction speeds, sub-cent gas fees, and mobile-first architecture." />
              <FAQItem q="Do you charge hidden fees?" a="No. The live Crypto-to-Fiat exchange rate (e.g., NGN, GHS, KES) is openly displayed. Certain heavy-infrastructure utilities (like Bank Transfers or Electricity) carry a small flat processing fee, which is explicitly shown in your total before you pay. Airtime and Data are completely free of platform fees." />
              <FAQItem q="How long does a transaction take?" a="Because we build on high-speed EVM networks, the blockchain portion confirms in roughly 3 to 5 seconds. The utility delivery typically arrives immediately after block confirmation." />
              <FAQItem q="What happens if I pay, but my electricity token isn't generated?" a="Utility networks occasionally lag. If this happens, your dashboard will display a 'Transaction Processing' badge. Our backend Requery API will continuously ping the utility provider until they generate your token." />
              <FAQItem q="Who controls the funds?" a="You do. AbaPay is a non-custodial gateway. We do not have access to your private keys, and we cannot move your funds without you explicitly signing a transaction in your wallet." />
            </div>
          </section>

        </div>

        {/* ⚡ FOOTER WITH NATIVE SVG TWITTER ICON ⚡ */}
        <footer className="mt-12 w-full pt-8 pb-4 flex flex-col items-center gap-4">

          <div className="flex items-center gap-4 mb-2">
            <a 
              href="https://x.com/AbaPays" 
              target="_blank" 
              rel="noopener noreferrer" 
              className="w-12 h-12 rounded-full border-2 border-slate-200 bg-white flex items-center justify-center text-slate-500 hover:text-emerald-600 hover:border-emerald-200 hover:bg-emerald-50 transition-all shadow-sm group"
            >
              {/* ⚡ Native SVG Twitter/X Replacement ⚡ */}
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="group-hover:scale-110 transition-transform">
                <path d="M22 4s-.7 2.1-2 3.4c1.6 10-9.4 17.3-18 11.6 2.2.1 4.4-.6 6-2C3 15.5.5 9.6 3 5c2.2 2.6 5.6 4.1 9 4-.9-4.2 4-6.6 7-3.8 1.1 0 3-1.2 3-1.2z"></path>
              </svg>
            </a>
            <a 
              href="https://t.me/AbaPays" 
              target="_blank" 
              rel="noopener noreferrer" 
              className="w-12 h-12 rounded-full border-2 border-slate-200 bg-white flex items-center justify-center text-slate-500 hover:text-emerald-600 hover:border-emerald-200 hover:bg-emerald-50 transition-all shadow-sm group"
            >
              <Send size={20} className="ml-[-2px] mt-[2px] group-hover:scale-110 transition-transform" /> 
            </a>
          </div>

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
        className="w-full text-left p-5 flex justify-between items-center hover:bg-slate-100 transition-colors"
      >
        <span className="font-bold text-sm text-slate-800 pr-4">{q}</span>
        <ChevronDown size={18} className={`text-slate-400 transition-transform duration-300 shrink-0 ${isOpen ? 'rotate-180' : ''}`} />
      </button>
      <div className={`overflow-hidden transition-all duration-300 ease-in-out ${isOpen ? 'max-h-48 opacity-100' : 'max-h-0 opacity-0'}`}>
        <p className="p-5 pt-0 text-sm text-slate-600 leading-relaxed font-medium">
          {a}
        </p>
      </div>
    </div>
  );
}
