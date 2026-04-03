"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { createWalletClient, createPublicClient, custom, http, parseUnits, formatUnits, defineChain } from "viem";
import { celo, celoSepolia } from "viem/chains";
import { 
  Wallet, History, Receipt, ShieldCheck, Zap, ArrowRightLeft, 
  AlertTriangle, Download, CheckCircle2, ExternalLink, Lightbulb, 
  Phone, Wifi, Tv, ChevronDown, Loader2, HelpCircle, XCircle, 
  Mail, Paperclip, Send, Coins
} from "lucide-react";
import { supabase } from "@/utils/supabase";

// --- WEB3 CONFIG ---
const ABAPAY_ABI = [{"inputs":[{"internalType":"string","name":"serviceType","type":"string"},{"internalType":"string","name":"accountNumber","type":"string"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"payBill","outputs":[],"stateMutability":"nonpayable","type":"function"}];
// Upgraded ABI to include balanceOf so we can fetch token balances
const ERC20_ABI = [
  {"inputs":[{"internalType":"address","name":"spender","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"approve","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"address","name":"account","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"}
];

const SERVICES = [
  { id: "AIRTIME", name: "Buy Airtime", icon: Phone, color: "text-blue-500", bg: "bg-blue-50" },
  { id: "DATA", name: "Buy Data", icon: Wifi, color: "text-purple-500", bg: "bg-purple-50" },
  { id: "ELECTRICITY", name: "Electricity", icon: Lightbulb, color: "text-orange-500", bg: "bg-orange-50" },
  { id: "CABLE", name: "Cable TV", icon: Tv, color: "text-pink-500", bg: "bg-pink-50" },
];

const ELECTRICITY_PROVIDERS = ["aba-electric", "ikedc", "ekedc", "ibedc", "aedc", "kedco", "phed"];
const CABLE_PROVIDERS = ["dstv", "gotv", "startimes", "showmax"];
const TELECOM_PROVIDERS = ["mtn", "airtel", "glo", "9mobile"];

// --- SUPPORTED TOKENS DICTIONARY ---
const SUPPORTED_TOKENS = [
  { symbol: "USDT", decimals: 6, mainnet: "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e", sepolia: "0xd077A400968890Eacc75cdc901F0356c943e4fDb", icon: "💵" },
  { symbol: "USDC", decimals: 18, mainnet: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", sepolia: "0x874069Fa1Eb16D44d622F2e0Ca25eeA172369bC1", icon: "🪙" },
  { symbol: "CELO", decimals: 18, mainnet: "native", sepolia: "native", icon: "🟡" },
];

export default function Home() {
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
  const [meterType, setMeterType] = useState<"prepaid" | "postpaid">("prepaid"); // NEW: Meter Type State
  
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
    const saved = localStorage.getItem("abapay_history");
    if (saved) setTransactions(JSON.parse(saved));
    
    fetch('/api/rate')
      .then(res => res.json())
      .then(data => {
        if (data.success && data.abaPayRate) setExchangeRate(Number(data.abaPayRate));
      })
      .catch(console.error);

    if (typeof window !== "undefined" && (window as any).ethereum) {
      const walletClient = createWalletClient({ chain: activeChain, transport: custom((window as any).ethereum) });
      walletClient.requestAddresses().then(([acc]) => {
        setAddress(acc);
        setClient(walletClient);
      });
    }
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
            body: JSON.stringify({ billersCode: accountNumber, serviceID: serviceID, type: activeService.id === "ELECTRICITY" ? meterType : 'prepaid' }) // Now uses dynamic meterType
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

  // --- STRICT VALIDATION LOGIC ---
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
    
    // SAFETY CHECK: Smart Contract currently only supports USDT.
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
          variation_code: activeService.id === "ELECTRICITY" ? meterType : 'prepaid', // Passes the dynamic type
          phone: customerPhone || accountNumber
        })
      });

      const result = await res.json();

      if (result.success) {
        setStatus("Success! Token/Ref Dispatched.");
        const newTx = { id: hash.slice(0,8), date: new Date().toLocaleString(), status: "SUCCESS", amountNaira: nairaAmount, service: activeService.name, network: activeServiceID.toUpperCase(), txHash: hash };
        setTransactions([newTx, ...transactions]);
        localStorage.setItem("abapay_history", JSON.stringify([newTx, ...transactions]));
        fetchBalance(); // Refresh balance after payment
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

  // Necessary to access fetchBalance within component scope for refresh
  const fetchBalance = async () => {
      if (!address) return;
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
  };

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900 font-sans p-4 flex flex-col items-center pb-20 relative">
      
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

      {/* --- SUPPORT MODAL --- */}
      {isSupportOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex justify-center items-end sm:items-center animate-in fade-in">
          <div className="bg-white w-full max-w-md rounded-t-3xl sm:rounded-3xl shadow-2xl p-6 animate-in slide-in-from-bottom-10">
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
            <button onClick={submitSupportTicket} disabled={isSendingSupport} className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-4 rounded-xl flex items-center justify-center gap-2">
              {isSendingSupport ? <Loader2 className="animate-spin" /> : <><Send size={18}/> Send Ticket</>}
            </button>
          </div>
        </div>
      )}

      <div className="w-full max-w-md">
        {/* --- HEADER --- */}
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
              <button className="bg-slate-900 text-white text-[10px] font-black uppercase px-4 py-2 rounded-xl">Connect</button>
            )}
          </div>
        </div>

        {/* --- TABS --- */}
        <div className="flex gap-2 bg-slate-200/50 p-1.5 rounded-2xl mb-6">
            <button onClick={() => setActiveTab("pay")} className={`flex-1 py-3 rounded-xl text-xs font-black transition-all ${activeTab === 'pay' ? 'bg-white text-emerald-600 shadow-xl' : 'text-slate-500'}`}>PAY BILLS</button>
            <button onClick={() => setActiveTab("history")} className={`flex-1 py-3 rounded-xl text-xs font-black transition-all ${activeTab === 'history' ? 'bg-white text-emerald-600 shadow-xl' : 'text-slate-500'}`}>HISTORY</button>
        </div>

        {activeTab === 'pay' ? (
          <div className="bg-white border border-slate-100 rounded-[2.5rem] p-8 shadow-2xl shadow-emerald-900/10 animate-in fade-in zoom-in-95">
            
            {/* SERVICE SELECTOR */}
            <div className="grid grid-cols-4 gap-3 mb-6">
                {SERVICES.map(s => (
                    <button 
                        key={s.id} 
                        onClick={() => { setActiveService(s); setStatus(""); setAccountNumber(""); setCustomerName(null); }}
                        className={`p-4 rounded-2xl border-2 transition-all flex flex-col items-center gap-2 ${activeService.id === s.id ? 'border-emerald-500 bg-emerald-50/50 scale-105' : 'border-slate-50 bg-slate-50/50 hover:bg-slate-100'}`}
                    >
                        <s.icon size={20} className={activeService.id === s.id ? 'text-emerald-600' : 'text-slate-400'} />
                        <span className="text-[8px] font-black uppercase tracking-widest">{s.id.slice(0,4)}</span>
                    </button>
                ))}
            </div>

            {/* FORM INPUTS */}
            <div className="space-y-5">
                
                {/* TOKEN SELECTOR & BALANCE DASHBOARD */}
                <div className="bg-slate-50 border border-slate-100 p-4 rounded-2xl flex justify-between items-center animate-in fade-in">
                  <div className="flex items-center gap-2">
                     <select 
                        className="bg-transparent font-black text-slate-800 outline-none uppercase text-sm cursor-pointer"
                        value={selectedToken.symbol}
                        onChange={(e) => setSelectedToken(SUPPORTED_TOKENS.find(t => t.symbol === e.target.value) || SUPPORTED_TOKENS[0])}
                     >
                       {SUPPORTED_TOKENS.map(t => <option key={t.symbol} value={t.symbol}>{t.icon} {t.symbol}</option>)}
                     </select>
                  </div>
                  <div className="text-right">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Available Balance</p>
                    <div className="flex items-center justify-end gap-1">
                      {isFetchingBalance ? <Loader2 size={12} className="animate-spin text-emerald-500"/> : <Coins size={12} className="text-emerald-500"/>}
                      <p className="font-mono font-black text-sm text-slate-800">{walletBalance} <span className="text-[10px]">{selectedToken.symbol}</span></p>
                    </div>
                  </div>
                </div>

                {/* DYNAMIC NETWORK / PROVIDER SELECTOR */}
                <div className="animate-in slide-in-from-left-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase mb-2 block">
                        {activeService.id === "AIRTIME" || activeService.id === "DATA" ? "Network Selection" : "Choose Provider"}
                    </label>
                    <select 
                        className="w-full bg-slate-50 border border-slate-100 p-4 rounded-2xl font-bold text-slate-800 outline-none focus:border-emerald-500 uppercase"
                        value={
                          activeService.id === "ELECTRICITY" ? elecProvider : 
                          activeService.id === "CABLE" ? cableProvider : 
                          telecomProvider
                        }
                        onChange={(e) => {
                          if (activeService.id === "ELECTRICITY") setElecProvider(e.target.value);
                          else if (activeService.id === "CABLE") setCableProvider(e.target.value);
                          else setTelecomProvider(e.target.value);
                        }}
                    >
                        {(
                          activeService.id === "ELECTRICITY" ? ELECTRICITY_PROVIDERS : 
                          activeService.id === "CABLE" ? CABLE_PROVIDERS : 
                          TELECOM_PROVIDERS
                        ).map(p => <option key={p} value={p}>{p.toUpperCase()}</option>)}
                    </select>

                    {/* PREPAID / POSTPAID TOGGLE (Only for Electricity) */}
                    {activeService.id === "ELECTRICITY" && (
                       <div className="flex gap-2 mt-3 p-1 bg-slate-100 rounded-xl">
                          <button 
                            onClick={() => setMeterType("prepaid")} 
                            className={`flex-1 py-2 text-[10px] font-black uppercase rounded-lg transition-colors ${meterType === "prepaid" ? "bg-white shadow-sm text-emerald-600" : "text-slate-500"}`}
                          >Prepaid Meter</button>
                          <button 
                            onClick={() => setMeterType("postpaid")} 
                            className={`flex-1 py-2 text-[10px] font-black uppercase rounded-lg transition-colors ${meterType === "postpaid" ? "bg-white shadow-sm text-emerald-600" : "text-slate-500"}`}
                          >Postpaid Meter</button>
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
                        maxLength={activeService.id === "AIRTIME" || activeService.id === "DATA" ? 11 : 20} // Enforces 11 digits for airtime
                        className={`w-full bg-slate-50 border p-5 rounded-2xl font-black text-xl text-slate-800 outline-none transition-all ${
                          (activeService.id === "AIRTIME" || activeService.id === "DATA") && accountNumber.length > 0 && accountNumber.length < 11 
                          ? "border-red-300 focus:border-red-500" 
                          : "border-slate-100 focus:border-emerald-500"
                        }`}
                        value={accountNumber}
                        onChange={(e) => setAccountNumber(e.target.value.replace(/[^0-9]/g, ''))} // Strips non-numbers
                    />
                    {isVerifying && <p className="text-[10px] text-blue-500 font-bold mt-2 animate-pulse">Verifying Account Details...</p>}
                    {customerName && (activeService.id === "ELECTRICITY" || activeService.id === "CABLE") && (
                        <div className="mt-2 bg-emerald-500/10 p-3 rounded-xl border border-emerald-500/20 flex items-center gap-2 animate-in fade-in">
                            <CheckCircle2 size={14} className="text-emerald-600" />
                            <span className="text-[10px] font-black text-emerald-700 uppercase">{customerName}</span>
                        </div>
                    )}
                </div>

                {/* NAIRA VALUE INPUT */}
                <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase mb-2 block">Naira Value</label>
                    <div className="relative">
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
