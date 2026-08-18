"use client";

import { useState, useMemo, type ReactNode } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import AppFooter from "@/components/AppFooter";
import {
  ArrowLeft, ShieldCheck, Zap, Globe,
  Lock, Wallet, ChevronDown, BookOpen,
  Star, Gift, Smartphone, Share2, HelpCircle,
  Bot, KeyRound, Plug, GraduationCap, CalendarClock
} from "lucide-react";

// ⚡ ONE docs + FAQ surface.
//
// There used to be two: this page's FAQ accordion, and a separate `FAQModal` opened from a
// footer button. They asked different questions, answered them differently, and drifted —
// this page still claimed "over 120 international countries", a number nothing in the code
// can substantiate (the list is read live from VTpass and we never count it), while the modal
// knew about MCP, Valora and JAMB and this page didn't. Both are merged here, every answer
// re-checked against the real code. If you change a limit, a supported wallet or chain, a
// refund path, a kill switch or a service's availability, update this page too (see CLAUDE.md).

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
            <h1 className="text-xl font-black text-slate-900 dark:text-white tracking-tight">AbaPay <span className="text-slate-400 dark:text-slate-500 font-light">DOCS &amp; FAQ</span></h1>
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
            <p className="text-slate-600 dark:text-slate-300 leading-relaxed font-medium mb-4">
              AbaPay is a decentralized payment gateway designed to bridge the gap between global Web3 liquidity and real-world utility systems across Africa and the globe.
              Traditional utility apps require you to deposit local fiat and trust centralized servers. AbaPay reimagines this by allowing users to pay for real-world bills—airtime, mobile data, electricity, cable TV, education PINs, bank transfers and international top-ups—directly from their self-custodial wallets using stablecoins, settled in seconds on the blockchain.
            </p>
            <p className="text-slate-600 dark:text-slate-300 leading-relaxed font-medium">
              There are three ways in, and they all run on the same payment engine: this app, a chat with our agent on <strong>Telegram, WhatsApp or X</strong>, or an <strong>AI assistant connected over MCP</strong>. Whichever you use, the rules, the limits, the refund path and the on-chain guarantees are identical.
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
                desc="You never have to 'fund' an AbaPay account — there is no AbaPay balance. Your money stays in your own wallet (MiniPay, Valora, MetaMask, Coinbase Smart Wallet / Base Account, or any WalletConnect wallet) until the exact moment you pay a bill."
              />
              <FeatureBlock
                icon={<Lock />} title="Smart Contract Escrow"
                desc="Your crypto isn't blindly sent to an admin. It is locked in our smart contracts on the Celo and Base networks. The contract only releases the funds to our treasury after the utility provider confirms the transaction."
              />
              <FeatureBlock
                icon={<Globe />} title="Borderless Payments"
                desc="You do not need a local bank account to pay bills in supported countries. Whether you are in Lagos, London, or Los Angeles, as long as you have stablecoins, you can pay Nigerian bills or top up phones abroad across 170+ supported countries, instantly."
              />
              <FeatureBlock
                icon={<Plug />} title="Live Provider Catalogue"
                desc="Providers, plans and their amount limits are read live from our payment provider rather than a list we maintain by hand — so the app only ever offers what can genuinely be bought right now, and a provider that goes offline simply disappears instead of failing after you've paid."
              />
            </div>
          </section>

          {/* DEAI CONVERSATIONAL AGENT */}
          <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2.5rem] p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4 transition-colors">
            <h2 className="text-xl font-black mb-6 tracking-tight flex items-center gap-2 text-slate-900 dark:text-white">
              <Bot className="text-indigo-500" size={20} /> DeAI — Pay Bills by Chat
            </h2>
            <p className="text-slate-600 dark:text-slate-300 font-medium mb-6 leading-relaxed">
              DeAI is AbaPay's conversational agent — talk to it on <strong>Telegram, WhatsApp, X (Twitter)</strong>, or the in-app chat widget, and it handles the rest. No menus to memorize: just say what you want, like <em>"top up my 08012345678 with 500 naira"</em> or reply <em>"Celo"</em> and <em>"usdt"</em> instead of hunting for a numbered option.
            </p>
            <div className="space-y-4">
              <div className="bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-100 dark:border-indigo-800/50 p-5 rounded-2xl transition-colors">
                <h4 className="text-sm font-black text-indigo-900 dark:text-indigo-100 mb-1">Two Ways to Pay</h4>
                <p className="text-sm text-indigo-800 dark:text-indigo-300 font-medium leading-relaxed">
                  If you've approved a spending allowance for a chain and stablecoin (see Agent Hub below), the agent pays instantly with no wallet signature needed. If you haven't, it sends you a secure, one-tap link to review and sign the payment yourself — same verified pipeline as the website either way.
                </p>
              </div>
              <div className="bg-slate-50 dark:bg-[#1a1a1f] p-5 rounded-2xl border border-slate-100 dark:border-slate-800/80 transition-colors">
                <h4 className="text-sm font-black text-slate-800 dark:text-slate-200 mb-1">See Your Balance &amp; Limit Before You Choose</h4>
                <p className="text-sm text-slate-600 dark:text-slate-400 font-medium leading-relaxed">
                  When the agent asks which stablecoin to use, it shows the live wallet balance <em>and</em> your remaining approved agent limit for every option on that chain — so you're never picking blind.
                </p>
              </div>
              <div className="bg-slate-50 dark:bg-[#1a1a1f] p-5 rounded-2xl border border-slate-100 dark:border-slate-800/80 transition-colors">
                <h4 className="text-sm font-black text-slate-800 dark:text-slate-200 mb-1">Never Left Hanging</h4>
                <p className="text-sm text-slate-600 dark:text-slate-400 font-medium leading-relaxed">
                  Abandon a chat mid-payment and nothing is left dangling — the intent is cleaned up automatically. If a network hiccup happens right after you enter your PIN, the agent tracks the payment through to a confirmed on-chain result before ever telling you it failed, so you're never double-charged or left unsure.
                </p>
              </div>
            </div>
          </section>

          {/* MCP — AI AGENT CONNECTOR */}
          <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2.5rem] p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4 transition-colors">
            <h2 className="text-xl font-black mb-6 tracking-tight flex items-center gap-2 text-slate-900 dark:text-white">
              <Plug className="text-violet-500" size={20} /> MCP — Connect Your Own AI Assistant
            </h2>
            <p className="text-slate-600 dark:text-slate-300 font-medium mb-6 leading-relaxed">
              AbaPay runs an <strong>MCP (Model Context Protocol)</strong> server, so an AI assistant you already use — Claude, or any MCP-speaking client — can pay your bills for you: Nigerian services, or international airtime/data across 170+ countries. It's the same engine chat uses, reached over JSON-RPC instead of a message. Nothing about it is a looser trust boundary: same on-chain allowance, same PIN gate, same kill switches, same operator caps, same spend alerts.
            </p>
            <div className="space-y-4">
              <div className="bg-violet-50 dark:bg-violet-900/20 border border-violet-100 dark:border-violet-800/50 p-5 rounded-2xl transition-colors">
                <h4 className="text-sm font-black text-violet-900 dark:text-violet-100 mb-1">OAuth, or an API key</h4>
                <p className="text-sm text-violet-800 dark:text-violet-300 font-medium leading-relaxed">
                  Preferred: authorize once in your browser with <strong>OAuth 2.1</strong> and the connection is remembered — no credential to paste ever again. For clients that can't do OAuth, create an API key in <strong>Agent Hub → MCP</strong> instead. Either one can be revoked instantly from the Agent Hub, which kills every token issued against it.
                </p>
              </div>
              <div className="bg-slate-50 dark:bg-[#1a1a1f] p-5 rounded-2xl border border-slate-100 dark:border-slate-800/80 transition-colors">
                <h4 className="text-sm font-black text-slate-800 dark:text-slate-200 mb-1">Your PIN is still required — every single payment</h4>
                <p className="text-sm text-slate-600 dark:text-slate-400 font-medium leading-relaxed">
                  Authorizing a connection means "this assistant may act for me". It never means "this assistant may spend". Without your PIN a connected assistant can read your balance and the plan catalogue and nothing else. If anything claims it can pay without asking you for your PIN, treat that as a red flag.
                </p>
              </div>
              <div className="bg-slate-50 dark:bg-[#1a1a1f] p-5 rounded-2xl border border-slate-100 dark:border-slate-800/80 transition-colors">
                <h4 className="text-sm font-black text-slate-800 dark:text-slate-200 mb-1">Real plans, real prices — never guessed</h4>
                <p className="text-sm text-slate-600 dark:text-slate-400 font-medium leading-relaxed">
                  A <code className="text-[11px] font-black">list_plans</code> tool gives the assistant the actual purchasable data bundles, cable packages and exam products with their real codes and current prices, straight from our payment provider. A separate <code className="text-[11px] font-black">list_international_options</code> tool does the same for the international catalogue — country, product type, operator and priced plan. It's what stops an assistant inventing a plausible-sounding "1GB for ₦1,000" that doesn't exist — a real code is required or it can't pay at all.
                </p>
              </div>
              <div className="bg-slate-50 dark:bg-[#1a1a1f] p-5 rounded-2xl border border-slate-100 dark:border-slate-800/80 transition-colors">
                <h4 className="text-sm font-black text-slate-800 dark:text-slate-200 mb-1">Premium receipts, and your own history — right in chat</h4>
                <p className="text-sm text-slate-600 dark:text-slate-400 font-medium leading-relaxed">
                  Every successful payment comes back with a branded receipt card and a shareable receipt link, not just a line of text. A <code className="text-[11px] font-black">transaction_history</code> tool lets the assistant answer "what did I pay recently" with the same records as your app's History tab, without you needing to open it.
                </p>
              </div>
            </div>
          </section>

          {/* AGENT HUB */}
          <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2.5rem] p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4 transition-colors">
            <h2 className="text-xl font-black mb-6 tracking-tight flex items-center gap-2 text-slate-900 dark:text-white">
              <KeyRound className="text-emerald-500" size={20} /> Agent Hub — Your Spending Allowance
            </h2>
            <p className="text-slate-600 dark:text-slate-300 font-medium mb-6 leading-relaxed">
              The Agent Hub tab is where you link a messaging account (or create an MCP credential) and grant the agent permission to pay on your behalf — entirely optional, and entirely under your control.
            </p>
            <ul className="space-y-4">
              <li className="bg-slate-50 dark:bg-[#1a1a1f] p-5 rounded-2xl border border-slate-100 dark:border-slate-800/80 transition-colors">
                <strong className="block text-sm font-black text-slate-800 dark:text-slate-200 mb-1">Choose Your Own Chain &amp; Stablecoin</strong>
                <span className="text-sm text-slate-600 dark:text-slate-400 font-medium leading-relaxed">Approvals are independent per chain and per token — approve USDC on Celo, USD₮ on Base, both, or neither. Each approval is its own on-chain transaction that only you can sign.</span>
              </li>
              <li className="bg-slate-50 dark:bg-[#1a1a1f] p-5 rounded-2xl border border-slate-100 dark:border-slate-800/80 transition-colors">
                <strong className="block text-sm font-black text-slate-800 dark:text-slate-200 mb-1">Bounded and Revocable, On-Chain</strong>
                <span className="text-sm text-slate-600 dark:text-slate-400 font-medium leading-relaxed">The smart contract itself — not AbaPay's servers — enforces the cap. The agent can never spend more than the remaining amount you've approved, and you can lower it, raise it, or set it to zero at any moment. Setting it to zero is the real revocation; unlinking a chat account stops that channel but doesn't touch the on-chain limit.</span>
              </li>
              <li className="bg-slate-50 dark:bg-[#1a1a1f] p-5 rounded-2xl border border-slate-100 dark:border-slate-800/80 transition-colors">
                <strong className="block text-sm font-black text-slate-800 dark:text-slate-200 mb-1">No Allowance? No Problem.</strong>
                <span className="text-sm text-slate-600 dark:text-slate-400 font-medium leading-relaxed">If you ask the agent to pay with a token you haven't approved yet, it tells you plainly and gives you the choice — approve it now in the Agent Hub, or complete just this one payment with a signed link instead.</span>
              </li>
              <li className="bg-slate-50 dark:bg-[#1a1a1f] p-5 rounded-2xl border border-slate-100 dark:border-slate-800/80 transition-colors">
                <strong className="block text-sm font-black text-slate-800 dark:text-slate-200 mb-1">You Hear About Every Agent Spend</strong>
                <span className="text-sm text-slate-600 dark:text-slate-400 font-medium leading-relaxed">The moment an agent moves money, an alert goes out to your other linked channels and your email — so a leaked key or a compromised chat account is visible to you immediately, not at the end of the month.</span>
              </li>
            </ul>
          </section>

          {/* SCHEDULED & RECURRING */}
          <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2.5rem] p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4 transition-colors">
            <h2 className="text-xl font-black mb-6 tracking-tight flex items-center gap-2 text-slate-900 dark:text-white">
              <CalendarClock className="text-sky-500" size={20} /> Scheduled &amp; Recurring Bills
            </h2>
            <p className="text-slate-600 dark:text-slate-300 font-medium mb-6 leading-relaxed">
              Tell the agent in plain language — <em>"every Tuesday buy ₦200 MTN airtime"</em>, <em>"pay my meter on the 28th every month"</em>, or a one-off <em>"top up 08012345678 in an hour"</em> — and it becomes a schedule. Ask it to <em>"show my schedules"</em> or <em>"cancel my airtime schedule"</em> the same way.
            </p>
            <div className="bg-sky-50 dark:bg-sky-900/20 border border-sky-100 dark:border-sky-800/50 p-5 rounded-2xl transition-colors">
              <h4 className="text-sm font-black text-sky-900 dark:text-sky-100 mb-2">Automatic execution is opt-in, per schedule</h4>
              <p className="text-sm text-sky-800 dark:text-sky-300 font-medium leading-relaxed">
                By default a schedule only <strong>reminds</strong> you when it's due. Only if you explicitly turn on automatic execution does it pay by itself — and even then it's bounded by the same on-chain allowance and the same per-transaction and daily caps as any other agent payment. A schedule runs at most once per due date, re-checks every service rule before it fires, warns you ahead of time if your balance looks short, and pauses itself after repeated failures rather than retrying forever.
              </p>
            </div>
          </section>

          {/* SUPPORTED SERVICES */}
          <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2.5rem] p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4 transition-colors">
            <h2 className="text-xl font-black mb-6 tracking-tight flex items-center gap-2 text-slate-900 dark:text-white">
              <GraduationCap className="text-rose-500" size={20} /> What You Can Pay For
            </h2>
            <ul className="space-y-3 text-sm text-slate-600 dark:text-slate-400 font-medium leading-relaxed">
              <li className="bg-slate-50 dark:bg-[#1a1a1f] p-4 rounded-2xl border border-slate-100 dark:border-slate-800/80"><strong className="text-slate-800 dark:text-slate-200">Airtime &amp; mobile data</strong> — MTN, Airtel, Glo, 9mobile, including SME data bundles. No platform fee.</li>
              <li className="bg-slate-50 dark:bg-[#1a1a1f] p-4 rounded-2xl border border-slate-100 dark:border-slate-800/80"><strong className="text-slate-800 dark:text-slate-200">Electricity</strong> — prepaid and postpaid, across the Nigerian distribution companies. Your meter is verified with the disco before you pay.</li>
              <li className="bg-slate-50 dark:bg-[#1a1a1f] p-4 rounded-2xl border border-slate-100 dark:border-slate-800/80"><strong className="text-slate-800 dark:text-slate-200">Cable TV</strong> — DStv, GOtv, Startimes. Smartcard/IUC verified before payment.</li>
              <li className="bg-slate-50 dark:bg-[#1a1a1f] p-4 rounded-2xl border border-slate-100 dark:border-slate-800/80"><strong className="text-slate-800 dark:text-slate-200">Education PINs</strong> — WAEC result-checker and WAEC registration PINs, buyable in the app, in chat <em>and</em> through a connected AI agent. JAMB is built but not currently enabled on our merchant account, so it can't be bought today.</li>
              <li className="bg-slate-50 dark:bg-[#1a1a1f] p-4 rounded-2xl border border-slate-100 dark:border-slate-800/80"><strong className="text-slate-800 dark:text-slate-200">International airtime &amp; data</strong> — every country our payment provider currently covers, read live from their own list.</li>
              <li className="bg-slate-50 dark:bg-[#1a1a1f] p-4 rounded-2xl border border-slate-100 dark:border-slate-800/80"><strong className="text-slate-800 dark:text-slate-200">Bank transfers</strong> — <em>app only, deliberately.</em> Moving money to a third party needs your own wallet signature, so the agent will never execute one from an allowance.</li>
            </ul>
            <p className="text-[11px] font-bold text-slate-400 dark:text-slate-500 mt-4 uppercase tracking-wider">
              The exact providers, plans and amount limits inside each category come live from our payment provider and can change without an app update.
            </p>
          </section>

          {/* ABAPOINTS & REWARDS */}
          <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2.5rem] p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4 transition-colors">
            <h2 className="text-xl font-black mb-6 tracking-tight flex items-center gap-2 text-slate-900 dark:text-white">
              <Star className="text-purple-500" size={20} /> AbaPoints &amp; Rewards
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
                AbaPoints are globally pegged to the stablecoin (cUSD/USDm, USDC, USD₮) value of your utility purchase. Spend exactly 5.50 USDC on a utility bill? You earn exactly 5.50 points instantly. This ensures your rewards are completely protected against local fiat currency inflation!
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
              <Share2 className="text-orange-500" size={20} /> Receipts &amp; Support
            </h2>
            <div className="space-y-4">
              <div className="bg-slate-50 dark:bg-[#1a1a1f] p-5 rounded-3xl border border-slate-100 dark:border-slate-800/80 transition-colors">
                <h4 className="text-sm font-black text-slate-800 dark:text-slate-200 mb-2">Sharing Your Receipt</h4>
                <p className="text-sm text-slate-600 dark:text-slate-400 font-medium leading-relaxed">
                  Click the dark "SHARE" button at the bottom of any successful transaction receipt. AbaPay generates a clean image of your receipt that you can send straight to WhatsApp or Telegram via your phone's share sheet — or, where that isn't available (desktop and some wallet browsers), save it as a PNG or PDF, or simply long-press the preview image.
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
              <ShieldCheck className="text-emerald-500" size={20} /> Security &amp; Failsafes
            </h2>
            <p className="text-slate-600 dark:text-slate-300 font-medium mb-6">
              Domestic and international utility networks can occasionally experience downtime. AbaPay is built with <strong className="text-slate-900 dark:text-white">Defensive Programming</strong> to ensure you never lose money to a dropped connection.
            </p>
            <ul className="space-y-4">
              <li className="bg-slate-50 dark:bg-[#1a1a1f] p-5 rounded-2xl border border-slate-100 dark:border-slate-800/80 transition-colors">
                <strong className="block text-sm font-black text-slate-800 dark:text-slate-200 mb-1">Strict Token Requirements</strong>
                <span className="text-sm text-slate-600 dark:text-slate-400 font-medium leading-relaxed">If a provider claims "Success" but fails to generate your electricity token or education PIN, our system refuses to accept it. Your transaction goes into a PENDING state while our background webhook safely hunts down your token.</span>
              </li>
              <li className="bg-slate-50 dark:bg-[#1a1a1f] p-5 rounded-2xl border border-slate-100 dark:border-slate-800/80 transition-colors">
                <strong className="block text-sm font-black text-slate-800 dark:text-slate-200 mb-1">Deep On-Chain Payload Decoding</strong>
                <span className="text-sm text-slate-600 dark:text-slate-400 font-medium leading-relaxed">Our API does not trust front-end claims. It directly fetches your blockchain transaction and decodes the smart contract data to verify the exact amount and service you paid for before vending.</span>
              </li>
              <li className="bg-slate-50 dark:bg-[#1a1a1f] p-5 rounded-2xl border border-slate-100 dark:border-slate-800/80 transition-colors">
                <strong className="block text-sm font-black text-slate-800 dark:text-slate-200 mb-1">Preflight Intent Recovery</strong>
                <span className="text-sm text-slate-600 dark:text-slate-400 font-medium leading-relaxed">If your mobile app crashes or your network drops immediately after signing the transaction in your wallet, your funds are not lost. The system actively scans the blockchain to recover your "abandoned" preflight intent and completes the vending in the background.</span>
              </li>
              <li className="bg-slate-50 dark:bg-[#1a1a1f] p-5 rounded-2xl border border-slate-100 dark:border-slate-800/80 transition-colors">
                <strong className="block text-sm font-black text-slate-800 dark:text-slate-200 mb-1">Verified Refunds Only</strong>
                <span className="text-sm text-slate-600 dark:text-slate-400 font-medium leading-relaxed">Every refund is checked against the blockchain — correct token, correct recipient, sufficient amount — before it can be marked as refunded. A refund can never be recorded that didn't actually happen.</span>
              </li>
            </ul>
          </section>

          {/* ⚡ THE ONE FAQ — merged from this page's old accordion and the retired FAQ modal.
               Every answer below is written from real behaviour. Keep it that way. */}
          <section className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2.5rem] p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4 transition-colors">
            <h2 className="text-xl font-black mb-2 tracking-tight text-slate-900 dark:text-white">Frequently Asked Questions</h2>
            <p className="text-sm text-slate-500 dark:text-slate-400 font-medium mb-6">Everything in one place — no separate FAQ page to hunt for.</p>

            <FaqGroup title="Getting paid up" />
            <div className="space-y-3 mb-8">
              <FAQItem
                q="How do I pay a bill?"
                a={<>
                  <p>Three ways, all running the same payment engine. <strong>In this app:</strong> pick the service, enter the number, confirm, and sign in your wallet. <strong>By chat:</strong> message AbaPay on Telegram, WhatsApp or X in plain language — "send ₦500 airtime to 08012345678". <strong>Through an AI assistant:</strong> connect AbaPay as a tool over MCP and just ask it to pay.</p>
                  <p>Chat and AI payments need a spending allowance approved first (or they'll send you a signed link to pay yourself, one time).</p>
                </>}
              />
              <FAQItem
                q="Can I use AbaPay's agent in a Telegram group?"
                a={<>
                  <p>Yes — add the bot to a group and tag it (<code>@AbaPayAgentBot</code>) to use it there. Anything sensitive (balances, receipts, PINs) is always sent to you privately, never posted where the group can see it.</p>
                  <p>One group-only trick: ask it to pick a few phone numbers that were posted in the chat recently and recharge them — e.g. <em>"recharge 5 random numbers from the last 30 minutes, 200 each"</em>, or the same with data instead of airtime. It confirms the total and asks for your PIN by DM first, then posts the result (numbers, amounts, proof) back in the group once it's done. Electricity and cable aren't included in this — there's no safe way to tell a meter or smartcard number apart from any other number someone posts, so those still need you to name the account directly.</p>
                </>}
              />
              <FAQItem
                q="My wallet warned me this payment looks risky or 'malicious'. Is AbaPay safe?"
                a={<>
                  <p>Some wallets — Zerion and a few others — show a risk warning on AbaPay&apos;s payment signature. The warning is about the <em>shape</em> of the request, not about AbaPay.</p>
                  <p>AbaPay settles payments using <strong>x402</strong>, an open payment standard. It asks you to sign a one-off permission for a single, exact amount to be collected for the bill you&apos;re paying. Automated scanners can&apos;t tell that kind of permission apart from the one a scam site would ask for, so some of them flag every request of that shape.</p>
                  <p><strong>Check the wallet screen itself, which is the part that can&apos;t lie to you:</strong> it shows the exact amount and the recipient. The amount should match your bill, and the recipient should be AbaPay&apos;s payment contract. If those look right, the request is genuine. If they don&apos;t, cancel — and please tell us.</p>
                  <p>Cancelling is always safe. Nothing is charged, and nothing is left half-done.</p>
                </>}
              />
              <FAQItem
                q="I'm paying from Valora (or another wallet app) and it's stuck loading."
                a={<>
                  <p>When your wallet is a <strong>separate app</strong> rather than one built into this browser, AbaPay sends the approval request to it — but nothing can force that app to open on top of what you&apos;re doing. The request is sitting in your wallet waiting for you.</p>
                  <p><strong>Switch to your wallet app and approve it there</strong>, then come back. AbaPay says so on screen rather than leaving you watching a spinner.</p>
                  <p>If no prompt arrives at all, the connection to your wallet has usually gone stale. AbaPay reconnects you automatically when you return, and that remembered connection can look fine — your address and balance show — while the link to your wallet is actually closed, so requests reach nothing. AbaPay now checks that link before asking you to approve anything, and tells you to tap <strong>Connect</strong> again if it has dropped.</p>
                  <p>If a request still goes unanswered, AbaPay stops waiting after ninety seconds rather than spinning forever. Should you then approve it late, the payment can still go through — so check your <strong>History</strong> tab before paying again, to be sure you don&apos;t pay twice.</p>
                </>}
              />
              <FAQItem
                q="I opened AbaPay inside Valora's browser and it won't connect on its own."
                a={<>
                  <p>That&apos;s deliberate. Inside Valora&apos;s built-in browser, AbaPay used to appear connected by itself — and then payments got stuck: an approval prompt would come up, you&apos;d tap <strong>Allow</strong>, Valora would say the connection succeeded, and the payment would keep loading with no second prompt ever arriving.</p>
                  <p>Valora connects properly over <strong>WalletConnect</strong>, so that is the only route AbaPay now uses there. Tap <strong>Connect</strong> and choose Valora — it&apos;s the same app you&apos;re already in, so it takes one tap — and payments go through normally after that.</p>
                  <p>Valora works on <strong>Celo</strong>. If AbaPay is showing Base when you connect, it switches itself to Celo to match your wallet; pick a Celo token (USDC, USD₮ or USDm) and pay as usual.</p>
                </>}
              />
              <FAQItem
                q="What wallets and apps can I use?"
                a={<>
                  <p>MiniPay (Opera Mini&apos;s Celo wallet), Valora, MetaMask, Coinbase Smart Wallet / Base Account, and any other wallet reachable over WalletConnect or injected into your browser. AbaPay also runs as a Farcaster Mini App. Valora connects over WalletConnect — tap <strong>Connect</strong> and pick it — which is the only route it handles reliably.</p>
                  <p>Wallets that support smart-account gas sponsorship on Base get it automatically — the app detects the capability and batches the token approval and the payment into one sponsored transaction. Every other wallet just pays normal network fees, with no difference in behaviour.</p>
                </>}
              />
              <FAQItem
                q="I tapped Connect and nothing happened. What's wrong?"
                a={<>
                  <p>If you have a wallet installed in this browser, AbaPay uses it directly — it opens that wallet&apos;s own approval window, and if several are installed it asks which one you want. No QR code, no third-party service involved.</p>
                  <p>WalletConnect is only used when there is no wallet in the browser at all. That is where this usually goes wrong: connecting that way goes through a background service that some networks block, and because it&apos;s a WebSocket it fails silently instead of showing an error.</p>
                  <p>Open <a href="/network-check" className="text-emerald-600 dark:text-emerald-400 underline underline-offset-2">the network check</a> and it will tell you in a few seconds whether something is being blocked, and exactly what.</p>
                  <p>The quickest fix is to open AbaPay inside <strong>MiniPay</strong>, <strong>Base App</strong> or <strong>Farcaster</strong> — they connect your wallet directly and need none of the blocked services. Switching to a different network (mobile data instead of Wi-Fi, or the other way round) or turning on a VPN also works.</p>
                </>}
              />
              <FAQItem
                q="Which chains and stablecoins are supported?"
                a={<>
                  <p>Base and Celo — those two, plus their public test networks, and nothing else. <strong>Base is the default</strong>: it&apos;s what AbaPay connects to unless your wallet puts you somewhere else, and you can switch to Celo at any time. USD₮ and USDC work on both chains; cUSD/USDm is Celo-only.</p>
                  <p>The token picker filters itself to whatever chain your wallet is on, so you can&apos;t accidentally choose one that doesn&apos;t exist there. On Base it offers <strong>USDC first, then USD₮</strong>; on Celo, USD₮ first. Sending funds to our contract by hand, on another network or in another token, is not a payment and can&apos;t be matched to an order.</p>
                </>}
              />
              <FAQItem
                q="How long does a payment take?"
                a="The blockchain part confirms in roughly a few seconds on both Celo and Base. Utility delivery normally follows immediately after confirmation — electricity tokens and education PINs appear on the receipt itself. If a provider is slow, the transaction sits in a PENDING state and our webhook keeps chasing it rather than declaring failure."
              />
              <FAQItem
                q="Do you hold my money?"
                a="No. There's no AbaPay balance to top up, and we never hold your keys. Your stablecoins stay in your own wallet until the moment you pay a bill, and they go straight into the payment smart contract. We can't move your funds without either your signature or an allowance you explicitly approved on-chain."
              />
              <FAQItem
                q="Are there fees?"
                a={<>
                  <p>Yes, and they're always shown in the total before you confirm. There's a small flat platform fee on electricity, cable TV, education and bank transfers. Airtime, mobile data and international top-ups carry no platform fee at all.</p>
                  <p>Blockchain gas is separate, goes to the network rather than to us, and depends on your wallet and chain — Base smart wallets are often sponsored, so free.</p>
                </>}
              />
            </div>

            <FaqGroup title="What you can buy" />
            <div className="space-y-3 mb-8">
              <FAQItem
                q="What services do you support?"
                a={<>
                  <p>Airtime, mobile data (including SME bundles), electricity (prepaid and postpaid), cable TV (DStv, GOtv, Startimes), education PINs, bank transfers, and international airtime/data.</p>
                  <p>The providers inside each category are pulled live from our payment providers, so the list only ever shows what can genuinely be bought right now. If a provider disappears from the picker, it isn't purchasable at that moment — which is deliberately better than letting you pay for it and fail afterwards.</p>
                </>}
              />
              <FAQItem
                q="How does a bank transfer work?"
                a={<>
                  <p>Type the destination account number — we check it against every Nigerian bank automatically and tell you whose account it is, so you don't need to know or select the bank yourself. If more than one bank has an account under that exact number, we show you the short list of matches so you can confirm which one is yours.</p>
                  <p>Once confirmed, the transfer settles in real time as an actual bank payout, not a top-up voucher.</p>
                </>}
              />
              <FAQItem
                q="Is JAMB supported?"
                a={<>
                  <p>Not right now, honestly. WAEC result-checker and WAEC registration PINs work — in the app, in chat, and through a connected AI agent. JAMB is fully built on our side, but it isn't enabled on our current merchant account with our payment provider, so it doesn't appear in the live product list and can't be bought.</p>
                  <p>If that changes at their end it will simply start appearing, with no update needed from us.</p>
                </>}
              />
              <FAQItem
                q="Which countries can I send international airtime to?"
                a={<>
                  <p>Every country our payment provider currently covers — including Ghana, Kenya, South Africa, the UK and the US. We deliberately don't publish a count, because we read that list live from the provider rather than keeping our own copy of it, so it can change without us knowing.</p>
                  <p>Pick the country in the app (or just name it in chat) and you'll see its own operators, plans and local currency. If a country isn't in the live list, the agent will tell you so instead of promising something that would fail at delivery.</p>
                </>}
              />
              <FAQItem
                q="Can I set up recurring or scheduled payments?"
                a={<>
                  <p>Yes — just say so in chat: "every Tuesday buy ₦200 MTN airtime", "pay my meter on the 28th every month", or a one-off "top up 08012345678 in an hour". Ask to "show my schedules" or "cancel my airtime schedule" the same way.</p>
                  <p>Automatic execution is opt-in per schedule; by default a schedule only reminds you. When it is on, it's still bounded by your on-chain allowance and our per-transaction and daily caps, runs at most once per due date, and pauses itself after repeated failures.</p>
                  <p>The outcome is reported back on whatever channel you created the schedule from. On <strong>WhatsApp</strong> there&apos;s a wrinkle outside AbaPay&apos;s control: WhatsApp only lets a business send you a free-form message within 24 hours of your last one, so a schedule due days later is delivered as a formatted notification instead. Either way, the full receipt is always in your <strong>History</strong> tab.</p>
                </>}
              />
              <FAQItem
                q="Where do I get my electricity token or education PIN?"
                a="On the receipt, immediately after a successful payment — shown in full, and shareable as an image or saveable as a PNG/PDF. It's also in your History tab, and sent by email where we have your address."
              />
            </div>

            <FaqGroup title="Agents, MCP and your PIN" />
            <div className="space-y-3 mb-8">
              <FAQItem
                q="What's the difference between paying in the app and letting an agent pay for me?"
                a={<>
                  <p>In the app, you sign every payment in your wallet — nothing moves without that signature. With an agent, you approve an on-chain <em>spending allowance</em> once from the Agent Hub, for one specific chain and one specific stablecoin. After that the agent can pay without a fresh signature each time, but only up to what's left of that allowance.</p>
                  <p>The cap is enforced by the smart contract itself, not by our servers, so it cannot reach the rest of your wallet no matter what goes wrong on our side. Our own per-transaction and daily limits sit on top of yours.</p>
                </>}
              />
              <FAQItem
                q="How do I approve or revoke the agent's spending allowance?"
                a="Open the Agent Hub tab, pick the chain and stablecoin you want the agent to be able to use, and approve a limit — that's an on-chain transaction only you can sign. To revoke, set the limit back to zero; it takes effect on-chain immediately. Note that unlinking a chat account stops that channel but does not by itself zero your allowance, so do both if you want a full stop."
              />
              <FAQItem
                q="What is MCP, and what does connecting an AI assistant actually give it?"
                a={<>
                  <p>MCP (Model Context Protocol) is the standard that lets an AI assistant like Claude use AbaPay as a tool. A connected assistant can describe what AbaPay supports, list real purchasable plans with real prices, read your balance and remaining allowance, and — with your PIN — pay a bill.</p>
                  <p>It reaches exactly the same engine as chat: same on-chain allowance ceiling, same PIN gate with lockout, same kill switches, same operator caps, same spend alerts. It is not a looser door.</p>
                </>}
              />
              <FAQItem
                q="OAuth or API key — which should I use for MCP?"
                a={<>
                  <p>OAuth if your client supports it: you authorize once in the browser and the connection is remembered, so there's no credential to paste into every new conversation. The API key you create in Agent Hub → MCP is the fallback for clients that can't do the OAuth flow.</p>
                  <p>Both can be revoked instantly from the Agent Hub, and revoking kills every token issued against that link. An expired or revoked authorization makes the assistant ask you to reconnect rather than quietly failing.</p>
                </>}
              />
              <FAQItem
                q="If I connect an AI assistant, does it still need my PIN?"
                a="Yes — every single payment, every time. Authorizing the connector means 'this assistant may act for me'; it never means 'this assistant may spend'. Without the PIN a connected assistant can only read your balance and the plan catalogue. If something claims it can pay without asking for your PIN, treat that as a red flag."
              />
              <FAQItem
                q="Is my AbaPay PIN the same as my wallet password?"
                a={<>
                  <p>No, and it's important not to confuse them. Your wallet password and recovery phrase belong to your wallet app and we never see them. Your AbaPay PIN is a separate 4–6 digit code you set when linking a chat account or creating an MCP credential.</p>
                  <p>It gates one thing: authorising a payment through those channels. It can't move funds on its own — it only unlocks spending inside the allowance you already approved on-chain. Repeated wrong PINs lock the channel out.</p>
                </>}
              />
              <FAQItem
                q="Won't the AI just make up a data plan or a price?"
                a="It can't, for the services where that would matter. Data bundles, cable packages and education products all require a real plan code, and the connector exposes a list_plans tool that returns the actual purchasable plans, codes and current prices from our payment provider. If an agent can't get a real code, the payment is refused before any money moves rather than settling on-chain and failing at delivery."
              />
              <FAQItem
                q="What if I ask the agent to pay with a token I haven't approved?"
                a="It checks first. If there's no allowance for that chain and token, it says so and gives you the choice — approve a limit now in the Agent Hub, or complete just that one payment via a secure signed link. If another stablecoin on the same chain already has both the balance and the approved limit to cover it, it will tell you that too, so you can just use that one instead."
              />
              <FAQItem
                q="Can I link more than one account to my wallet?"
                a="Yes — Telegram, WhatsApp and X can be linked independently to the same wallet, alongside one or more MCP credentials, and each can be managed or unlinked separately from the Agent Hub."
              />
              <FAQItem
                q="Can an agent do a bank transfer for me?"
                a="No, and that's deliberate. Bank transfers move money to a third party, so they must be confirmed with your own wallet signature in the app. The agent will refuse and point you there rather than spending from an allowance."
              />
            </div>

            <FaqGroup title="When something goes wrong" />
            <div className="space-y-3">
              <FAQItem
                q="What happens if my payment succeeds on-chain but the bill doesn't deliver?"
                a={<>
                  <p>You get refunded, and you don't have to chase it. The moment a delivery fails after your money has landed on-chain, the transaction is flagged, queued for a refund, and our operators are alerted. You're told on the channel you used (and by email if we have one), then again when the refund actually lands.</p>
                  <p>It goes back to the same wallet, in the same stablecoin, and is verified against the blockchain — correct token, correct recipient, sufficient amount — before it can be marked as refunded. Refunds are released by an operator rather than instantly; we aim for 24–72 hours. The gas you originally paid to submit the transaction isn't recoverable.</p>
                </>}
              />
              <FAQItem
                q="My blockchain transaction failed. Do I get a refund?"
                a="There's nothing to refund — if the transaction reverted or never landed, your money never left your wallet. Refunds exist for the case where we received your funds and the provider then failed to deliver. Check your wallet balance; if you're still unsure, tap Support on the receipt and the ticket carries your transaction hash automatically."
              />
              <FAQItem
                q="Why was my payment refused before I even paid?"
                a={<>
                  <p>Usually one of four things. (1) The service, or that one specific provider, is paused — we do that during an outage, a dispute or a security concern, and we'd rather refuse up front than take your money for something we know is broken. (2) The amount is outside the provider's own limits, which vary by network and by biller rather than following one flat rule. (3) You picked a provider our payment provider can't currently sell. (4) For agent payments: the amount exceeds your remaining allowance, your daily limit, or our operator cap.</p>
                  <p>The refusal message tells you which one it was.</p>
                </>}
              />
              <FAQItem
                q="Why is a service sometimes 'temporarily offline'?"
                a="We can pause things at two levels — a whole category (all electricity, say) or a single provider within it (just one disco). Both are applied identically to the app, chat, the MCP connector and the scheduler, so nothing can slip through a side door while the website correctly refuses. It's almost always a provider outage or a dispute, and it's temporary."
              />
              <FAQItem
                q="Who controls the funds?"
                a="You do. AbaPay is a non-custodial gateway. We do not have access to your private keys, and we cannot move your funds without you either signing a transaction or having explicitly approved an on-chain allowance — which you can revoke at any moment."
              />
              <FAQItem
                q="What is x402 settlement, and does it change anything for me?"
                a="x402 is an HTTP-native payment protocol that some app payments settle through automatically instead of a direct contract call, where the chain, the token and your wallet all support it. It's invisible in day-to-day use — same wallet, same vault, same refund protection — it simply makes that payment independently verifiable on public x402 explorers. Some wallets can't return the kind of signature x402 needs (Valora, for one), and those payments just take the contract-call route instead. Which rail is used is our routing decision, not something you pick."
              />
              <FAQItem
                q="Something's still wrong. How do I reach a human?"
                a={<>
                  <p>Tap <strong>Support</strong> on any receipt — the ticket goes straight to our ops team with your transaction hash attached, which is by far the fastest route.</p>
                  <p>Otherwise, email <a href="mailto:support@abapays.com" className="underline font-bold">support@abapays.com</a>. Our <Link href="/terms" className="underline font-bold">Terms</Link> and <Link href="/privacy" className="underline font-bold">Privacy Policy</Link> spell out the formal version of everything above.</p>
                </>}
              />
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

function FaqGroup({ title }: { title: string }) {
  return (
    <h3 className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-400 dark:text-slate-500 mb-3">{title}</h3>
  );
}

function FAQItem({ q, a }: { q: string, a: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <div className="border border-slate-100 dark:border-slate-800/60 rounded-2xl overflow-hidden bg-slate-50 dark:bg-[#1a1a1f] transition-all">
      <button
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        className="w-full text-left p-5 flex justify-between items-center hover:bg-slate-100 dark:hover:bg-slate-800/50 transition-colors"
      >
        <span className="font-bold text-sm text-slate-800 dark:text-slate-200 pr-4">{q}</span>
        <ChevronDown size={18} className={`text-slate-400 dark:text-slate-500 transition-transform duration-300 shrink-0 ${isOpen ? 'rotate-180' : ''}`} />
      </button>
      {/* ⚡ grid-rows 0fr→1fr rather than a max-height guess: several answers below are two
          paragraphs long, and the old `max-h-48` silently clipped anything taller. This
          animates to the content's real height whatever that turns out to be. */}
      <div className={`grid transition-all duration-300 ease-in-out ${isOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
        <div className="overflow-hidden">
          <div className="p-5 pt-0 text-sm text-slate-600 dark:text-slate-400 leading-relaxed font-medium space-y-3">
            {typeof a === 'string' ? <p>{a}</p> : a}
          </div>
        </div>
      </div>
    </div>
  );
}
