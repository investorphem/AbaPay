"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import AppFooter from "@/components/AppFooter";
import { 
  ArrowLeft, ShieldCheck, Zap, Globe, 
  Lock, Wallet, ChevronDown, BookOpen,
  Star, Gift, Smartphone, Share2, HelpCircle
} from "lucide-react";

export default function DocsPage() {
  const { address, chain: activeChain } = useAccount();

  // ⚡ DYNAMIC NETWORK TEXT — mirrors the main page footer logic
  const activeNetworkDisplay = useMemo(() => {
    if (!address) return "Base & Celo";
    if (activeChain?.name?.toLowerCase().includes("base")) return "Base";
    if (activeChain?.name?.toLowerCase().includes("celo")) return "Celo";
    return activeChain?.name || "Base & Celo";
  }, [address, activeChain]);

  return (
    <main className="min-h-screen bg-slate-50 dark:bg-black text-slate-900 dark:text-slate-100 font-sans p-4 flex flex-col items-center pb-20 transition-colors">
      <div className="w-full max-w-2xl">

        {/* HEADER */}
        <div className="flex items-center justify-between bg-white dark:bg-[#111114] p-4 rounded-3xl shadow-sm border border-slate-100 dark:border-slate-800/60 mb-6 sticky top-4 z-10 transition-colors">
          <Link href="/" className="flex items-center gap-2 text-slate-500 dark:text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors bg-slate-50 dark:bg-[#1a1a1f] p-2 rounded-xl border border-transparent dark:border-slate-800/50">
            <ArrowLeft size={18} />
          </Link>
          <div className="flex items-center gap-3">
            <BookOpen className="text-emerald-500" size={24} />
            <h1 className="text-xl font-black text-slate-900 dark:text-white tracking-tight">AbaPay <span className="text-slate-400 dark:text-slate-500 font-light">DOCS</span></h1>
          </div>
          <div className="w-10"></div> {/* Spacer for alignment */}
        </div>

        <div className="space-y-6">

          {/* THE VISION */}
          <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2.5rem] p-8 shadow-sm animate-in fade-in zoom-in-95 transition-colors">
            <div className="bg-emerald-50 dark:bg-emerald-900/20 w-14 h-14 rounded-2xl flex items-center justify-center mb-6 border border-emerald-100 dark:border-emerald-800/50 transition-colors">
              <Globe className="text-emerald-500" size={28} />
            </div>
            <h2 className="text-2xl font-black mb-4 tracking-tight text-slate-900 dark:text-white">The Vision: Global Web3 Utility</h2>
            <p className="text-slate-600 dark:text-slate-300 leading-relaxed font-medium">
              AbaPay is a decentralized payment gateway designed to bridge the gap between global Web3 liquidity and real-world utility systems across Africa and the globe. 
              Traditional utility apps require you to deposit local fiat and trust centralized servers. AbaPay reimagines this by allowing users to pay for real-world bills—International Airtime/Data, domestic Electricity, Cable TV, and Bank Transfers—directly from their self-custodial wallets using stablecoins, settled in seconds on the blockchain.
            </p>
          </section>

          {/* THE DIFFERENCE */}
          <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2.5rem] p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4 transition-colors">
            <h2 className="text-xl font-black mb-6 tracking-tight flex items-center gap-2 text-slate-900 dark:text-white">
              <Zap className="text-emerald-500" size={20} /> The AbaPay Difference
            </h2>
            <div className="space-y-6">
              <FeatureBlock 
                icon={<Wallet />} title="No Deposits. No Fiat Wallets." 
                desc="You never have to 'fund' an AbaPay account. Your money stays securely in your own wallet (MetaMask, MiniPay, Coinbase Smart Wallet, etc.) until the exact moment you pay a bill."
              />
              <FeatureBlock 
                icon={<Lock />} title="Smart Contract Escrow" 
                desc="Your crypto isn't blindly sent to an admin. It is locked in our secure Smart Contracts on the Base and Celo networks. The contract only releases the funds to our treasury after the utility provider confirms the transaction."
              />
              <FeatureBlock 
                icon={<Globe />} title="Borderless Payments" 
                desc="You do not need a local bank account to pay bills in supported countries. Whether you are in Lagos, London, or Los Angeles, as long as you have stablecoins, you can top-up phones in Ghana, pay electricity in Nigeria, or send data to Kenya instantly."
              />
            </div>
          </section>

          {/* ABAPOINTS & REWARDS */}
          <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2.5rem] p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4 transition-colors">
            <h2 className="text-xl font-black mb-6 tracking-tight flex items-center gap-2 text-slate-900 dark:text-white">
              <Star className="text-purple-500" size={20} /> AbaPoints & Rewards
            </h2>
            <p className="text-slate-600 dark:text-slate-300 font-medium mb-6 leading-relaxed">
              AbaPoints (⚡) are our way of rewarding loyal users. You can see your live AbaPoints balance glowing in the top right corner of the app, directly in the header.
            </p>

            <div className="bg-purple-50 dark:bg-purple-900/20 border border-purple-100 dark:border-purple-800/50 p-6 rounded-3xl mb-6 transition-colors">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
                <h3 className="text-sm font-black text-purple-900 dark:text-purple-100 uppercase tracking-widest">Global Earning Ratio</h3>
                <p className="text-lg sm:text-2xl font-black text-emerald-600 dark:text-emerald-400 bg-white dark:bg-[#111114] px-4 py-2 rounded-2xl shadow-sm border border-purple-100 dark:border-purple-800/50 transition-colors">1 Stablecoin = <span className="text-purple-600 dark:text-purple-400">1.00 Point</span></p>
              </div>
              <p className="text-sm text-purple-800 dark:text-purple-300 font-medium leading-relaxed">
                AbaPoints are globally pegged to the stablecoin (cUSD, USDC, USDT) value of your utility purchase. Spend exactly 5.50 USDC on a utility bill? You earn exactly 5.50 points instantly. This ensures your rewards are completely protected against local fiat currency inflation!
              </p>
            </div>

            <div className="bg-slate-50 dark:bg-[#1a1a1f] border border-slate-100 dark:border-slate-800/80 p-5 rounded-2xl flex items-start gap-4 transition-colors">
              <Gift className="text-purple-500 shrink-0 mt-0.5" size={20} />
              <div>
                 <h4 className="text-sm font-black text-slate-900 dark:text-white">Future Utility Plans</h4>
                 <p className="text-sm text-slate-600 dark:text-slate-400 mt-1 leading-relaxed font-medium">
                   Keep stacking your points! In future updates, you will be able to redeem AbaPoints for free Airtime/Data, use them to cover transaction fees, or qualify for exclusive ecosystem airdrops.
                 </p>
              </div>
            </div>
          </section>

          {/* MANAGING BENEFICIARIES */}
          <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2.5rem] p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4 transition-colors">
             <h2 className="text-xl font-black mb-6 tracking-tight flex items-center gap-2 text-slate-900 dark:text-white">
              <Smartphone className="text-blue-500" size={20} /> Saved Beneficiaries (Recents)
            </h2>
            <p className="text-slate-600 dark:text-slate-300 font-medium mb-6 leading-relaxed">
               Typing the same meter number or international phone number every time is stressful. AbaPay automatically saves your successful transactions as "Recent" shortcuts right below the input field.
            </p>

            <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800/50 p-6 rounded-3xl transition-colors">
               <h4 className="text-sm font-black text-blue-900 dark:text-blue-100 mb-3">How to Delete a Saved Number</h4>
               <p className="text-sm text-blue-800 dark:text-blue-300 font-medium leading-relaxed mb-4">
                 Did you save a number by mistake or no longer need it? You can easily remove it from your recents list:
               </p>
               <div className="flex flex-col gap-3">
                  <div className="flex items-center gap-4 text-sm text-blue-900 dark:text-blue-100 font-medium bg-white dark:bg-[#111114] px-5 py-4 rounded-2xl border border-blue-100 dark:border-blue-800/50 shadow-sm transition-colors">
                     <span className="bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-400 font-black w-6 h-6 flex items-center justify-center rounded-full shrink-0 transition-colors">1</span>
                     <p><strong>Press and hold</strong> (Long-press) on the saved name/number pill for 1 second.</p>
                  </div>
                  <div className="flex items-center gap-4 text-sm text-blue-900 dark:text-blue-100 font-medium bg-white dark:bg-[#111114] px-5 py-4 rounded-2xl border border-blue-100 dark:border-blue-800/50 shadow-sm transition-colors">
                     <span className="bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-400 font-black w-6 h-6 flex items-center justify-center rounded-full shrink-0 transition-colors">2</span>
                     <p>The pill will turn red and say "Delete". Click it to remove it forever!</p>
                  </div>
               </div>
            </div>
          </section>

          {/* RECEIPTS & SUPPORT */}
          <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2.5rem] p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4 transition-colors">
             <h2 className="text-xl font-black mb-6 tracking-tight flex items-center gap-2 text-slate-900 dark:text-white">
              <Share2 className="text-orange-500" size={20} /> Receipts & Support
            </h2>
            <div className="space-y-4">
              <div className="bg-slate-50 dark:bg-[#1a1a1f] p-5 rounded-3xl border border-slate-100 dark:border-slate-800/80 transition-colors">
                <h4 className="text-sm font-black text-slate-800 dark:text-slate-200 mb-2">Sharing Your Receipt</h4>
                <p className="text-sm text-slate-600 dark:text-slate-400 font-medium leading-relaxed">
                  Click the dark "SHARE" button at the bottom of any successful transaction receipt. AbaPay will automatically generate a beautiful, clean image of your receipt that you can send directly to WhatsApp, Telegram, or save to your phone's gallery.
                </p>
                <p className="text-[11px] font-bold text-slate-400 dark:text-slate-500 mt-3 uppercase tracking-wider">
                  Note: The dopamine "+AbaPoints" animation happens on the app screen to celebrate your purchase, but it is intentionally hidden from the final receipt image so your receipts look professional when shared.
                </p>
              </div>

              <div className="bg-orange-50 dark:bg-orange-900/20 p-5 rounded-3xl border border-orange-100 dark:border-orange-800/50 flex items-start gap-4 transition-colors">
                <HelpCircle className="text-orange-500 shrink-0 mt-0.5" size={20} />
                <div>
                   <h4 className="text-sm font-black text-orange-900 dark:text-orange-100 mb-1">In-App Support System</h4>
                   <p className="text-sm text-orange-800 dark:text-orange-300 font-medium leading-relaxed">
                     Did a transaction fail or is a token delayed? Click the "Support" button on any receipt to instantly send a ticket, complete with your transaction hash, directly to our admin ops center.
                   </p>
                </div>
              </div>
            </div>
          </section>

          {/* SECURITY & FAILSAFES */}
          <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2.5rem] p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4 transition-colors">
             <h2 className="text-xl font-black mb-6 tracking-tight flex items-center gap-2 text-slate-900 dark:text-white">
              <ShieldCheck className="text-emerald-500" size={20} /> Security & Failsafes
            </h2>
            <p className="text-slate-600 dark:text-slate-300 font-medium mb-6">
              Domestic and international utility networks can occasionally experience downtime. AbaPay is built with <strong className="text-slate-900 dark:text-white">Defensive Programming</strong> to ensure you never lose money to a dropped connection.
            </p>
            <ul className="space-y-4">
              <li className="bg-slate-50 dark:bg-[#1a1a1f] p-5 rounded-2xl border border-slate-100 dark:border-slate-800/80 transition-colors">
                <strong className="block text-sm font-black text-slate-800 dark:text-slate-200 mb-1">Strict Token Requirements</strong>
                <span className="text-sm text-slate-600 dark:text-slate-400 font-medium leading-relaxed">If a provider claims "Success" but fails to generate your Electricity Token or Airtime PIN, our system refuses to accept it. Your transaction goes into a PENDING state while our background webhook safely hunts down your token.</span>
              </li>
              <li className="bg-slate-50 dark:bg-[#1a1a1f] p-5 rounded-2xl border border-slate-100 dark:border-slate-800/80 transition-colors">
                <strong className="block text-sm font-black text-slate-800 dark:text-slate-200 mb-1">Deep On-Chain Payload Decoding</strong>
                <span className="text-sm text-slate-600 dark:text-slate-400 font-medium leading-relaxed">Our API does not trust front-end claims. It directly fetches your blockchain transaction and decodes the smart contract data to verify the exact amount and service you paid for before vending.</span>
              </li>
              <li className="bg-slate-50 dark:bg-[#1a1a1f] p-5 rounded-2xl border border-slate-100 dark:border-slate-800/80 transition-colors">
                <strong className="block text-sm font-black text-slate-800 dark:text-slate-200 mb-1">Preflight Intent Recovery</strong>
                <span className="text-sm text-slate-600 dark:text-slate-400 font-medium leading-relaxed">If your mobile app crashes or your network drops immediately after signing the transaction in your wallet, your funds are not lost. The system actively scans the blockchain to recover your "abandoned" preflight intent and completes the vending in the background.</span>
              </li>
            </ul>
          </section>

          {/* FAQ */}
          <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2.5rem] p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4 transition-colors">
            <h2 className="text-xl font-black mb-6 tracking-tight text-slate-900 dark:text-white">Frequently Asked Questions</h2>
            <div className="space-y-3">
              <FAQItem q="Which countries do you support?" a="We support comprehensive utility payments (Electricity, Transfers, Cable TV, Education) in Nigeria, and Mobile Airtime/Data top-ups across over 120 international countries including Ghana, Kenya, South Africa, the US, and the UK." />
              <FAQItem q="What cryptocurrencies do you accept?" a="Currently, AbaPay supports major stablecoins designed for everyday commerce. We accept USD₮ (Tether), USDC, and cUSD natively." />
              <FAQItem q="Which blockchain networks are supported?" a="AbaPay is a multi-chain protocol! We are natively live on the Base Network (for deep Coinbase smart wallet integration) and the Celo Network (chosen for its blazing-fast speeds and mobile-first architecture)." />
              <FAQItem q="Do you charge hidden fees?" a="No. The live Crypto-to-Fiat exchange rate is openly displayed. Certain heavy-infrastructure utilities (like Bank Transfers or Electricity) carry a small flat processing fee, which is explicitly shown in your total before you pay. Airtime and Data are completely free of platform fees." />
              <FAQItem q="How long does a transaction take?" a="Because we build on high-speed EVM networks, the blockchain portion confirms in roughly 3 to 5 seconds. The utility delivery typically arrives immediately after block confirmation." />
              <FAQItem q="What happens if I pay, but my electricity token isn't generated?" a="Utility networks occasionally lag. If this happens, your dashboard will display a 'Transaction Processing' badge. Our backend Webhook will continuously ping the utility provider until they generate your token, and will text/email you the result." />
              <FAQItem q="Who controls the funds?" a="You do. AbaPay is a non-custodial gateway. We do not have access to your private keys, and we cannot move your funds without you explicitly signing a transaction in your wallet." />
            </div>
          </section>

        </div>

        {/* ⚡ FOOTER ⚡ */}
        <AppFooter network={activeNetworkDisplay} />

      </div>
    </main>
  );
}

