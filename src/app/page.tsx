"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { createWalletClient, createPublicClient, custom, http, parseUnits, formatUnits, defineChain } from "viem";
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
  { id: "M2", category: "Monthly", name: "4.5GB", validity: "30 Days", cost_naira: 2200 },
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

  // Modals States
  const [selectedReceipt, setSelectedReceipt] = useState<any>(null);
  const [isSupportOpen, setIsSupportOpen] = useState(false);
  const [isSelectionModalOpen, setIsSelectionModalOpen] = useState(false);
  const [modalTitle, setModalTitle] = useState("");
  const [modalOptions, setModalOptions] = useState<string[]>([]);
  const [modalCallback, setModalCallback] = useState<((value: string) => void) | null>(null);

  // Validation States
  const [customerName, setCustomerName] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const [supportMessage, setSupportMessage] = useState("");
  const [supportFile, setSupportFile] = useState<File | null>(null);
  const [isSendingSupport, setIsSendingSupport] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [toast, setToast] = useState<{title: string, message: string, type: 'success' | 'error'} | null>(null);

  // Token & Service States
  const [activeService, setActiveService] = useState(SERVICES[0]);
  const [elecProvider, setElecProvider] = useState(ELECTRICITY_PROVIDERS[0]);
  const [cableProvider, setCableProvider] = useState(CABLE_PROVIDERS[0]);
  const [telecomProvider, setTelecomProvider] = useState(TELECOM_PROVIDERS[0]);
  const [meterType, setMeterType] = useState<"prepaid" | "postpaid">("prepaid");
  const [activeDataCategory, setActiveDataCategory] = useState(DATA_CATEGORIES[0]);
  const [selectedDataPlan, setSelectedDataPlan] = useState<any>(null);
  const [selectedToken, setSelectedToken] = useState(SUPPORTED_TOKENS[0]);
  const [walletBalance, setWalletBalance] = useState("0.00");
  const [isFetchingBalance, setIsFetchingBalance] = useState(false);
  const [exchangeRate, setExchangeRate] = useState<number>(1550); 
  const [transactions, setTransactions] = useState<any[]>([]);

  // Env Config
  const isMainnet = process.env.NEXT_PUBLIC_NETWORK === "celo";
  const activeChain = isMainnet ? celo : celoSepolia;
  const ABAPAY_CONTRACT = process.env.NEXT_PUBLIC_ABAPAY_ADDRESS as `0x${string}`;

  useEffect(() => {
    async function initSystem() {
      const savedHistory = localStorage.getItem("abapay_history");
      if (savedHistory) setTransactions(JSON.parse(savedHistory));

      try {
        const rateRes = await fetch('/api/rate');
        const rateData = await rateRes.json();
        if (rateData.success && rateData.abaPayRate) setExchangeRate(Number(rateData.abaPayRate));
      } catch (e) {}

      if (typeof window !== "undefined" && (window as any).ethereum) {
        const eth = (window as any).ethereum;
        if (eth.isMiniPay) setIsMiniPay(true);
        const walletClient = createWalletClient({ chain: activeChain, transport: custom(eth) });
        walletClient.requestAddresses().then(([acc]) => {
          setAddress(acc);
          setClient(walletClient);
        }).catch(() => console.log("User disconnected"));
      }
      setTimeout(() => setIsInitiallyLoading(false), 2000);
    }
    initSystem();
  }, [activeChain]);

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
            address: tokenAddress as `0x${string}`,
            abi: ERC20_ABI,
            functionName: 'balanceOf',
            args: [address],
          });
        }
        setWalletBalance(parseFloat(formatUnits(balanceWei as bigint, selectedToken.decimals)).toFixed(4));
      } catch (error) {
        setWalletBalance("0.00");
      }
      setIsFetchingBalance(false);
    }
    fetchBalance();
  }, [address, selectedToken, activeChain, isMainnet]);

  const { cryptoToCharge, currentFee } = useMemo(() => {
    const bill = parseFloat(nairaAmount) || 0;
    const fee = (activeService.id === "ELECTRICITY" || activeService.id === "CABLE") ? 100 : 0;
    const crypto = (bill + fee) / exchangeRate;
    return { cryptoToCharge: crypto.toFixed(4), currentFee: fee };
  }, [nairaAmount, exchangeRate, activeService]);

  const handlePayment = async () => {
    if (!address || !client) return setStatus("Connect Wallet First");
    if (selectedToken.symbol === "CELO") return;
    if (parseFloat(cryptoToCharge) > parseFloat(walletBalance)) return setStatus("Insufficient Balance");

    setStatus("Initiating Escrow...");

    try {
      const valueInWei = parseUnits(cryptoToCharge, selectedToken.decimals);
      const tokenAddress = isMainnet ? selectedToken.mainnet : selectedToken.sepolia;

      await client.writeContract({
        address: tokenAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [ABAPAY_CONTRACT, valueInWei],
        account: address,
      });

      const activeServiceID = activeService.id === "ELECTRICITY" ? elecProvider : 
                              activeService.id === "CABLE" ? cableProvider : 
                              telecomProvider; 

      const hash = await client.writeContract({
        address: ABAPAY_CONTRACT,
        abi: ABAPAY_ABI,
        functionName: 'payBill',
        args: [tokenAddress, activeServiceID, accountNumber, valueInWei],
        account: address,
      });

      setStatus("Vending Utility...");

      // CREATE LOCAL RECORD IMMEDIATELY
      const newTx = { 
        id: hash.slice(0,10), 
        date: new Date().toLocaleString(), 
        status: "PENDING", 
        amountNaira: nairaAmount, 
        amountCrypto: cryptoToCharge,
        tokenUsed: selectedToken.symbol,
        service: activeService.name, 
        network: activeServiceID.toUpperCase(), 
        account: accountNumber,
        txHash: hash 
      };

      const res = await fetch('/api/pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serviceID: activeServiceID,
          billersCode: accountNumber,
          amount: cryptoToCharge,
          token: selectedToken.symbol,
          txHash: hash,
          variation_code: activeService.id === "ELECTRICITY" ? meterType : 'prepaid',
          phone: customerPhone || accountNumber
        })
      });

      const result = await res.json();
      newTx.status = result.success ? "SUCCESS" : "FAILED/DELAYED";
      
      const updatedHistory = [newTx, ...transactions];
      setTransactions(updatedHistory);
      localStorage.setItem("abapay_history", JSON.stringify(updatedHistory));
      setStatus(result.success ? "Success!" : "Vending Delayed. Contact Support.");

    } catch (e) {
      console.error(e);
      setStatus("Transaction Cancelled.");
    }
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
        <div className="fixed inset-0 z-[100] bg-slate-900/60 backdrop-blur-sm flex justify-center items-center p-4 animate-in fade-in">
           <div className="bg-white w-full max-w-sm rounded-[2.5rem] shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200">
              <div className="bg-emerald-600 p-8 text-white text-center relative">
                 <button onClick={() => setSelectedReceipt(null)} className="absolute top-4 right-4 p-2 bg-white/10 rounded-full hover:bg-white/20 transition-colors"><XCircle size={20}/></button>
                 <div className="w-16 h-16 bg-white/20 rounded-full flex items-center justify-center mx-auto mb-4">
                    <CheckCircle2 size={32} />
                 </div>
                 <h2 className="text-xl font-black tracking-tight">Payment Receipt</h2>
                 <p className="text-emerald-100 text-[10px] font-bold uppercase tracking-widest mt-1">MASONODE AbaPay Protocol</p>
              </div>
              
              <div className="p-8 space-y-4">
                 <div className="flex justify-between items-center border-b border-slate-50 pb-3">
                    <span className="text-[10px] font-black text-slate-400 uppercase">Status</span>
                    <span className={`text-[10px] font-black px-2 py-1 rounded-md uppercase ${selectedReceipt.status === 'SUCCESS' ? 'bg-emerald-50 text-emerald-600' : 'bg-orange-50 text-orange-600'}`}>{selectedReceipt.status}</span>
                 </div>
                 <div className="flex justify-between items-center border-b border-slate-50 pb-3">
                    <span className="text-[10px] font-black text-slate-400 uppercase">Product</span>
                    <span className="text-xs font-bold text-slate-700">{selectedReceipt.network} {selectedReceipt.service}</span>
                 </div>
                 <div className="flex justify-between items-center border-b border-slate-50 pb-3">
                    <span className="text-[10px] font-black text-slate-400 uppercase">Account</span>
                    <span className="text-xs font-mono font-bold text-slate-700">{selectedReceipt.account}</span>
                 </div>
                 <div className="flex justify-between items-center border-b border-slate-50 pb-3">
                    <span className="text-[10px] font-black text-slate-400 uppercase">Amount</span>
                    <div className="text-right">
                       <p className="text-sm font-black text-slate-800">₦{parseFloat(selectedReceipt.amountNaira).toLocaleString()}</p>
                       <p className="text-[9px] font-bold text-slate-400">{selectedReceipt.amountCrypto} {selectedReceipt.tokenUsed}</p>
                    </div>
                 </div>
                 
                 <div className="pt-4 space-y-3">
                    <button 
                      onClick={() => window.open(`https://${isMainnet ? '' : 'sepolia.'}celoscan.io/tx/${selectedReceipt.txHash}`)}
                      className="w-full py-3 bg-slate-50 border border-slate-100 rounded-xl text-[10px] font-black uppercase text-slate-500 hover:bg-slate-100 flex items-center justify-center gap-2 transition-all"
                    >
                       Verify Transaction <ExternalLink size={12}/>
                    </button>
                    <button 
                      onClick={() => window.print()}
                      className="w-full py-4 bg-slate-900 text-white rounded-2xl text-xs font-black uppercase flex items-center justify-center gap-2 active:scale-95 transition-transform"
                    >
                       <Printer size={16}/> Print Receipt
                    </button>
                 </div>
              </div>
           </div>
        </div>
      )}

      {/* ... (Existing Toasts and Selection Modals) ... */}

      <div className="w-full max-w-md">
        <div className="flex justify-between items-center bg-white p-4 rounded-3xl shadow-sm border border-slate-100 mb-6">
          <div className="flex items-center gap-3">
            <img src="/logo.png" alt="AbaPay" className="h-10 w-auto object-contain" />
            <div className="flex flex-col">
              <span className="text-xl font-black text-slate-900 leading-none tracking-tight">AbaPay<span className="text-emerald-500">.</span></span>
              <span className="text-[8px] font-black uppercase text-slate-400 tracking-widest mt-1">Seamless Payments.</span>
            </div>
          </div>
          <div>
            {address ? (
              <div className="bg-emerald-50 border border-emerald-100 px-3 py-1.5 rounded-xl flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <span className="text-[10px] font-black text-emerald-700 font-mono tracking-tighter">
                  {address.slice(0, 5)}...{address.slice(-4)}
                </span>
              </div>
            ) : (
              <button className="bg-slate-900 text-white text-[10px] font-black uppercase px-4 py-2 rounded-xl active:scale-95">Connect</button>
            )}
          </div>
        </div>

        <div className="flex gap-2 bg-slate-200/50 p-1.5 rounded-2xl mb-6 shadow-inner">
            <button onClick={() => setActiveTab("pay")} className={`flex-1 py-3 rounded-xl text-xs font-black transition-all ${activeTab === 'pay' ? 'bg-white text-emerald-600 shadow-xl' : 'text-slate-500'}`}>PAY BILLS</button>
            <button onClick={() => setActiveTab("history")} className={`flex-1 py-3 rounded-xl text-xs font-black transition-all ${activeTab === 'history' ? 'bg-white text-emerald-600 shadow-xl' : 'text-slate-500'}`}>HISTORY</button>
        </div>

        {activeTab === 'pay' ? (
          <div className="bg-white border border-slate-100 rounded-[2.5rem] p-8 shadow-2xl animate-in fade-in zoom-in-95">
             {/* ... PAY TAB CONTENT (Keep your existing layout here) ... */}
             <div className="grid grid-cols-4 gap-3 mb-6">
                {SERVICES.map(s => (
                    <button key={s.id} onClick={() => setActiveService(s)} className={`p-4 rounded-2xl border-2 transition-all flex flex-col items-center gap-2 ${activeService.id === s.id ? 'border-emerald-500 bg-emerald-50/50' : 'border-slate-50'}`}>
                        <s.icon size={20} className={s.color} />
                        <span className="text-[8px] font-black uppercase tracking-widest">{s.id.slice(0,4)}</span>
                    </button>
                ))}
            </div>

            <div className="space-y-5">
                <div className="bg-slate-50 border border-slate-100 p-4 rounded-2xl flex justify-between items-center">
                  <div className="flex items-center gap-2 cursor-pointer" onClick={() => openPremiumSelection("Select Token", SUPPORTED_TOKENS.map(t => t.symbol), (s) => setSelectedToken(SUPPORTED_TOKENS.find(t => t.symbol === s)!))}>
                     <span className="text-xl">{selectedToken.icon}</span>
                     <span className="font-black text-slate-800 uppercase text-sm tracking-tight">{selectedToken.symbol}</span>
                     <ChevronDown size={14} className="text-slate-400"/>
                  </div>
                  <div className="text-right">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Balance</p>
                    <p className="font-mono font-black text-sm text-slate-800">{walletBalance}</p>
                  </div>
                </div>

                <input 
                    type="tel" placeholder="08000000000"
                    maxLength={11}
                    className="w-full bg-slate-50 border border-slate-100 p-5 rounded-2xl font-black text-xl text-slate-800 outline-none focus:border-emerald-500 transition-all"
                    value={accountNumber}
                    onChange={(e) => setAccountNumber(e.target.value.replace(/[^0-9]/g, ''))}
                />

                <div className="relative">
                    <input 
                        type="number" placeholder="500"
                        className="w-full bg-slate-50 border border-slate-100 p-5 rounded-2xl font-black text-xl text-slate-800 outline-none"
                        value={nairaAmount}
                        onChange={(e) => setNairaAmount(e.target.value)}
                    />
                    <div className="absolute right-4 top-1/2 -translate-y-1/2 text-right">
                        <p className="text-[10px] font-black text-emerald-600">{cryptoToCharge} {selectedToken.symbol}</p>
                    </div>
                </div>

                {status && <div className="p-4 rounded-xl bg-slate-50 border text-[10px] font-bold text-slate-600">{status}</div>}

                <button onClick={handlePayment} className="w-full bg-slate-900 text-white font-black py-5 rounded-[1.5rem] flex items-center justify-center gap-3 transition-all active:scale-95">
                    <ShieldCheck size={20} className="text-emerald-400" /> CONFIRM & PAY
                </button>
            </div>
          </div>
        ) : (
          <div className="bg-white border border-slate-100 rounded-[2.5rem] p-6 shadow-2xl animate-in slide-in-from-bottom-4">
             {transactions.length === 0 ? (
                <div className="py-20 text-center">
                    <Receipt size={40} className="mx-auto text-slate-200 mb-4" />
                    <p className="text-slate-400 text-xs font-bold uppercase">No activity found</p>
                </div>
             ) : (
                <div className="space-y-4">
                    {transactions.map((tx, idx) => (
                        <div 
                          key={idx} 
                          onClick={() => setSelectedReceipt(tx)} // OPEN RECEIPT
                          className="p-4 bg-slate-50 rounded-2xl border border-slate-100 flex justify-between items-center hover:bg-emerald-50 transition-colors cursor-pointer group"
                        >
                            <div>
                                <p className="text-xs font-black text-slate-800 uppercase group-hover:text-emerald-700">{tx.network} {tx.service}</p>
                                <p className="text-[10px] text-slate-500">{tx.date} • <span className={tx.status === 'SUCCESS' ? 'text-emerald-600' : 'text-orange-500'}>{tx.status}</span></p>
                            </div>
                            <div className="text-right">
                                <p className="text-xs font-black text-emerald-600">₦{tx.amountNaira}</p>
                                <p className="text-[8px] font-bold text-slate-300 uppercase">View Details</p>
                            </div>
                        </div>
                    ))}
                </div>
             )}
          </div>
        )}

        <footer className="mt-12 w-full border-t border-slate-200 pt-8 pb-4 flex flex-col items-center gap-4">
          <div className="flex items-center gap-2 opacity-50">
             <ShieldCheck size={14} className="text-emerald-600" />
             <span className="text-[10px] font-bold text-slate-500 uppercase">Secured by Celo Network</span>
          </div>
          <p className="text-[9px] font-medium text-slate-300 uppercase tracking-[0.2em]">© 2026 MASONODE ORGANISATION</p>
        </footer>
      </div>
    </main>
  );
}
