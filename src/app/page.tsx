"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { createWalletClient, createPublicClient, custom, http, parseUnits, formatUnits } from "viem";
import { celo, celoSepolia } from "viem/chains";
import { 
  Wallet, Receipt, ShieldCheck, Zap, AlertTriangle, 
  CheckCircle2, ExternalLink, Lightbulb, Phone, Wifi, Tv, 
  ChevronDown, Loader2, HelpCircle, XCircle, Mail, 
  Paperclip, Send, Coins, Briefcase, Download, Printer
} from "lucide-react";
import { supabase } from "@/utils/supabase";

// --- WEB3 CONFIG ---
const ABAPAY_ABI = [{"inputs":[{"internalType":"address","name":"tokenAddress","type":"address"},{"internalType":"string","name":"serviceType","type":"string"},{"internalType":"string","name":"accountNumber","type":"string"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"payBill","outputs":[],"stateMutability":"nonpayable","type":"function"}];
const ERC20_ABI = [
  {"inputs":[{"internalType":"address","name":"spender","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"approve","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"address","name":"account","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"}
];

const SERVICES = [
  { id: "AIRTIME", name: "Buy Airtime", icon: Phone, color: "text-[#34d399]", bg: "bg-emerald-500/10" },
  { id: "DATA", name: "Buy Data", icon: Wifi, color: "text-[#a855f7]", bg: "bg-purple-500/10" },
  { id: "ELECTRICITY", name: "Electricity", icon: Lightbulb, color: "text-[#f97316]", bg: "bg-orange-500/10" },
  { id: "CABLE", name: "Cable TV", icon: Tv, color: "text-[#ec4899]", bg: "bg-pink-500/10" },
];

const ELECTRICITY_PROVIDERS = ["aba-electric", "ikedc", "ekedc", "ibedc", "aedc", "kedco", "phed"];
const CABLE_PROVIDERS = ["dstv", "gotv", "startimes", "showmax"];
const TELECOM_PROVIDERS = ["mtn", "airtel", "glo", "9mobile"];

const SUPPORTED_TOKENS = [
  { symbol: "USDT", decimals: 6, mainnet: "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e", sepolia: "0xd077A400968890Eacc75cdc901F0356c943e4fDb", icon: "💵" },
  { symbol: "USDC", decimals: 6, mainnet: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", sepolia: "0x01C5C0122039549AD1493B8220cABEdD739BC44E", icon: "🪙" },
  { symbol: "CELO", decimals: 18, mainnet: "native", sepolia: "native", icon: "🟡" },
];

const PRE_SELECT_AMOUNTS = ["100", "200", "500", "1000", "2000"];

const MOCK_DATA_PLANS = [
  { id: "D1", category: "Daily", name: "100MB", validity: "24 Hrs", cost_naira: 100 },
  { id: "D2", category: "Daily", name: "350MB", validity: "24 Hrs", cost_naira: 200 },
  { id: "D3", category: "Daily", name: "1GB", validity: "24 Hrs", cost_naira: 350 },
  { id: "W1", category: "Weekly", name: "1GB", validity: "7 Days", cost_naira: 600 },
  { id: "W2", category: "Weekly", name: "2.5GB", validity: "7 Days", cost_naira: 1200 },
  { id: "M1", category: "Monthly", name: "1.5GB", validity: "30 Days", cost_naira: 1100 },
];

const DATA_CATEGORIES = ["Daily", "Weekly", "Monthly"];

export default function Home() {
  const [isInitiallyLoading, setIsInitiallyLoading] = useState(true);
  const [address, setAddress] = useState<string | null>(null);
  const [client, setClient] = useState<any>(null);
  const [nairaAmount, setNairaAmount] = useState(""); 
  const [accountNumber, setAccountNumber] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [status, setStatus] = useState("");
  const [activeTab, setActiveTab] = useState("pay");
  const [isMiniPay, setIsMiniPay] = useState(false);

  // Modal States
  const [selectedReceipt, setSelectedReceipt] = useState<any>(null);
  const [isSupportOpen, setIsSupportOpen] = useState(false);
  const [isSelectionModalOpen, setIsSelectionModalOpen] = useState(false);
  const [modalTitle, setModalTitle] = useState("");
  const [modalOptions, setModalOptions] = useState<string[]>([]);
  const [modalCallback, setModalCallback] = useState<((value: string) => void) | null>(null);

  // App States
  const [activeService, setActiveService] = useState(SERVICES[0]);
  const [elecProvider, setElecProvider] = useState(ELECTRICITY_PROVIDERS[0]);
  const [cableProvider, setCableProvider] = useState(CABLE_PROVIDERS[0]);
  const [telecomProvider, setTelecomProvider] = useState(TELECOM_PROVIDERS[0]);
  const [meterType, setMeterType] = useState<"prepaid" | "postpaid">("prepaid");
  const [selectedToken, setSelectedToken] = useState(SUPPORTED_TOKENS[0]);
  const [walletBalance, setWalletBalance] = useState("0.00");
  const [isFetchingBalance, setIsFetchingBalance] = useState(false);
  const [exchangeRate, setExchangeRate] = useState<number>(1550); 
  const [transactions, setTransactions] = useState<any[]>([]);

  const isMainnet = process.env.NEXT_PUBLIC_NETWORK === "celo";
  const activeChain = isMainnet ? celo : celoSepolia;
  const ABAPAY_CONTRACT = process.env.NEXT_PUBLIC_ABAPAY_ADDRESS as `0x${string}`;

  useEffect(() => {
    async function init() {
      const saved = localStorage.getItem("abapay_history");
      if (saved) setTransactions(JSON.parse(saved));
      if (typeof window !== "undefined" && (window as any).ethereum) {
        const eth = (window as any).ethereum;
        if (eth.isMiniPay) setIsMiniPay(true);
        const walletClient = createWalletClient({ chain: activeChain, transport: custom(eth) });
        walletClient.requestAddresses().then(([acc]) => { setAddress(acc); setClient(walletClient); });
      }
      setTimeout(() => setIsInitiallyLoading(false), 2000);
    }
    init();
  }, [activeChain]);

  // Balance fetch
  useEffect(() => {
    async function fetchBalance() {
      if (!address) return;
      setIsFetchingBalance(true);
      try {
        const publicClient = createPublicClient({ chain: activeChain, transport: http() });
        let balanceWei;
        if (selectedToken.symbol === "CELO") {
          balanceWei = await publicClient.getBalance({ address: address as `0x${string}` });
        } else {
          const tokenAddress = isMainnet ? selectedToken.mainnet : selectedToken.sepolia;
          balanceWei = await publicClient.readContract({
            address: tokenAddress as `0x${string}`, abi: ERC20_ABI, functionName: 'balanceOf', args: [address],
          });
        }
        setWalletBalance(parseFloat(formatUnits(balanceWei as bigint, selectedToken.decimals)).toFixed(4));
      } catch (error) { setWalletBalance("0.00"); }
      setIsFetchingBalance(false);
    }
    fetchBalance();
  }, [address, selectedToken, activeChain, isMainnet]);

  const { cryptoToCharge } = useMemo(() => {
    const bill = parseFloat(nairaAmount) || 0;
    const fee = (activeService.id === "ELECTRICITY" || activeService.id === "CABLE") ? 100 : 0;
    return { cryptoToCharge: ((bill + fee) / exchangeRate).toFixed(4) };
  }, [nairaAmount, exchangeRate, activeService]);

  const handlePayment = async () => {
    if (!address || !client) return;
    setStatus("Initiating Escrow...");
    try {
      const valueInWei = parseUnits(cryptoToCharge, selectedToken.decimals);
      const tokenAddress = isMainnet ? selectedToken.mainnet : selectedToken.sepolia;
      await client.writeContract({ address: tokenAddress as `0x${string}`, abi: ERC20_ABI, functionName: 'approve', args: [ABAPAY_CONTRACT, valueInWei], account: address });
      
      const activeServiceID = activeService.id === "ELECTRICITY" ? elecProvider : activeService.id === "CABLE" ? cableProvider : telecomProvider; 

      const hash = await client.writeContract({
        address: ABAPAY_CONTRACT,
        abi: ABAPAY_ABI,
        functionName: 'payBill',
        args: [tokenAddress, activeServiceID, accountNumber, valueInWei],
        account: address,
      });

      // Prepare local transaction entry
      const newTx = { 
        id: hash.slice(0,10), 
        date: new Date().toLocaleString(), 
        status: "PENDING", 
        amountNaira: nairaAmount, 
        amountCrypto: cryptoToCharge, 
        tokenUsed: selectedToken.symbol, 
        service: activeService.name, 
        network: activeServiceID.toUpperCase(), 
        txHash: hash, 
        account: accountNumber 
      };

      const res = await fetch('/api/pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceID: activeServiceID, billersCode: accountNumber, amount: cryptoToCharge, token: selectedToken.symbol, txHash: hash, variation_code: meterType, phone: customerPhone || accountNumber })
      });

      const result = await res.json();
      newTx.status = result.success ? "SUCCESS" : "FAILED/DELAYED";
      
      const updatedHistory = [newTx, ...transactions];
      setTransactions(updatedHistory);
      localStorage.setItem("abapay_history", JSON.stringify(updatedHistory));
      
      setStatus(result.success ? "Success!" : "Vending Delayed. Admin Notified.");
    } catch (e) { setStatus("Transaction Error."); }
  };

  const openPremiumSelection = (title: string, options: string[], callback: (value: string) => void) => {
    setModalTitle(title);
    setModalOptions(options);
    setModalCallback(() => callback);
    setIsSelectionModalOpen(true);
  };

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900 font-sans p-4 flex flex-col items-center pb-20 relative">

      {/* --- RECEIPT MODAL --- */}
      {selectedReceipt && (
        <div className="fixed inset-0 z-[100] bg-slate-900/80 backdrop-blur-md flex justify-center items-center p-6 animate-in fade-in" onClick={() => setSelectedReceipt(null)}>
           <div className="bg-white w-full max-w-sm rounded-[2.5rem] overflow-hidden shadow-2xl animate-in zoom-in-95 duration-200" onClick={(e) => e.stopPropagation()}>
              <div className="bg-emerald-600 p-8 text-white text-center relative">
                 <button onClick={() => setSelectedReceipt(null)} className="absolute top-4 right-4 bg-white/20 p-1.5 rounded-full hover:bg-white/30 transition-colors"><XCircle size={20}/></button>
                 <div className="w-16 h-16 bg-white/20 rounded-full flex items-center justify-center mx-auto mb-3">
                    <ShieldCheck size={32} />
                 </div>
                 <h2 className="text-xl font-black">Transaction Receipt</h2>
                 <p className="text-emerald-100 text-[10px] font-bold uppercase tracking-[0.2em] mt-1">AbaPay Digital Protocol</p>
              </div>
              
              <div className="p-8 space-y-5">
                 <div className="flex justify-between items-center border-b border-slate-50 pb-3">
                    <span className="text-slate-400 text-[10px] font-black uppercase">Status</span>
                    <span className={`font-black text-xs uppercase ${selectedReceipt.status === 'SUCCESS' ? 'text-emerald-600' : 'text-orange-500'}`}>{selectedReceipt.status}</span>
                 </div>
                 <div className="flex justify-between items-center border-b border-slate-50 pb-3">
                    <span className="text-slate-400 text-[10px] font-black uppercase">Service</span>
                    <span className="text-slate-800 font-black text-xs uppercase">{selectedReceipt.network} {selectedReceipt.service}</span>
                 </div>
                 <div className="flex justify-between items-center border-b border-slate-50 pb-3">
                    <span className="text-slate-400 text-[10px] font-black uppercase">Recipient</span>
                    <span className="text-slate-800 font-mono font-bold text-xs">{selectedReceipt.account}</span>
                 </div>
                 <div className="flex justify-between items-center border-b border-slate-50 pb-3">
                    <span className="text-slate-400 text-[10px] font-black uppercase">Amount</span>
                    <div className="text-right">
                       <p className="text-slate-800 font-black text-sm">₦{parseFloat(selectedReceipt.amountNaira).toLocaleString()}</p>
                       <p className="text-slate-400 text-[9px] font-bold">{selectedReceipt.amountCrypto} {selectedReceipt.tokenUsed}</p>
                    </div>
                 </div>
                 <div className="pt-2">
                    <p className="text-[8px] text-slate-300 font-bold uppercase mb-2">Blockchain Reference</p>
                    <p className="text-[9px] text-slate-500 font-mono break-all bg-slate-50 p-2 rounded-lg">{selectedReceipt.txHash}</p>
                 </div>

                 <div className="grid grid-cols-2 gap-3 mt-4">
                    <button 
                      onClick={() => window.open(`https://${isMainnet?'':'sepolia.'}celoscan.io/tx/${selectedReceipt.txHash}`)}
                      className="flex items-center justify-center gap-2 py-3 bg-slate-50 hover:bg-slate-100 rounded-xl text-[10px] font-black uppercase text-slate-500 transition-colors"
                    >
                      <ExternalLink size={12}/> Explorer
                    </button>
                    <button 
                      onClick={() => window.print()}
                      className="flex items-center justify-center gap-2 py-3 bg-slate-900 hover:bg-black rounded-xl text-[10px] font-black uppercase text-white transition-colors"
                    >
                      <Download size={12}/> Save
                    </button>
                 </div>
              </div>
              <div className="bg-slate-50 p-4 text-center">
                 <p className="text-[8px] text-slate-400 font-bold uppercase">Thank you for using AbaPay</p>
              </div>
           </div>
        </div>
      )}

      {/* --- MAIN UI --- */}
      <div className="w-full max-w-md">
        <div className="flex justify-between items-center bg-white p-4 rounded-3xl shadow-sm border border-slate-100 mb-6">
          <div className="flex items-center gap-3">
            <img src="/logo.png" alt="AbaPay" className="h-10 w-auto" />
            <div className="flex flex-col">
              <span className="text-xl font-black text-slate-900 leading-none">AbaPay<span className="text-emerald-500">.</span></span>
              <span className="text-[8px] font-black uppercase text-slate-400 tracking-widest mt-1">Seamless.</span>
            </div>
          </div>
          <div>
            {address ? (
              <div className="bg-emerald-50 border border-emerald-100 px-3 py-1.5 rounded-xl flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <span className="text-[10px] font-black text-emerald-700 font-mono">{address.slice(0, 5)}...{address.slice(-4)}</span>
              </div>
            ) : (
              <button className="bg-slate-900 text-white text-[10px] font-black uppercase px-4 py-2 rounded-xl">Connect</button>
            )}
          </div>
        </div>

        <div className="flex gap-2 bg-slate-200/50 p-1.5 rounded-2xl mb-6">
            <button onClick={() => setActiveTab("pay")} className={`flex-1 py-3 rounded-xl text-xs font-black transition-all ${activeTab === 'pay' ? 'bg-white text-emerald-600 shadow-sm' : 'text-slate-500'}`}>PAY BILLS</button>
            <button onClick={() => setActiveTab("history")} className={`flex-1 py-3 rounded-xl text-xs font-black transition-all ${activeTab === 'history' ? 'bg-white text-emerald-600 shadow-sm' : 'text-slate-500'}`}>HISTORY</button>
        </div>

        {activeTab === 'pay' ? (
          <div className="bg-white border border-slate-100 rounded-[2.5rem] p-8 shadow-2xl animate-in fade-in zoom-in-95">
            <div className="grid grid-cols-4 gap-3 mb-6">
                {SERVICES.map(s => (
                    <button key={s.id} onClick={() => setActiveService(s)} className={`p-4 rounded-2xl border-2 transition-all flex flex-col items-center gap-2 ${activeService.id === s.id ? 'border-emerald-500 bg-emerald-50' : 'border-slate-50'}`}>
                        <s.icon size={20} className={s.color} />
                        <span className="text-[8px] font-black uppercase">{s.id.slice(0,4)}</span>
                    </button>
                ))}
            </div>

            <div className="space-y-5">
                <div className="bg-slate-50 border border-slate-100 p-4 rounded-2xl flex justify-between items-center">
                  <div className="flex items-center gap-2 cursor-pointer" onClick={() => openPremiumSelection("Token", SUPPORTED_TOKENS.map(t => t.symbol), (s) => setSelectedToken(SUPPORTED_TOKENS.find(t => t.symbol === s)!))}>
                     <span className="text-xl">{selectedToken.icon}</span>
                     <span className="font-black text-slate-800 text-sm">{selectedToken.symbol}</span>
                     <ChevronDown size={14} className="text-slate-400"/>
                  </div>
                  <div className="text-right">
                    <p className="text-[10px] font-black text-slate-400 uppercase">Balance</p>
                    <p className="font-mono font-black text-sm text-slate-800">{isFetchingBalance ? '...' : walletBalance}</p>
                  </div>
                </div>

                <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase">Recipient Account</label>
                    <input type="tel" placeholder="080XXXXXXXX" className="w-full bg-slate-50 border border-slate-100 p-5 rounded-2xl font-black text-xl outline-none focus:border-emerald-500 transition-all" value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)}/>
                </div>

                <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase">Amount (Naira)</label>
                    <input type="number" placeholder="500" className="w-full bg-slate-50 border border-slate-100 p-5 rounded-2xl font-black text-xl outline-none focus:border-emerald-500 transition-all" value={nairaAmount} onChange={(e) => setNairaAmount(e.target.value)}/>
                    <p className="text-[10px] font-bold text-emerald-600">Total: {cryptoToCharge} {selectedToken.symbol}</p>
                </div>

                <button onClick={handlePayment} className="w-full bg-slate-900 text-white font-black py-5 rounded-[1.5rem] flex items-center justify-center gap-3 active:scale-95 transition-all">
                    <ShieldCheck size={20} className="text-emerald-400" /> CONFIRM & PAY
                </button>
            </div>
          </div>
        ) : (
          <div className="bg-white border border-slate-100 rounded-[2.5rem] p-6 shadow-2xl">
             {transactions.length === 0 ? (
                <div className="py-20 text-center text-slate-300">No activity found</div>
             ) : (
                <div className="space-y-3">
                    {transactions.map((tx, idx) => (
                        <div 
                          key={idx} 
                          onClick={() => setSelectedReceipt(tx)}
                          className="p-4 bg-slate-50 rounded-2xl border border-slate-100 flex justify-between items-center cursor-pointer hover:bg-emerald-50 transition-all"
                        >
                            <div>
                                <p className="text-xs font-black text-slate-800 uppercase">{tx.network} {tx.service}</p>
                                <p className="text-[10px] text-slate-400">{tx.date}</p>
                            </div>
                            <div className="text-right">
                                <p className="text-xs font-black text-emerald-600">₦{tx.amountNaira}</p>
                                <p className="text-[8px] font-bold text-slate-300 uppercase">View Receipt</p>
                            </div>
                        </div>
                    ))}
                </div>
             )}
          </div>
        )}
      </div>
    </main>
  );
}