function FeatureBlock({ icon, title, desc }: { icon: any, title: string, desc: string }) {
  return (
    <div className="flex gap-4 items-start">
      <div className="bg-slate-50 dark:bg-[#1a1a1f] p-3 rounded-xl border border-slate-100 dark:border-slate-800/80 text-slate-500 dark:text-slate-400 shrink-0 transition-colors">
        {icon}
      </div>
      <div>
        <h3 className="text-md font-black text-slate-900 dark:text-white mb-1">{title}</h3>
        <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed font-medium">{desc}</p>
      </div>
    </div>
  );
}

function FAQItem({ q, a }: { q: string, a: string }) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <div className="border border-slate-100 dark:border-slate-800/60 rounded-2xl overflow-hidden bg-slate-50 dark:bg-[#1a1a1f] transition-all">
      <button 
        onClick={() => setIsOpen(!isOpen)} 
        className="w-full text-left p-5 flex justify-between items-center hover:bg-slate-100 dark:hover:bg-slate-800/50 transition-colors"
      >
        <span className="font-bold text-sm text-slate-800 dark:text-slate-200 pr-4">{q}</span>
        <ChevronDown size={18} className={`text-slate-400 dark:text-slate-500 transition-transform duration-300 shrink-0 ${isOpen ? 'rotate-180' : ''}`} />
      </button>
      <div className={`overflow-hidden transition-all duration-300 ease-in-out ${isOpen ? 'max-h-48 opacity-100' : 'max-h-0 opacity-0'}`}>
        <p className="p-5 pt-0 text-sm text-slate-600 dark:text-slate-400 leading-relaxed font-medium">
          {a}
        </p>
      </div>
    </div>
  );
}
