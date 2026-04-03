"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { createWalletClient, createPublicClient, custom, http, parseUnits, formatUnits, defineChain } from "viem";
import { celo, celoSepolia } from "viem/chains";
import { 
  Wallet, Receipt, ShieldCheck, Zap, AlertTriangle, 
  CheckCircle2, ExternalLink, Lightbulb, Phone, Wifi, Tv, 
  ChevronDown, Loader2, HelpCircle, XCircle, Mail, 
  Paperclip, Send, Coins, Briefcase
} from "lucide-react";
import { supabase } from "@/utils/supabase";

// --- WEB3 CONFIG ---
const ABAPAY_ABI = [{"inputs":[{"internalType":"string","name":"serviceType","type":"string"},{"internalType":"string","name":"accountNumber","type":"string"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"payBill","outputs":[],"stateMutability":"nonpayable","type":"function"}];
const ERC20_ABI = [
  {"inputs":[{"internalType":"address","name":"spender","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"approve","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"address","name":"account","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"}
];

// 1. PREMIUM COLOURFUL ICONS
const SERVICES = [
  { id: "AIRTIME", name: "Buy Airtime", icon: Phone, color: "text-[#34d399]" /* Emerald */, bg: "bg-emerald-500/10" },
  { id: "DATA", name: "Buy Data", icon: Wifi, color: "text-[#a855f7]" /* Purple */, bg: "bg-purple-500/10" },
  { id: "ELECTRICITY", name: "Electricity", icon: Lightbulb, color: "text-[#f97316]" /* Orange */, bg: "bg-orange-500/10" },
  { id: "CABLE", name: "Cable TV", icon: Tv, color: "text-[#ec4899]" /* Pink */, bg: "bg-pink-500/10" },
];

const ELECTRICITY_PROVIDERS = ["aba-electric", "ikedc", "ekedc", "ibedc", "aedc", "kedco", "phed"];
const CABLE_PROVIDERS = ["dstv", "gotv", "startimes", "showmax"];
const TELECOM_PROVIDERS = ["mtn", "airtel", "glo", "9mobile"];

const SUPPORTED_TOKENS = [
  { symbol: "USDT", decimals: 6, mainnet: "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e", sepolia: "0xd077A400968890Eacc75cdc901F0356c943e4fDb", icon: "💵" },
  { symbol: "USDC", decimals: 18, mainnet: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", sepolia: "0x874069Fa1Eb16D44d622F2e0Ca25eeA172369bC1", icon: "🪙" },
  { symbol: "CELO", decimals: 18, mainnet: "native", sepolia: "native", icon: "🟡" },
];

// PRE-SELECT AMOUNT BUTTONS (Airtime)
const PRE_SELECT_AMOUNTS = ["100", "200", "500", "1000", "2000"];

// 2. DATA PLANS DATA STRUCTURE
const MOCK_DATA_PLANS = [
  // DAILY PLANS
  { id: "D1", category: "Daily", name: "100MB", validity: "24 Hrs", cost_naira: 100 },
  { id: "D2", category: "Daily", name: "350MB", validity: "24 Hrs", cost_naira: 200 },
  { id: "D3", category: "Daily", name: "1GB", validity: "24 Hrs", cost_naira: 350 },
  // WEEKLY PLANS
  { id: "W1", category: "Weekly", name: "1GB", validity: "7 Days", cost_naira: 600 },
  { id: "W2", category: "Weekly", name: "2.5GB", validity: "7 Days", cost_naira: 1200 },
  { id: "W3", category: "Weekly", name: "Broadband Extra", validity: "7 Days", cost_naira: 3500, isBroadband: true },
  // MONTHLY PLANS
  { id: "M1", category: "Monthly", name: "1.5GB", validity: "30 Days", cost_naira: 1100 },
  { id: "M2", category: "Monthly", name: "4.5GB", validity: "30 Days", cost_naira: 2200 },
  { id: "M3", category: "Monthly", name: "Broadband Unlimited", validity: "30 Days", cost_naira: 18000, isBroadband: true },
];

const DATA_CATEGORIES = ["Daily", "Weekly", "Monthly"];

export default function Home() {
  // 3. INITIAL LOADING STATE (SPLASH SCREEN)
  const [isInitiallyLoading, setIsInitiallyLoading] = useState(true);

  // --- SYSTEM STATES ---
  const [address, setAddress] = useState<string | null>(null);
  const [client, setClient] = useState<any>(null);
  const [nairaAmount, setNairaAmount] = useState(""); 
  const [accountNumber, setAccountNumber] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [status, setStatus] = useState("");
  const [activeTab, setActiveTab] = useState("pay");
  
  // Validation & Support States
  const [customerName, setCustomerName] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const [isSupportOpen, setIsSupportOpen] = useState(false);
  const [supportMessage, setSupportMessage] = useState("");
  const [supportFile, setSupportFile] = useState<File | null>(null);
  const [isSendingSupport, setIsSendingSupport] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [toast, setToast] = useState<{title: string, message: string, type: 'success' | 'error'} | null>(null);

  const showToast = (title: string, message: string, type: 'success' | 'error' = 'success') => {
    setToast({ title, message, type });
    setTimeout(() => setToast(null), 5000);
  };

  // Service States
  const [activeService, setActiveService] = useState(SERVICES[0]);
  const [elecProvider, setElecProvider] = useState(ELECTRICITY_PROVIDERS[0]);
  const [cableProvider, setCableProvider] = useState(CABLE_PROVIDERS[0]);
  const [telecomProvider, setTelecomProvider] = useState(TELECOM_PROVIDERS[0]);
  const [meterType, setMeterType] = useState<"prepaid" | "postpaid">("prepaid");
  
  // New Service Sub-tabs (Data)
  const [activeDataCategory, setActiveDataCategory] = useState(DATA_CATEGORIES[0]);
  const [selectedDataPlan, setSelectedDataPlan] = useState<any>(null);

  // 4. NEW PREMIUM MODAL STATE
  const [isSelectionModalOpen, setIsSelectionModalOpen] = useState(false);
  const [modalTitle, setModalTitle] = useState("");
  const [modalOptions, setModalOptions] = useState<string[]>([]);
  const [modalCallback, setModalCallback] = useState<((value: string) => void) | null>(null);
  
  // Token & Balance States
  const [selectedToken, setSelectedToken] = useState(SUPPORTED_TOKENS[0]);
  const [walletBalance, setWalletBalance] = useState("0.00");
  const [isFetchingBalance, setIsFetchingBalance] = useState(false);

  const [exchangeRate, setExchangeRate] = useState<number>(1550); 
  const [transactions, setTransactions] = useState<any[]>([]);

  // Env Config
  const isMainnet = process.env.NEXT_PUBLIC_NETWORK === "celo";
  const activeChain = isMainnet ? celo : celoSepolia;
  const ABAPAY_CONTRACT = process.env.NEXT_PUBLIC_ABAPAY_ADDRESS as `0x${string}`;

  // --- INITIALIZATION ---
  useEffect(() => {
    async function initSystem() {
      // 5. Initialize dApp state
      const savedHistory = localStorage.getItem("abapay_history");
      if (savedHistory) setTransactions(JSON.parse(savedHistory));
      
      try {
        const rateRes = await fetch('/api/rate');
        const rateData = await rateRes.json();
        if (rateData.success && rateData.abaPayRate) setExchangeRate(Number(rateData.abaPayRate));
      } catch (consoleError) {}

      // Check wallet injection
      if (typeof window !== "undefined" && (window as any).ethereum) {
        const walletClient = createWalletClient({ chain: activeChain, transport: custom((window as any).ethereum) });
        walletClient.requestAddresses().then(([acc]) => {
          setAddress(acc);
          setClient(walletClient);
        });
      }

      // Hide Splash Screen when basic dApp state is ready
      setTimeout(() => setIsInitiallyLoading(false), 2000);
    }
    initSystem();
  }, [activeChain]);

  // --- FETCH LIVE WALLET BALANCE ---
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

  // --- TELECOM AUTO-DETECT LOGIC ---
  useEffect(() => {
    if ((activeService.id === "AIRTIME" || activeService.id === "DATA") && accountNumber.length >= 4) {
      const prefix = accountNumber.substring(0, 4);
      if (["0803","0806","0810","0813","0814","0816","0903","0906","0913","0916","0703","0706"].includes(prefix)) setTelecomProvider("mtn");
      else if (["0802","0808","0812","0902","0907","0912","0701","0708"].includes(prefix)) setTelecomProvider("airtel");
      else if (["0805","0807","0811","0905","0705","0915"].includes(prefix)) setTelecomProvider("glo");
      else if (["0809","0817","0818","0908","0909"].includes(prefix)) setTelecomProvider("9mobile");
    }
  }, [accountNumber, activeService]);

  // --- VTPASS MERCHANT VERIFICATION ---
  useEffect(() => {
    if ((activeService.id === "ELECTRICITY" || activeService.id === "CABLE") && accountNumber.length >= 10) {
      verifyMerchant();
    } else {
      setCustomerName(null);
    }
  }, [accountNumber, elecProvider, cableProvider, activeService, meterType]);

  const verifyMerchant = async () => {
    setIsVerifying(true);
    setCustomerName(null);
    try {
        const serviceID = activeService.id === "ELECTRICITY" ? elecProvider : cableProvider;
        const res = await fetch(`${process.env.NEXT_PUBLIC_APP_MODE === 'live' ? 'https://vtpass.com/api' : 'https://sandbox.vtpass.com/api'}/merchant-verify`, {
            method: 'POST',
            headers: { 
                'api-key': process.env.NEXT_PUBLIC_VTPASS_API_KEY || '', 
                'public-key': process.env.NEXT_PUBLIC_VTPASS_PUBLIC_KEY || '',
                'Content-Type': 'application/json' 
            },
            body: JSON.stringify({ billersCode: accountNumber, serviceID: serviceID, type: activeService.id === "ELECTRICITY" ? meterType : 'prepaid' }) 
        });
        const data = await res.json();
        if (data.code === '000') setCustomerName(data.content.Customer_Name);
    } catch (e) { console.error("Verify Error", e); }
    setIsVerifying(false);
  };

  const { cryptoToCharge, currentFee } = useMemo(() => {
    const bill = parseFloat(nairaAmount) || 0;
    const fee = (activeService.id === "ELECTRICITY" || activeService.id === "CABLE") ? 100 : 0;
    const crypto = (bill + fee) / exchangeRate;
    return { cryptoToCharge: crypto.toFixed(4), currentFee: fee };
  }, [nairaAmount, exchangeRate, activeService]);

  // Strict Validation Logic
  const isFormValid = useMemo(() => {
    if (!nairaAmount || parseFloat(nairaAmount) <= 0) return false;
    
    // Strict 11-digit Airtime/Data check
    if (activeService.id === "AIRTIME" || activeService.id === "DATA") {
      return accountNumber.length === 11 && accountNumber.startsWith("0");
    }
    
    // Meter/Cable requires verification success
    if (activeService.id === "ELECTRICITY" || activeService.id === "CABLE") {
      return accountNumber.length >= 10 && customerName !== null;
    }
    
    return false;
  }, [accountNumber, nairaAmount, activeService, customerName]);

  // --- EXECUTE PAYMENT ---
  const handlePayment = async () => {
    if (!address || !client) return setStatus("Connect Wallet First");
    
    // Smart Contract currently only supports USDT.
    if (selectedToken.symbol !== "USDT") {
      return showToast("Unsupported Asset", `AbaPay Smart Contract upgrade required to pay with ${selectedToken.symbol}. Please select USDT.`, "error");
    }

    if (parseFloat(cryptoToCharge) > parseFloat(walletBalance)) {
      return setStatus(`Insufficient ${selectedToken.symbol} Balance.`);
    }

    setStatus("Initiating Blockchain Escrow...");

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
        args: [activeServiceID, accountNumber, valueInWei],
        account: address,
      });

      setStatus(`${selectedToken.symbol} Secured. Vending Utility...`);

      const res = await fetch('/api/pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serviceID: activeServiceID,
          billersCode: accountNumber,
          amount: cryptoToCharge,
          txHash: hash,
          variation_code: activeService.id === "ELECTRICITY" ? meterType : 'prepaid',
          phone: customerPhone || accountNumber
        })
      });

      const result = await res.json();

      if (result.success) {
        setStatus("Success! Token/Ref Dispatched.");
        const newTx = { id: hash.slice(0,8), date: new Date().toLocaleString(), status: "SUCCESS", amountNaira: nairaAmount, service: activeService.name, network: activeServiceID.toUpperCase(), txHash: hash };
        setTransactions([newTx, ...transactions]);
        localStorage.setItem("abapay_history", JSON.stringify([newTx, ...transactions]));
        // Refresh balance
        const publicClient = createPublicClient({ chain: activeChain, transport: http() });
        const balanceWei = await publicClient.readContract({ address: tokenAddress as `0x${string}`, abi: ERC20_ABI, functionName: 'balanceOf', args: [address] });
        setWalletBalance(parseFloat(formatUnits(balanceWei as bigint, selectedToken.decimals)).toFixed(4));
      } else {
        setStatus("Utility Vending Delayed. Admin Notified.");
      }
    } catch (e) { setStatus("Transaction Cancelled."); }
  };

  const submitSupportTicket = async () => {
    if (!supportMessage.trim()) return;
    setIsSendingSupport(true);
    try {
      const formData = new FormData();
      formData.append("message", supportMessage);
      if (address) formData.append("userAddress", address);
      if (supportFile) formData.append("file", supportFile);

      await fetch('/api/support', { method: 'POST', body: formData });
      
      setIsSupportOpen(false);
      setSupportMessage("");
      setSupportFile(null);
      showToast("Ticket Submitted", "AbaPay Support has received your request.", "success");
    } catch (error) {
      showToast("Connection Error", "Failed to send the ticket.", "error");
    } finally {
      setIsSendingSupport(false);
    }
  };

  // 6. HELPER TO OPEN SELECTION MODAL
  const openPremiumSelection = (title: string, options: string[], callback: (value: string) => void) => {
    setModalTitle(title);
    setModalOptions(options);
    setModalCallback(() => callback);
    setIsSelectionModalOpen(true);
  };

  // 7. Dynamic Data Plan Filtering & USDT Calculation
  const filteredDataPlans = useMemo(() => {
    return MOCK_DATA_PLANS.filter(plan => plan.category === activeDataCategory);
  }, [activeDataCategory]);

  // --- PREMIUM UI BUILD ---
  return (
    <main className="min-h-screen bg-slate-50 text-slate-900 font-sans p-4 flex flex-col items-center pb-20 relative">

      {/* --- ADD CUSTOM LOGO SCALING ANIMATION --- */}
      <style>{`
        @keyframes logoScale {
          0%, 100% { transform: scale(1); opacity: 0.9; }
          50% { transform: scale(1.1); opacity: 1; }
        }
        .animate-logo-scale { animation: logoScale 1.5s ease-in-out infinite; }
      `}</style>

      {/* --- PREMIUM INTRO SPLASH SCREEN --- */}
      {isInitiallyLoading && (
        <div className="fixed inset-0 z-[100] bg-white flex flex-col items-center justify-center animate-in fade-out duration-500 fill-mode-forwards" style={{ animationDelay: '1.5s' }}>
          <img src="/logo.png" alt="AbaPay" className="h-28 w-auto object-contain animate-logo-scale mb-10" />
          <div className="flex flex-col items-center gap-2">
             <div className="w-12 h-0.5 bg-emerald-500 rounded-full animate-pulse" />
             <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Loading AbaPay Protocol...</p>
          </div>
        </div>
      )}
      
      {/* --- TOAST NOTIFICATION --- */}
      {toast && (
        <div className="fixed top-4 right-4 sm:top-6 sm:right-6 z-[100] animate-in slide-in-from-top-8 fade-in duration-300">
          <div className="bg-[#111114] border border-slate-800 shadow-2xl rounded-2xl p-4 flex items-start gap-3 w-[300px]">
            <div className={`p-2 rounded-full shrink-0 ${toast.type === 'success' ? 'bg-emerald-500/10' : 'bg-red-500/10'}`}>
              {toast.type === 'success' ? <CheckCircle2 className="text-emerald-500" size={20} /> : <AlertTriangle className="text-red-500" size={20} />}
            </div>
            <div className="flex-1">
              <h4 className="text-white font-black text-sm tracking-tight">{toast.title}</h4>
              <p className="text-slate-400 text-xs mt-0.5 leading-snug">{toast.message}</p>
            </div>
            <button onClick={() => setToast(null)} className="shrink-0 text-slate-500 hover:text-slate-300"><XCircle size={16} /></button>
          </div>
        </div>
      )}

      {/* --- PREMIUM COMPANY/NETWORK SELECTION MODAL (NOW CENTERED) --- */}
      {isSelectionModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center p-4 animate-in fade-in" onClick={() => setIsSelectionModalOpen(false)}>
           <div className="bg-white w-full max-w-sm rounded-[2rem] shadow-2xl p-6 animate-in zoom-in-95 duration-200" onClick={(e) => e.stopPropagation()}>
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-lg font-bold text-slate-800">{modalTitle}</h2>
                <button onClick={() => setIsSelectionModalOpen(false)} className="p-2 bg-slate-100 rounded-full hover:bg-slate-200 transition-colors"><XCircle size={20} className="text-slate-500" /></button>
              </div>
              <div className="space-y-2 max-h-[50vh] overflow-y-auto">
                 {modalOptions.map(option => (
                   <button 
                     key={option} 
                     onClick={() => { modalCallback?.(option); setIsSelectionModalOpen(false); }}
                     className="w-full text-left p-4 rounded-xl font-bold text-slate-700 bg-slate-50 border border-slate-100 uppercase text-xs hover:border-emerald-300 hover:bg-emerald-50/50 transition-all flex justify-between items-center"
                   >
                     {option}
                     {/* Dynamic checkmark if selected */}
                     {(telecomProvider === option || elecProvider === option || cableProvider === option || selectedToken.symbol === option) && <CheckCircle2 size={16} className="text-emerald-500"/>}
                   </button>
                 ))}
              </div>
           </div>
        </div>
      )}

      {/* --- SUPPORT MODAL (NOW CENTERED) --- */}
      {isSupportOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center p-4 animate-in fade-in">
          <div className="bg-white w-full max-w-md rounded-[2rem] shadow-2xl p-6 animate-in zoom-in-95 duration-200">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-bold flex items-center gap-2"><HelpCircle className="text-emerald-500"/> Customer Support</h2>
              <button onClick={() => setIsSupportOpen(false)} className="p-2 bg-slate-100 rounded-full hover:bg-slate-200"><XCircle size={20} className="text-slate-500" /></button>
            </div>
            <textarea 
              className="w-full bg-slate-50 border border-slate-200 rounded-xl p-4 mb-4 text-sm outline-none focus:border-emerald-500"
              rows={4} placeholder="Describe your issue..."
              value={supportMessage} onChange={(e) => setSupportMessage(e.target.value)}
            />
            <div className="flex gap-2 mb-6">
              <input type="file" ref={fileInputRef} className="hidden" onChange={(e) => setSupportFile(e.target.files?.[0] || null)} />
              <button onClick={() => fileInputRef.current?.click()} className="flex-1 py-3 bg-slate-100 hover:bg-slate-200 rounded-xl text-sm font-bold flex items-center justify-center gap-2">
                <Paperclip size={16} /> {supportFile ? "File Attached" : "Attach Receipt"}
              </button>
            </div>
            <button onClick={submitSupportTicket} disabled={isSendingSupport} className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-4 rounded-xl flex items-center justify-center gap-2 transition-colors active:scale-95 disabled:opacity-50">
              {isSendingSupport ? <Loader2 className="animate-spin" /> : <><Send size={18}/> Send Ticket</>}
            </button>
          </div>
        </div>
      )}

      <div className="w-full max-w-md">
        {/* --- MAIN HEADER & PROFILE --- */}
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
              <button className="bg-slate-900 text-white text-[10px] font-black uppercase px-4 py-2 rounded-xl active:scale-95 hover:bg-slate-800 transition-all">Connect</button>
            )}
          </div>
        </div>

        {/* --- TABS --- */}
        <div className="flex gap-2 bg-slate-200/50 p-1.5 rounded-2xl mb-6 shadow-inner">
            <button onClick={() => setActiveTab("pay")} className={`flex-1 py-3 rounded-xl text-xs font-black transition-all ${activeTab === 'pay' ? 'bg-white text-emerald-600 shadow-xl' : 'text-slate-500 hover:text-slate-700'}`}>PAY BILLS</button>
            <button onClick={() => setActiveTab("history")} className={`flex-1 py-3 rounded-xl text-xs font-black transition-all ${activeTab === 'history' ? 'bg-white text-emerald-600 shadow-xl' : 'text-slate-500 hover:text-slate-700'}`}>HISTORY</button>
        </div>

        {activeTab === 'pay' ? (
          <div className="bg-white border border-slate-100 rounded-[2.5rem] p-8 shadow-2xl shadow-emerald-900/10 animate-in fade-in zoom-in-95">
            
            {/* SERVICE SELECTOR (colorful icons) */}
            <div className="grid grid-cols-4 gap-3 mb-6">
                {SERVICES.map(s => (
                    <button 
                        key={s.id} 
                        onClick={() => { setActiveService(s); setStatus(""); setAccountNumber(""); setCustomerName(null); setNairaAmount(""); setSelectedDataPlan(null); }}
                        className={`p-4 rounded-2xl border-2 transition-all flex flex-col items-center gap-2 ${activeService.id === s.id ? 'border-emerald-500 bg-emerald-50/50 scale-105' : 'border-slate-50 bg-slate-50/50 hover:bg-slate-100'}`}
                    >
                        <s.icon size={20} className={s.color} />
                        <span className="text-[8px] font-black uppercase tracking-widest">{s.id.slice(0,4)}</span>
                    </button>
                ))}
            </div>

            {/* FORM INPUTS */}
            <div className="space-y-5">
                
                {/* TOKEN SELECTOR & BALANCE DASHBOARD */}
                <div className="bg-slate-50 border border-slate-100 p-4 rounded-2xl flex justify-between items-center animate-in fade-in">
                  <div 
                    className="flex items-center gap-2 cursor-pointer hover:bg-slate-100 p-2 -ml-2 rounded-xl transition-colors" 
                    onClick={() => openPremiumSelection("Select Token", SUPPORTED_TOKENS.map(t => t.symbol), (symbol) => setSelectedToken(SUPPORTED_TOKENS.find(t => t.symbol === symbol)!))}
                  >
                     <span className="text-xl">{selectedToken.icon}</span>
                     <span className="font-black text-slate-800 uppercase text-sm tracking-tight">{selectedToken.symbol}</span>
                     <ChevronDown size={14} className="text-slate-400"/>
                  </div>
                  <div className="text-right">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Available Balance</p>
                    <div className="flex items-center justify-end gap-1">
                      {isFetchingBalance ? <Loader2 size={12} className="animate-spin text-emerald-500"/> : <Coins size={12} className="text-emerald-500"/>}
                      <p className="font-mono font-black text-sm text-slate-800">{walletBalance} <span className="text-[10px]">{selectedToken.symbol}</span></p>
                    </div>
                  </div>
                </div>

                {/* PREMIUM SELECTION TRIGGERS (Network/Provider) */}
                <div className="animate-in slide-in-from-left-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase mb-2 block">
                        {activeService.id === "AIRTIME" || activeService.id === "DATA" ? "Network Selection" : "Choose Provider"}
                    </label>
                    
                    <button 
                      onClick={() => {
                        const title = activeService.id === "AIRTIME" || activeService.id === "DATA" ? "Select Network" : "Select Provider";
                        const options = activeService.id === "ELECTRICITY" ? ELECTRICITY_PROVIDERS : activeService.id === "CABLE" ? CABLE_PROVIDERS : TELECOM_PROVIDERS;
                        const callback = activeService.id === "ELECTRICITY" ? setElecProvider : activeService.id === "CABLE" ? setCableProvider : setTelecomProvider;
                        openPremiumSelection(title, options, callback);
                      }}
                      className="w-full bg-slate-50 border border-slate-100 p-4 rounded-2xl font-bold text-slate-800 outline-none uppercase text-xs hover:border-emerald-300 transition-all text-left flex justify-between items-center"
                    >
                      <span>
                        {activeService.id === "ELECTRICITY" ? elecProvider.toUpperCase() : 
                         activeService.id === "CABLE" ? cableProvider.toUpperCase() : 
                         telecomProvider.toUpperCase()}
                      </span>
                      <ChevronDown size={14} className="text-slate-400"/>
                    </button>

                    {/* PREPAID / POSTPAID TOGGLE (Electricity Only) */}
                    {activeService.id === "ELECTRICITY" && (
                       <div className="flex gap-2 mt-3 p-1 bg-slate-100 rounded-xl border border-slate-200 shadow-inner">
                          <button onClick={() => setMeterType("prepaid")} className={`flex-1 py-2.5 text-[10px] font-black uppercase rounded-lg transition-colors ${meterType === "prepaid" ? "bg-white shadow-sm text-emerald-600" : "text-slate-500"}`}>Prepaid</button>
                          <button onClick={() => setMeterType("postpaid")} className={`flex-1 py-2.5 text-[10px] font-black uppercase rounded-lg transition-colors ${meterType === "postpaid" ? "bg-white shadow-sm text-emerald-600" : "text-slate-500"}`}>Postpaid</button>
                       </div>
                    )}
                </div>

                {/* ACCOUNT NUMBER / PHONE INPUT */}
                <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase mb-2 flex justify-between">
                      <span>{activeService.id === "AIRTIME" || activeService.id === "DATA" ? "Phone Number (11 Digits)" : "Account / Meter No"}</span>
                      {(activeService.id === "AIRTIME" || activeService.id === "DATA") && (
                        <span className={accountNumber.length === 11 ? "text-emerald-500" : "text-slate-400"}>{accountNumber.length}/11</span>
                      )}
                    </label>
                    <input 
                        type="tel" placeholder={activeService.id === "AIRTIME" || activeService.id === "DATA" ? "08000000000" : "Enter Meter Number"}
                        maxLength={activeService.id === "AIRTIME" || activeService.id === "DATA" ? 11 : 20}
                        className={`w-full bg-slate-50 border p-5 rounded-2xl font-black text-xl text-slate-800 outline-none transition-all ${
                          (activeService.id === "AIRTIME" || activeService.id === "DATA") && accountNumber.length > 0 && accountNumber.length < 11 
                          ? "border-red-300 focus:border-red-500" 
                          : "border-slate-100 focus:border-emerald-500"
                        }`}
                        value={accountNumber}
                        onChange={(e) => setAccountNumber(e.target.value.replace(/[^0-9]/g, ''))}
                    />
                    {isVerifying && <p className="text-[10px] text-blue-500 font-bold mt-2 animate-pulse">Verifying Account Details...</p>}
                    {customerName && (activeService.id === "ELECTRICITY" || activeService.id === "CABLE") && (
                        <div className="mt-2 bg-emerald-500/10 p-3 rounded-xl border border-emerald-500/20 flex items-center gap-2 animate-in fade-in">
                            <CheckCircle2 size={14} className="text-emerald-600" />
                            <span className="text-[10px] font-black text-emerald-700 uppercase">{customerName}</span>
                        </div>
                    )}
                </div>

                {/* --- DATA SPECIFIC UI UPGRADE: PLANS GRID --- */}
                {activeService.id === "DATA" && (
                   <div className="bg-slate-50 border border-slate-100 p-4 rounded-2xl animate-in fade-in slide-in-from-top-4">
                      {/* Category Tabs */}
                      <div className="flex gap-1.5 mb-4 border-b border-slate-200 pb-3 overflow-x-auto">
                        {DATA_CATEGORIES.map(cat => (
                          <button key={cat} onClick={() => { setActiveDataCategory(cat); setSelectedDataPlan(null); }} className={`px-4 py-1.5 rounded-lg text-[10px] font-black uppercase transition-colors whitespace-nowrap ${activeDataCategory === cat ? 'bg-purple-500/10 text-purple-600' : 'text-slate-500 hover:bg-slate-100'}`}>{cat}</button>
                        ))}
                        {/* Broadband Shortcut tab */}
                        <button onClick={() => setActiveDataCategory("Broadband")} className={`px-4 py-1.5 flex items-center gap-1.5 rounded-lg text-[10px] font-black uppercase transition-colors ${activeDataCategory === "Broadband" ? 'bg-orange-500/10 text-orange-600' : 'text-slate-500 hover:bg-slate-100'}`}><Briefcase size={12}/> Broadband</button>
                      </div>

                      {/* Plans Grid */}
                      <div className="grid grid-cols-2 gap-3 max-h-[30vh] overflow-y-auto pr-1">
                          {(activeDataCategory === "Broadband" ? MOCK_DATA_PLANS.filter(p => p.isBroadband) : filteredDataPlans).map(plan => {
                            const cryptoPlanCost = (plan.cost_naira / exchangeRate).toFixed(4);
                            return (
                              <button key={plan.id} onClick={() => { setSelectedDataPlan(plan); setNairaAmount(plan.cost_naira.toString()); }} className={`p-4 rounded-xl border-2 transition-all flex flex-col gap-1 text-left ${selectedDataPlan?.id === plan.id ? 'border-purple-500 bg-purple-50/50 scale-105 shadow-md' : 'border-slate-100 bg-white hover:border-slate-200'}`}>
                                <p className="font-black text-slate-900 text-sm tracking-tight">{plan.name}</p>
                                <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">{plan.validity}</p>
                                <div className="mt-2 pt-2 border-t border-slate-100 flex flex-col gap-0.5">
                                    <p className="font-black text-purple-600 text-xs">₦{plan.cost_naira.toLocaleString()}</p>
                                    <p className="text-[9px] text-slate-400 font-bold">{cryptoPlanCost} {selectedToken.symbol}</p>
                                </div>
                              </button>
                            );
                          })}
                      </div>
                   </div>
                )}

                {/* NAIRA VALUE INPUT & AIRTIME PRE-SELECT */}
                <div className={activeService.id === "DATA" ? "hidden" : ""}>
                    <label className="text-[10px] font-black text-slate-400 uppercase mb-2 block">Naira Value</label>
                    <div className="relative mb-3">
                        <input 
                            type="number" placeholder="500"
                            className="w-full bg-slate-50 border border-slate-100 p-5 rounded-2xl font-black text-xl text-slate-800 outline-none focus:border-emerald-500 transition-all"
                            value={nairaAmount}
                            onChange={(e) => setNairaAmount(e.target.value)}
                        />
                        <div className="absolute right-4 top-1/2 -translate-y-1/2 text-right">
                            <p className="text-[10px] font-black text-emerald-600">{cryptoToCharge} {selectedToken.symbol}</p>
                            {currentFee > 0 && <p className="text-[8px] font-bold text-orange-500">+₦{currentFee} FEE</p>}
                        </div>
                    </div>

                    {/* Airtime Pre-Select Buttons */}
                    {activeService.id === "AIRTIME" && (
                       <div className="flex gap-2.5 overflow-x-auto py-1">
                          {PRE_SELECT_AMOUNTS.map(amount => {
                            const cryptoAmtCost = (parseInt(amount) / exchangeRate).toFixed(4);
                            return (
                              <button key={amount} onClick={() => setNairaAmount(amount)} className={`flex-1 min-w-[70px] py-3.5 rounded-xl border-2 font-black text-xs transition-all whitespace-nowrap ${nairaAmount === amount ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-slate-100 bg-slate-100 hover:bg-slate-200 text-slate-700'}`}>
                                 ₦{amount.toLocaleString()}
                                 <p className="text-[8px] mt-0.5 text-slate-400 font-normal">{cryptoAmtCost} {selectedToken.symbol}</p>
                              </button>
                            );
                          })}
                       </div>
                    )}
                </div>

                {/* OPTIONAL PHONE FOR ELECTRICITY NOTIFICATIONS */}
                {activeService.id === "ELECTRICITY" && (
                    <div className="animate-in fade-in">
                         <input 
                            type="tel" placeholder="Phone for SMS Token"
                            maxLength={11}
                            className="w-full bg-slate-50 border border-slate-100 p-4 rounded-2xl font-bold text-slate-700 outline-none focus:border-emerald-500"
                            onChange={(e) => setCustomerPhone(e.target.value.replace(/[^0-9]/g, ''))}
                        />
                    </div>
                )}

                {/* STATUS MESSAGE */}
                {status && (
                    <div className={`p-4 rounded-2xl text-[10px] font-bold border flex items-center gap-3 animate-in fade-in slide-in-from-top-2 ${status.includes('Success') ? 'bg-emerald-50 border-emerald-100 text-emerald-700' : 'bg-red-50 border-red-100 text-red-700'}`}>
                        {status.includes('Success') ? <CheckCircle2 size={16}/> : <AlertTriangle size={16}/>}
                        {status}
                    </div>
                )}

                {/* SUBMIT BUTTON */}
                <button 
                    onClick={handlePayment}
                    disabled={isVerifying || !isFormValid}
                    className="w-full bg-slate-900 hover:bg-black text-white font-black py-5 rounded-[1.5rem] flex items-center justify-center gap-3 transition-all active:scale-95 disabled:opacity-30 shadow-xl shadow-slate-900/20"
                >
                    <ShieldCheck size={20} className="text-emerald-400" /> 
                    CONFIRM & PAY {cryptoToCharge} {selectedToken.symbol}
                </button>
            </div>
          </div>
        ) : (
          <div className="bg-white border border-slate-100 rounded-[2.5rem] p-6 shadow-2xl animate-in slide-in-from-bottom-4">
             {transactions.length === 0 ? (
                <div className="py-20 text-center">
                    <Receipt size={40} className="mx-auto text-slate-200 mb-4" />
                    <p className="text-slate-400 text-xs font-bold uppercase tracking-widest">No activity found</p>
                </div>
             ) : (
                <div className="space-y-4">
                    {transactions.map((tx, idx) => (
                        <div key={idx} className="p-4 bg-slate-50 rounded-2xl border border-slate-100 flex justify-between items-center hover:bg-slate-100 transition-colors">
                            <div>
                                <p className="text-xs font-black text-slate-800 uppercase">{tx.network} {tx.service}</p>
                                <p className="text-[10px] text-slate-500">{tx.date}</p>
                            </div>
                            <div className="text-right">
                                <p className="text-xs font-black text-emerald-600">₦{tx.amountNaira}</p>
                                <a href={`https://${isMainnet ? '' : 'sepolia.'}celoscan.io/tx/${tx.txHash}`} target="_blank" className="text-[8px] font-bold text-slate-400 flex items-center justify-end gap-1 hover:text-emerald-500 transition-colors">VIEW HASH <ExternalLink size={8}/></a>
                            </div>
                        </div>
                    ))}
                </div>
             )}
          </div>
        )}

        <div className="mt-8 flex flex-col items-center gap-4">
            <button 
                onClick={() => setIsSupportOpen(true)}
                className="text-[10px] font-black text-slate-400 hover:text-emerald-500 transition-colors uppercase tracking-widest flex items-center gap-2"
            >
                <HelpCircle size={14} /> Failed Transaction? Open Support
            </button>
        </div>
      </div>
    </main>
  );
}
