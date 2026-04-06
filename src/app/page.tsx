"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { createWalletClient, createPublicClient, custom, http, parseUnits, formatUnits, defineChain } from "viem";
import { celo, celoSepolia } from "viem/chains";
import { 
  Wallet, Receipt, ShieldCheck, Zap, AlertTriangle, 
  CheckCircle2, ExternalLink, Lightbulb, Phone, Wifi, Tv, 
  ChevronDown, Loader2, HelpCircle, XCircle, Mail, 
  Paperclip, Send, Coins, Briefcase, Download, Share2,
  ChevronLeft, ChevronRight, RefreshCw, ListPlus
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
const TELECOM_PROVIDERS = ["mtn", "glo", "9mobile", "airtel"]; 

// UPGRADED: 3 Stablecoins, exact USD₮ symbol, and USDm
const SUPPORTED_TOKENS = [
  { symbol: "USD₮", decimals: 6, mainnet: "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e", sepolia: "0xd077A400968890Eacc75cdc901F0356c943e4fDb", logo: "/usdt.png" },
  { symbol: "USDC", decimals: 6, mainnet: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", sepolia: "0x01C5C0122039549AD1493B8220cABEdD739BC44E", logo: "/usdc.png" },
  { symbol: "USDm", decimals: 18, mainnet: "0x765DE816845861e75A25fCA122bb6898B8B1282a", sepolia: "0xdE9e4C3ce781b4bA68120d6261cbad65ce0aB00b", logo: "/cusd.png" },
];

const PRE_SELECT_AMOUNTS = ["100", "200", "500", "1000", "2000"];
const DATA_CATEGORIES = ["Daily", "Weekly", "Monthly"];
const ITEMS_PER_PAGE = 5;

// MOCK DATA PLANS (For Telecom)
const MOCK_DATA_PLANS = [
  { id: "D1", category: "Daily", name: "100MB", validity: "24 Hrs", cost_naira: 100 },
  { id: "D2", category: "Daily", name: "350MB", validity: "24 Hrs", cost_naira: 200 },
  { id: "D3", category: "Daily", name: "1GB", validity: "24 Hrs", cost_naira: 350 },
  { id: "W1", category: "Weekly", name: "1GB", validity: "7 Days", cost_naira: 600 },
  { id: "W2", category: "Weekly", name: "2.5GB", validity: "7 Days", cost_naira: 1200 },
  { id: "W3", category: "Weekly", name: "Broadband Extra", validity: "7 Days", cost_naira: 3500, isBroadband: true },
  { id: "M1", category: "Monthly", name: "1.5GB", validity: "30 Days", cost_naira: 1100 },
  { id: "M2", category: "Monthly", name: "4.5GB", validity: "30 Days", cost_naira: 2200 },
  { id: "M3", category: "Monthly", name: "Broadband Unlimited", validity: "30 Days", cost_naira: 18000, isBroadband: true },
];

export default function Home() {
  const [isInitiallyLoading, setIsInitiallyLoading] = useState(true);

  // --- SYSTEM STATES ---
  const [address, setAddress] = useState<string | null>(null);
  const [client, setClient] = useState<any>(null);
  const [nairaAmount, setNairaAmount] = useState(""); 
  const [accountNumber, setAccountNumber] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [status, setStatus] = useState("");
  const [activeTab, setActiveTab] = useState("pay");
  const [isMiniPay, setIsMiniPay] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false); 

  // Validation States
  const [customerName, setCustomerName] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);

  // --- CABLE TV STATES ---
  const [cableCurrentBouquet, setCableCurrentBouquet] = useState<string | null>(null);
  const [cableRenewAmount, setCableRenewAmount] = useState<number | null>(null);
  const [cableSubscriptionType, setCableSubscriptionType] = useState<"renew" | "change">("renew");
  const [cableVariations, setCableVariations] = useState<any[]>([]);
  const [selectedCablePlan, setSelectedCablePlan] = useState<any>(null);

  // Service States
  const [activeService, setActiveService] = useState(SERVICES[0]);
  const [elecProvider, setElecProvider] = useState(ELECTRICITY_PROVIDERS[0]);
  const [cableProvider, setCableProvider] = useState(CABLE_PROVIDERS[0]);
  const [telecomProvider, setTelecomProvider] = useState(TELECOM_PROVIDERS[0]);
  const [meterType, setMeterType] = useState<"prepaid" | "postpaid">("prepaid");
  const [activeDataCategory, setActiveDataCategory] = useState(DATA_CATEGORIES[0]);
  const [selectedDataPlan, setSelectedDataPlan] = useState<any>(null);

  // Modals & UI States
  const [selectedReceipt, setSelectedReceipt] = useState<any>(null); 
  const [isTermsOpen, setIsTermsOpen] = useState(false); 
  const [isPrivacyOpen, setIsPrivacyOpen] = useState(false); 
  const [isSupportOpen, setIsSupportOpen] = useState(false);
  const [supportMessage, setSupportMessage] = useState("");
  const [supportFile, setSupportFile] = useState<File | null>(null);
  const [isSendingSupport, setIsSendingSupport] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isSelectionModalOpen, setIsSelectionModalOpen] = useState(false);
  const [modalTitle, setModalTitle] = useState("");
  const [modalOptions, setModalOptions] = useState<string[]>([]);
  const [modalCallback, setModalCallback] = useState<((value: string) => void) | null>(null);
  const [toast, setToast] = useState<{title: string, message: string, type: 'success' | 'error'} | null>(null);
  const [currentPage, setCurrentPage] = useState(1);

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

  const showToast = (title: string, message: string, type: 'success' | 'error' = 'success') => {
    setToast({ title, message, type });
    setTimeout(() => setToast(null), 5000);
  };

  const dynamicMinAmount = useMemo(() => {
    if (activeService.id === "ELECTRICITY") return 1000; 
    if (activeService.id === "CABLE") return 500;
    return 100; 
  }, [activeService]);

  const indexOfLastItem = currentPage * ITEMS_PER_PAGE;
  const indexOfFirstItem = indexOfLastItem - ITEMS_PER_PAGE;
  const currentTransactions = transactions.slice(indexOfFirstItem, indexOfLastItem);
  const totalPages = Math.ceil(transactions.length / ITEMS_PER_PAGE);

  // --- INITIALIZATION ---
  useEffect(() => {
    async function initSystem() {
      const savedHistory = localStorage.getItem("abapay_history");
      if (savedHistory) setTransactions(JSON.parse(savedHistory));

      try {
        const rateRes = await fetch('/api/rate');
        const rateData = await rateRes.json();
        if (rateData.success && rateData.abaPayRate) setExchangeRate(Number(rateData.abaPayRate));
      } catch (consoleError) {}

      if (typeof window !== "undefined" && (window as any).ethereum) {
        const eth = (window as any).ethereum;
        if (eth.isMiniPay) setIsMiniPay(true);

        const walletClient = createWalletClient({ chain: activeChain, transport: custom(eth) });
        walletClient.requestAddresses().then(([acc]) => {
          setAddress(acc);
          setClient(walletClient);
        }).catch((e) => console.log("Connection deferred"));
      }

      setTimeout(() => setIsInitiallyLoading(false), 2000);
    }
    initSystem();
  }, [activeChain]);

  // --- FETCH BALANCE ---
  useEffect(() => {
    async function fetchBalance() {
      if (!address) return;
      setIsFetchingBalance(true);
      try {
        const publicClient = createPublicClient({ chain: activeChain, transport: http() });
        const tokenAddress = isMainnet ? selectedToken.mainnet : selectedToken.sepolia;
        const balanceWei = await publicClient.readContract({
          address: tokenAddress as `0x${string}`,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [address],
        });
        setWalletBalance(parseFloat(formatUnits(balanceWei as bigint, selectedToken.decimals)).toFixed(4));
      } catch (error) {
        setWalletBalance("0.00");
      }
      setIsFetchingBalance(false);
    }
    fetchBalance();
  }, [address, selectedToken, activeChain, isMainnet]);

  // --- FETCH DYNAMIC CABLE PACKAGES ---
  useEffect(() => {
    if (activeService.id === "CABLE") {
      const fetchVariations = async () => {
        try {
          const baseUrl = process.env.NEXT_PUBLIC_APP_MODE === 'live' ? 'https://vtpass.com/api' : 'https://sandbox.vtpass.com/api';
          const res = await fetch(`${baseUrl}/service-variations?serviceID=${cableProvider}`);
          const data = await res.json();
          if (data.content && data.content.varations) {
            setCableVariations(data.content.varations);
          }
        } catch (e) { console.error("Failed to fetch cable packages", e); }
      };
      fetchVariations();
    }
  }, [activeService.id, cableProvider]);

  // --- AUTO-DETECT TELECOM LOGIC ---
  useEffect(() => {
    if ((activeService.id === "AIRTIME" || activeService.id === "DATA") && accountNumber.length >= 4) {
      const prefix = accountNumber.substring(0, 4);
      if (["0803","0806","0810","0813","0814","0816","0903","0906","0913","0916","0703","0706"].includes(prefix)) setTelecomProvider("mtn");
      else if (["0802","0808","0812","0902","0907","0912","0701","0708"].includes(prefix)) setTelecomProvider("airtel");
      else if (["0805","0807","0811","0905","0705","0915"].includes(prefix)) setTelecomProvider("glo");
      else if (["0809","0817","0818","0908","0909"].includes(prefix)) setTelecomProvider("9mobile");
    }
  }, [accountNumber, activeService]);

  // --- MERCHANT VERIFICATION ---
  const verifyMerchant = async () => {
    setIsVerifying(true);
    setCustomerName(null);
    setCableCurrentBouquet(null);
    setCableRenewAmount(null);

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
        
        if (data.code === '000') {
          setCustomerName(data.content.Customer_Name);
          
          if (activeService.id === "CABLE") {
            setCableCurrentBouquet(data.content.Current_Bouquet || "Unknown Package");
            if (data.content.Renewal_Amount) {
              setCableRenewAmount(data.content.Renewal_Amount);
              if (cableSubscriptionType === "renew") {
                setNairaAmount(data.content.Renewal_Amount.toString());
              }
            }
          }
        }
    } catch (e) { console.error("Verify Error", e); }
    setIsVerifying(false);
  };

  useEffect(() => {
    if ((activeService.id === "ELECTRICITY" || activeService.id === "CABLE") && accountNumber.length >= 10) {
      verifyMerchant();
    } else {
      setCustomerName(null);
    }
  }, [accountNumber, elecProvider, cableProvider, activeService, meterType]);

  const { cryptoToCharge, currentFee } = useMemo(() => {
    const bill = parseFloat(nairaAmount) || 0;
    const fee = (activeService.id === "ELECTRICITY" || activeService.id === "CABLE") ? 100 : 0;
    const crypto = (bill + fee) / exchangeRate;
    return { cryptoToCharge: crypto.toFixed(4), currentFee: fee };
  }, [nairaAmount, exchangeRate, activeService]);

  const isFormValid = useMemo(() => {
    const amount = parseFloat(nairaAmount);
    if (!nairaAmount || isNaN(amount) || amount < dynamicMinAmount) return false;

    if (activeService.id === "AIRTIME" || activeService.id === "DATA") {
      return accountNumber.length === 11 && accountNumber.startsWith("0");
    }
    if (activeService.id === "ELECTRICITY") {
      return accountNumber.length >= 10 && customerName !== null;
    }
    if (activeService.id === "CABLE") {
      if (accountNumber.length < 10 || customerName === null) return false;
      if (cableSubscriptionType === 'change' && !selectedCablePlan) return false;
      return true;
    }
    return false;
  }, [accountNumber, nairaAmount, activeService, customerName, dynamicMinAmount, cableSubscriptionType, selectedCablePlan]);

  // --- PAYMENT EXECUTION ---
  const handlePayment = async () => {
    if (!address || !client) return setStatus("Connect Wallet First");

    if (parseFloat(cryptoToCharge) > parseFloat(walletBalance)) {
      return setStatus(`Insufficient ${selectedToken.symbol} Balance.`);
    }

    setIsProcessing(true);
    setStatus("Initiating Blockchain Escrow...");

    try {
      try {
        const currentChainId = await client.getChainId();
        if (currentChainId !== activeChain.id) {
          setStatus("Switching wallet to Celo network...");
          await client.switchChain({ id: activeChain.id });
        }
      } catch (switchError) {
        await client.addChain({ chain: activeChain });
      }

      const valueInWei = parseUnits(cryptoToCharge, selectedToken.decimals);
      const tokenAddress = isMainnet ? selectedToken.mainnet : selectedToken.sepolia;

      setStatus("Awaiting token approval...");

      await client.writeContract({
        address: tokenAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [ABAPAY_CONTRACT, valueInWei],
        account: address,
      });

      let vtpassServiceID = "";
      let displayNetwork = "";
      let finalVariationCode = 'prepaid';

      if (activeService.id === "ELECTRICITY") {
        vtpassServiceID = elecProvider;
        displayNetwork = elecProvider;
        finalVariationCode = meterType;
      } else if (activeService.id === "CABLE") {
        vtpassServiceID = cableProvider;
        displayNetwork = cableProvider;
        finalVariationCode = cableSubscriptionType === 'change' ? selectedCablePlan?.variation_code : 'none'; 
      } else if (activeService.id === "DATA") {
        vtpassServiceID = `${telecomProvider}-data`; 
        displayNetwork = telecomProvider;
        finalVariationCode = selectedDataPlan?.id || 'mtn-10mb'; 
      } else {
        vtpassServiceID = telecomProvider; 
        displayNetwork = telecomProvider;
      }

      const hash = await client.writeContract({
        address: ABAPAY_CONTRACT,
        abi: ABAPAY_ABI,
        functionName: 'payBill',
        args: [tokenAddress, vtpassServiceID, accountNumber, valueInWei],
        account: address,
      });

      setStatus(`${selectedToken.symbol} Secured. Vending Utility...`);

      const backendPayload = {
        serviceID: vtpassServiceID, 
        serviceCategory: activeService.id, 
        network: displayNetwork.toUpperCase(), 
        billersCode: accountNumber,
        amount: cryptoToCharge,
        nairaAmount: nairaAmount, 
        token: selectedToken.symbol,
        txHash: hash,
        variation_code: finalVariationCode,
        phone: customerPhone || accountNumber,
        wallet_address: address,
        subscription_type: activeService.id === "CABLE" ? cableSubscriptionType : undefined
      };

      const newTx = { 
        id: hash.slice(0,8), 
        date: new Date().toLocaleString(), 
        status: "PENDING", 
        amountNaira: nairaAmount,
        amountCrypto: cryptoToCharge,
        tokenUsed: selectedToken.symbol, 
        service: activeService.name, 
        network: displayNetwork.toUpperCase(), 
        txHash: hash,
        account: accountNumber
      };

      setAccountNumber("");
      setNairaAmount("");
      setCustomerPhone("");
      setCustomerName(null);
      setSelectedDataPlan(null);
      setSelectedCablePlan(null);
      setCableCurrentBouquet(null);

      const res = await fetch('/api/pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(backendPayload)
      });

      const result = await res.json();

      if (result.success) {
        setStatus("Success! Token/Ref Dispatched.");
        newTx.status = "SUCCESS";
        showToast("Vending Successful", "Your utility has been successfully delivered.", "success");
      } else {
        setStatus(`Error: ${result.message || 'Transaction Failed'}`);
        newTx.status = "FAILED/DELAYED";
      }

      const updatedHistory = [newTx, ...transactions];
      setTransactions(updatedHistory);
      localStorage.setItem("abapay_history", JSON.stringify(updatedHistory));
      
      setCurrentPage(1);

      const publicClient = createPublicClient({ chain: activeChain, transport: http() });
      const balanceWei = await publicClient.readContract({ address: tokenAddress as `0x${string}`, abi: ERC20_ABI, functionName: 'balanceOf', args: [address] });
      setWalletBalance(parseFloat(formatUnits(balanceWei as bigint, selectedToken.decimals)).toFixed(4));

    } catch (e) { 
      console.error(e);
      setStatus("Transaction Cancelled."); 
    } finally {
      setIsProcessing(false);
    }
  };

  // --- RESTORED HELPER FUNCTIONS ---
  const handleResetService = (s: any) => {
    setActiveService(s); 
    setStatus(""); 
    setAccountNumber(""); 
    setCustomerName(null); 
    setNairaAmount(""); 
    setSelectedDataPlan(null);
    setCableCurrentBouquet(null);
    setCableRenewAmount(null);
    setSelectedCablePlan(null);
    setCableSubscriptionType("renew");
  };

  const openPremiumSelection = (title: string, options: string[], callback: (value: string) => void) => {
    setModalTitle(title);
    setModalOptions(options);
    setModalCallback(() => callback);
    setIsSelectionModalOpen(true);
  };

  const handleShareReceipt = async () => {
    const receiptText = `🧾 AbaPay Protocol Receipt\n\nStatus: ${selectedReceipt.status}\nProduct: ${selectedReceipt.network} ${selectedReceipt.service}\nRecipient: ${selectedReceipt.account}\nAmount Paid: ₦${selectedReceipt.amountNaira}\nCrypto Used: ${selectedReceipt.amountCrypto} ${selectedReceipt.tokenUsed}\nTx Hash: ${selectedReceipt.txHash}\n\nSecured by Celo Network`;

    if (navigator.share) {
      try { await navigator.share({ title: 'AbaPay Receipt', text: receiptText }); } 
      catch (err) { console.log("Share cancelled or failed.", err); }
    } else {
      try {
        await navigator.clipboard.writeText(receiptText);
        showToast("Copied!", "Receipt details copied to clipboard.", "success");
      } catch (err) { showToast("Error", "Could not copy receipt.", "error"); }
    }
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

  const filteredDataPlans = useMemo(() => {
    return MOCK_DATA_PLANS.filter(plan => plan.category === activeDataCategory);
  }, [activeDataCategory]);

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900 font-sans p-4 flex flex-col items-center pb-20 relative">

      <style>{`
        @keyframes logoScale {
          0%, 100% { transform: scale(1); opacity: 0.9; }
          50% { transform: scale(1.1); opacity: 1; }
        }
        .animate-logo-scale { animation: logoScale 1.5s ease-in-out infinite; }
      `}</style>

      {isInitiallyLoading && (
        <div className="fixed inset-0 z-[100] bg-white flex flex-col items-center justify-center animate-in fade-out duration-500 fill-mode-forwards" style={{ animationDelay: '1.5s' }}>
          <img src="/logo.png" alt="AbaPay" className="h-28 w-auto object-contain animate-logo-scale mb-10" />
          <div className="flex flex-col items-center gap-2">
             <div className="w-12 h-0.5 bg-emerald-500 rounded-full animate-pulse" />
             <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Loading AbaPay Protocol...</p>
          </div>
        </div>
      )}

      {/* --- TOAST --- */}
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

      {/* --- RECEIPT MODAL --- */}
      {selectedReceipt && (
        <div className="fixed inset-0 z-[60] bg-slate-900/80 backdrop-blur-md flex justify-center items-center p-6 animate-in fade-in">
           <div className="bg-white w-full max-w-sm rounded-[2.5rem] overflow-hidden shadow-2xl animate-in zoom-in-95">
              <div className="bg-emerald-600 p-8 text-white text-center relative">
                 <button onClick={() => setSelectedReceipt(null)} className="absolute top-4 right-4 bg-white/20 p-1.5 rounded-full hover:bg-white/30 transition-colors"><XCircle size={20}/></button>
                 <CheckCircle2 size={48} className="mx-auto mb-3 opacity-90" />
                 <h2 className="text-xl font-black tracking-tight">Payment Receipt</h2>
                 <p className="text-emerald-100 text-xs font-bold uppercase tracking-widest mt-1">AbaPay Protocol</p>
              </div>
              <div className="p-8 space-y-4">
                 <div className="flex justify-between border-b border-slate-100 pb-3">
                    <span className="text-slate-400 text-[10px] font-bold uppercase tracking-wider">Status</span>
                    <span className={`font-black text-xs uppercase ${selectedReceipt.status === 'SUCCESS' ? 'text-emerald-600' : 'text-orange-500'}`}>{selectedReceipt.status}</span>
                 </div>
                 <div className="flex justify-between border-b border-slate-100 pb-3">
                    <span className="text-slate-400 text-[10px] font-bold uppercase tracking-wider">Product</span>
                    <span className="text-slate-800 font-black text-xs uppercase">{selectedReceipt.network} {selectedReceipt.service}</span>
                 </div>
                 <div className="flex justify-between border-b border-slate-100 pb-3">
                    <span className="text-slate-400 text-[10px] font-bold uppercase tracking-wider">Recipient</span>
                    <span className="text-slate-800 font-mono font-bold text-xs">{selectedReceipt.account}</span>
                 </div>
                 <div className="flex justify-between border-b border-slate-100 pb-3">
                    <span className="text-slate-400 text-[10px] font-bold uppercase tracking-wider">Amount Paid</span>
                    <div className="text-right">
                       <p className="text-slate-800 font-black text-sm">₦{selectedReceipt.amountNaira}</p>
                       <p className="text-slate-400 text-[9px] font-bold">{selectedReceipt.amountCrypto} {selectedReceipt.tokenUsed || 'USD₮'}</p>
                    </div>
                 </div>
                 <button 
                  onClick={() => window.open(`https://${isMainnet?'':'sepolia.'}celoscan.io/tx/${selectedReceipt.txHash}`)}
                  className="w-full py-3 bg-slate-50 hover:bg-slate-100 rounded-xl text-[10px] font-black uppercase tracking-widest text-slate-500 flex items-center justify-center gap-2 transition-colors"
                 >
                   Verify on Celoscan <ExternalLink size={12}/>
                 </button>
                 <div className="flex gap-2">
                    <button 
                      onClick={handleShareReceipt} 
                      className="flex-1 py-4 bg-slate-900 hover:bg-slate-800 text-white rounded-2xl text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 transition-colors active:scale-95 shadow-xl shadow-slate-900/20"
                    >
                      <Share2 size={16}/> Share
                    </button>
                    {selectedReceipt.status !== 'SUCCESS' && (
                       <button 
                         onClick={() => { setSelectedReceipt(null); setIsSupportOpen(true); }}
                         className="flex-1 py-4 bg-orange-100 hover:bg-orange-200 text-orange-700 rounded-2xl text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 transition-colors active:scale-95"
                       >
                         <HelpCircle size={16}/> Support
                       </button>
                    )}
                 </div>
              </div>
           </div>
        </div>
      )}

      {/* --- TERMS MODAL --- */}
      {isTermsOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center p-4 animate-in fade-in" onClick={() => setIsTermsOpen(false)}>
           <div className="bg-white w-full max-w-md rounded-[2rem] shadow-2xl p-6 flex flex-col max-h-[80vh] animate-in zoom-in-95 duration-200" onClick={(e) => e.stopPropagation()}>
              <div className="flex justify-between items-center mb-4 shrink-0 border-b border-slate-100 pb-4">
                <h2 className="text-xl font-black tracking-tight text-slate-900">Terms of Service</h2>
                <button onClick={() => setIsTermsOpen(false)} className="p-2 bg-slate-100 rounded-full hover:bg-slate-200 transition-colors"><XCircle size={20} className="text-slate-500" /></button>
              </div>
              <div className="overflow-y-auto text-sm text-slate-600 space-y-4 pr-2 leading-relaxed">
                 <p className="font-bold text-slate-800">1. Acceptance of Terms</p>
                 <p>By connecting your wallet and using the AbaPay Protocol, you agree to execute blockchain transactions via smart contracts. You acknowledge that blockchain transactions are immutable.</p>
                 <p className="font-bold text-slate-800 mt-4">2. Service Delivery</p>
                 <p>AbaPay acts as a decentralized bridge to fiat utility providers. While we strive for instant vending, delays caused by third-party telecom or electricity providers are beyond our direct control.</p>
                 <p className="font-bold text-slate-800 mt-4">3. Supported Assets</p>
                 <p>You are responsible for ensuring you send the correct supported asset on the Celo Network. AbaPay is not liable for funds lost due to incorrect network transfers.</p>
              </div>
           </div>
        </div>
      )}

      {/* --- PRIVACY MODAL --- */}
      {isPrivacyOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center p-4 animate-in fade-in" onClick={() => setIsPrivacyOpen(false)}>
           <div className="bg-white w-full max-w-md rounded-[2rem] shadow-2xl p-6 flex flex-col max-h-[80vh] animate-in zoom-in-95 duration-200" onClick={(e) => e.stopPropagation()}>
              <div className="flex justify-between items-center mb-4 shrink-0 border-b border-slate-100 pb-4">
                <h2 className="text-xl font-black tracking-tight text-slate-900">Privacy Policy</h2>
                <button onClick={() => setIsPrivacyOpen(false)} className="p-2 bg-slate-100 rounded-full hover:bg-slate-200 transition-colors"><XCircle size={20} className="text-slate-500" /></button>
              </div>
              <div className="overflow-y-auto text-sm text-slate-600 space-y-4 pr-2 leading-relaxed">
                 <p className="font-bold text-slate-800">1. Data Collection</p>
                 <p>As a decentralized application, AbaPay does not require you to create an account or provide personal KYC information. We only collect the data necessary to fulfill your utility order (e.g., Meter Number, Phone Number).</p>
                 <p className="font-bold text-slate-800 mt-4">2. Wallet Addresses</p>
                 <p>Your connected Celo wallet address is recorded on the public blockchain when executing a transaction. This is a fundamental property of Web3 and is not hidden.</p>
                 <p className="font-bold text-slate-800 mt-4">3. Third-Party Services</p>
                 <p>Utility numbers provided (like phone or meter numbers) are securely passed to our fiat vending partners (e.g., VTpass) solely for the purpose of delivering your purchased service.</p>
              </div>
           </div>
        </div>
      )}

      {/* MODAL (With Token Logo Support) */}
      {isSelectionModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center p-4 animate-in fade-in" onClick={() => setIsSelectionModalOpen(false)}>
           <div className="bg-white w-full max-w-sm rounded-[2rem] shadow-2xl p-6 animate-in zoom-in-95 duration-200" onClick={(e) => e.stopPropagation()}>
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-lg font-bold text-slate-800">{modalTitle}</h2>
                <button onClick={() => setIsSelectionModalOpen(false)} className="p-2 bg-slate-100 rounded-full hover:bg-slate-200 transition-colors"><XCircle size={20} className="text-slate-500" /></button>
              </div>
              <div className="space-y-2 max-h-[50vh] overflow-y-auto">
                 {modalOptions.map(option => {
                   const isToken = SUPPORTED_TOKENS.find(t => t.symbol === option);
                   return (
                     <button 
                       key={option} 
                       onClick={() => { modalCallback?.(option); setIsSelectionModalOpen(false); }}
                       className="w-full text-left p-4 rounded-xl font-bold text-slate-700 bg-slate-50 border border-slate-100 uppercase text-xs hover:border-emerald-300 hover:bg-emerald-50/50 transition-all flex justify-between items-center"
                     >
                       <div className="flex items-center gap-3">
                         {isToken && <img src={isToken.logo} alt={isToken.symbol} className="w-5 h-5 object-contain rounded-full" />}
                         <span>{option}</span>
                       </div>
                       {(telecomProvider === option || elecProvider === option || cableProvider === option || selectedToken.symbol === option) && <CheckCircle2 size={16} className="text-emerald-500"/>}
                     </button>
                   );
                 })}
              </div>
           </div>
        </div>
      )}

      {/* Support Modal */}
      {isSupportOpen && (
        <div className="fixed inset-0 z-[70] bg-slate-900/60 backdrop-blur-sm flex justify-center items-center p-4 animate-in fade-in">
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
        <div className="flex justify-between items-center bg-white p-4 rounded-3xl shadow-sm border border-slate-100 mb-6">
          <div className="flex items-center gap-3">
            <img src="/logo.png" alt="AbaPay" className="h-10 w-auto object-contain" />
            <div className="flex flex-col">
              <span className="text-xl font-black text-slate-900 leading-none tracking-tight">AbaPay<span className="text-emerald-500">.</span></span>
              <span className="text-[8px] font-black uppercase text-slate-400 tracking-widest mt-1">Seamless Payments.</span>
            </div>
          </div>
          <div>
            {isMiniPay ? (
              <div className="bg-emerald-50 border border-emerald-200 px-3 py-1.5 rounded-xl flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                <span className="text-[9px] font-black text-emerald-700 uppercase tracking-tight">MiniPay Active</span>
              </div>
            ) : address ? (
              <div className="bg-emerald-50 border border-emerald-100 px-3 py-1.5 rounded-xl flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <span className="text-[10px] font-black text-emerald-700 font-mono tracking-tighter">
                  {address.slice(0, 5)}...{address.slice(-4)}
                </span>
              </div>
            ) : (
              <button 
                onClick={async () => {
                  if (typeof window !== "undefined" && (window as any).ethereum) {
                    const eth = (window as any).ethereum;
                    const walletClient = createWalletClient({ chain: activeChain, transport: custom(eth) });
                    const [acc] = await walletClient.requestAddresses();
                    setAddress(acc);
                    setClient(walletClient);
                  }
                }}
                className="bg-slate-900 text-white text-[10px] font-black uppercase px-4 py-2 rounded-xl active:scale-95 hover:bg-slate-800 transition-all shadow-lg shadow-slate-900/20"
              >
                Connect
              </button>
            )}
          </div>
        </div>

        <div className="flex gap-2 bg-slate-200/50 p-1.5 rounded-2xl mb-6 shadow-inner">
            <button onClick={() => setActiveTab("pay")} className={`flex-1 py-3 rounded-xl text-xs font-black transition-all ${activeTab === 'pay' ? 'bg-white text-emerald-600 shadow-xl' : 'text-slate-500 hover:text-slate-700'}`}>PAY BILLS</button>
            <button onClick={() => setActiveTab("history")} className={`flex-1 py-3 rounded-xl text-xs font-black transition-all ${activeTab === 'history' ? 'bg-white text-emerald-600 shadow-xl' : 'text-slate-500 hover:text-slate-700'}`}>HISTORY</button>
        </div>

        {activeTab === 'pay' ? (
          <div className="bg-white border border-slate-100 rounded-[2.5rem] p-8 shadow-2xl shadow-emerald-900/10 animate-in fade-in zoom-in-95">
            <div className="grid grid-cols-4 gap-3 mb-6">
                {SERVICES.map(s => (
                    <button 
                        key={s.id} 
                        onClick={() => handleResetService(s)}
                        className={`p-4 rounded-2xl border-2 transition-all flex flex-col items-center gap-2 ${activeService.id === s.id ? 'border-emerald-500 bg-emerald-50/50 scale-105' : 'border-slate-50 bg-slate-50/50 hover:bg-slate-100'}`}
                    >
                        <s.icon size={20} className={s.color} />
                        <span className="text-[8px] font-black uppercase tracking-widest">{s.id.slice(0,4)}</span>
                    </button>
                ))}
            </div>

            <div className="space-y-5">
                {/* UPGRADED: Dynamic Logo Rendering for Token Selector */}
                <div className="bg-slate-50 border border-slate-100 p-4 rounded-2xl flex justify-between items-center animate-in fade-in">
                  <div 
                    className="flex items-center gap-2 cursor-pointer hover:bg-slate-100 p-2 -ml-2 rounded-xl transition-colors" 
                    onClick={() => openPremiumSelection("Select Token", SUPPORTED_TOKENS.map(t => t.symbol), (symbol) => setSelectedToken(SUPPORTED_TOKENS.find(t => t.symbol === symbol)!))}
                  >
                     <img src={selectedToken.logo} alt={selectedToken.symbol} className="w-7 h-7 object-contain rounded-full shadow-sm bg-white" />
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

                <div className="animate-in slide-in-from-left-2 mb-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase mb-3 block">
                        {activeService.id === "AIRTIME" || activeService.id === "DATA" ? "Select Network" : "Choose Provider"}
                    </label>

                    {activeService.id === "AIRTIME" || activeService.id === "DATA" ? (
                      <div className="flex justify-between items-center gap-2">
                        {TELECOM_PROVIDERS.map((provider) => (
                          <button
                            key={provider}
                            onClick={() => setTelecomProvider(provider)}
                            className={`flex flex-col items-center gap-2 flex-1 py-3 rounded-2xl transition-all border-2 ${
                              telecomProvider === provider 
                              ? 'border-emerald-500 bg-emerald-50/50 scale-105 shadow-sm' 
                              : 'border-transparent bg-slate-50 hover:bg-slate-100 opacity-60 hover:opacity-100 grayscale hover:grayscale-0'
                            }`}
                          >
                            <div className="w-11 h-11 rounded-full bg-white shadow-sm border border-slate-100 flex items-center justify-center p-1.5 overflow-hidden">
                              <img 
                                src={`/${provider}.png`} 
                                alt={provider} 
                                className="w-full h-full object-contain" 
                                onError={(e) => { 
                                  e.currentTarget.style.display = 'none'; 
                                  e.currentTarget.parentElement!.innerHTML = `<span class="text-[9px] font-black uppercase text-slate-400">${provider.slice(0,3)}</span>`;
                                }}
                              />
                            </div>
                            <span className={`text-[9px] font-black uppercase tracking-wider ${telecomProvider === provider ? 'text-emerald-700' : 'text-slate-500'}`}>
                              {provider}
                            </span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <button 
                        onClick={() => {
                          const options = activeService.id === "ELECTRICITY" ? ELECTRICITY_PROVIDERS : CABLE_PROVIDERS;
                          const callback = activeService.id === "ELECTRICITY" ? setElecProvider : setCableProvider;
                          openPremiumSelection("Select Provider", options, callback);
                        }}
                        className="w-full bg-slate-50 border border-slate-100 p-4 rounded-2xl font-bold text-slate-800 outline-none uppercase text-xs hover:border-emerald-300 transition-all text-left flex justify-between items-center"
                      >
                        <span>{activeService.id === "ELECTRICITY" ? elecProvider.toUpperCase() : cableProvider.toUpperCase()}</span>
                        <ChevronDown size={14} className="text-slate-400"/>
                      </button>
                    )}

                    {activeService.id === "ELECTRICITY" && (
                       <div className="flex gap-2 mt-3 p-1 bg-slate-100 rounded-xl border border-slate-200 shadow-inner">
                          <button onClick={() => setMeterType("prepaid")} className={`flex-1 py-2.5 text-[10px] font-black uppercase rounded-lg transition-colors ${meterType === "prepaid" ? "bg-white shadow-sm text-emerald-600" : "text-slate-500"}`}>Prepaid</button>
                          <button onClick={() => setMeterType("postpaid")} className={`flex-1 py-2.5 text-[10px] font-black uppercase rounded-lg transition-colors ${meterType === "postpaid" ? "bg-white shadow-sm text-emerald-600" : "text-slate-500"}`}>Postpaid</button>
                       </div>
                    )}
                </div>

                <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase mb-2 flex justify-between">
                      <span>{activeService.id === "AIRTIME" || activeService.id === "DATA" ? "Phone Number (11 Digits)" : "Account / Smartcard No"}</span>
                      {(activeService.id === "AIRTIME" || activeService.id === "DATA") && (
                        <span className={accountNumber.length === 11 ? "text-emerald-500" : "text-slate-400"}>{accountNumber.length}/11</span>
                      )}
                    </label>
                    <input 
                        type="tel" placeholder={activeService.id === "AIRTIME" || activeService.id === "DATA" ? "08000000000" : "Enter Number"}
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
                    
                    {customerName && activeService.id === "ELECTRICITY" && (
                        <div className="mt-2 bg-emerald-500/10 p-3 rounded-xl border border-emerald-500/20 flex items-center gap-2 animate-in fade-in">
                            <CheckCircle2 size={14} className="text-emerald-600" />
                            <span className="text-[10px] font-black text-emerald-700 uppercase">{customerName}</span>
                        </div>
                    )}
                </div>

                {/* --- UPGRADED CABLE TV UI BLOCK --- */}
                {activeService.id === "CABLE" && customerName && (
                  <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 shadow-sm animate-in fade-in slide-in-from-top-4">
                     <div className="flex items-start justify-between border-b border-slate-200 pb-3 mb-3">
                        <div>
                          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">Verified Customer</p>
                          <p className="font-black text-slate-800 text-sm">{customerName}</p>
                          <p className="text-xs font-bold text-emerald-600 mt-1 flex items-center gap-1"><Tv size={12}/> {cableCurrentBouquet}</p>
                        </div>
                     </div>

                     <div className="flex gap-2 p-1 bg-slate-200/50 rounded-xl mb-4">
                        <button 
                          onClick={() => { setCableSubscriptionType("renew"); setNairaAmount(cableRenewAmount ? cableRenewAmount.toString() : ""); setSelectedCablePlan(null); }} 
                          className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-[10px] font-black uppercase tracking-wider rounded-lg transition-all ${cableSubscriptionType === "renew" ? "bg-white text-emerald-600 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
                        >
                          <RefreshCw size={14}/> Renew Plan
                        </button>
                        <button 
                          onClick={() => { setCableSubscriptionType("change"); setNairaAmount(""); }} 
                          className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-[10px] font-black uppercase tracking-wider rounded-lg transition-all ${cableSubscriptionType === "change" ? "bg-white text-blue-600 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
                        >
                          <ListPlus size={14}/> Change Plan
                        </button>
                     </div>

                     {cableSubscriptionType === "renew" ? (
                        <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-4 text-center">
                           <p className="text-[10px] font-black text-emerald-800 uppercase tracking-widest mb-1">Renewal Amount Due</p>
                           <p className="text-2xl font-black text-emerald-600">₦{cableRenewAmount?.toLocaleString() || "0.00"}</p>
                        </div>
                     ) : (
                        <div className="grid grid-cols-1 gap-2 max-h-[35vh] overflow-y-auto pr-1">
                          {cableVariations.length === 0 ? (
                            <p className="text-center text-xs font-bold text-slate-400 py-4"><Loader2 className="animate-spin inline-block mr-2" size={14}/> Fetching Live Packages...</p>
                          ) : (
                            cableVariations.map((plan) => {
                              const cryptoPlanCost = (parseFloat(plan.variation_amount) / exchangeRate).toFixed(4);
                              return (
                                <button 
                                  key={plan.variation_code} 
                                  onClick={() => { setSelectedCablePlan(plan); setNairaAmount(plan.variation_amount); }} 
                                  className={`p-3 rounded-xl border transition-all text-left flex justify-between items-center ${selectedCablePlan?.variation_code === plan.variation_code ? 'border-blue-500 bg-blue-50/50 shadow-sm' : 'border-slate-200 bg-white hover:border-slate-300'}`}
                                >
                                  <div>
                                    <p className="font-black text-slate-800 text-xs">{plan.name}</p>
                                    <p className="text-[9px] text-slate-400 font-bold mt-0.5">{cryptoPlanCost} {selectedToken.symbol}</p>
                                  </div>
                                  <p className="font-black text-blue-600 text-sm">₦{parseFloat(plan.variation_amount).toLocaleString()}</p>
                                </button>
                              );
                            })
                          )}
                        </div>
                     )}
                  </div>
                )}

                {/* Amount Input (Hidden if CABLE is handling it dynamically) */}
                {activeService.id === "DATA" && (
                   <div className="bg-slate-50 border border-slate-100 p-4 rounded-2xl animate-in fade-in slide-in-from-top-4">
                      <div className="flex gap-1.5 mb-4 border-b border-slate-200 pb-3 overflow-x-auto">
                        {DATA_CATEGORIES.map(cat => (
                          <button key={cat} onClick={() => { setActiveDataCategory(cat); setSelectedDataPlan(null); }} className={`px-4 py-1.5 rounded-lg text-[10px] font-black uppercase transition-colors whitespace-nowrap ${activeDataCategory === cat ? 'bg-purple-500/10 text-purple-600' : 'text-slate-500 hover:bg-slate-100'}`}>{cat}</button>
                        ))}
                        <button onClick={() => setActiveDataCategory("Broadband")} className={`px-4 py-1.5 flex items-center gap-1.5 rounded-lg text-[10px] font-black uppercase transition-colors ${activeDataCategory === "Broadband" ? 'bg-orange-500/10 text-orange-600' : 'text-slate-500 hover:bg-slate-100'}`}><Briefcase size={12}/> Broadband</button>
                      </div>

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

                <div className={activeService.id === "DATA" || activeService.id === "CABLE" ? "hidden" : ""}>
                    <label className="text-[10px] font-black text-slate-400 uppercase mb-2 flex justify-between items-center">
                       <span>Naira Value</span>
                       <span className="text-emerald-500 bg-emerald-500/10 px-2 py-0.5 rounded">MIN: ₦{dynamicMinAmount.toLocaleString()}</span>
                    </label>
                    <div className="relative mb-3">
                        <input 
                            type="number" 
                            placeholder="Enter Amount" 
                            className="w-full bg-slate-50 border border-slate-100 p-5 rounded-2xl font-black text-xl text-slate-800 outline-none focus:border-emerald-500 transition-all"
                            value={nairaAmount}
                            onChange={(e) => setNairaAmount(e.target.value)}
                        />
                        <div className="absolute right-4 top-1/2 -translate-y-1/2 text-right">
                            <p className="text-[10px] font-black text-emerald-600">{cryptoToCharge} {selectedToken.symbol}</p>
                            {currentFee > 0 && <p className="text-[8px] font-bold text-orange-500">+₦{currentFee} FEE</p>}
                        </div>
                    </div>

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

                {status && (
                    <div className={`p-4 rounded-2xl text-[10px] font-bold border flex items-center gap-3 animate-in fade-in slide-in-from-top-2 ${status.includes('Success') ? 'bg-emerald-50 border-emerald-100 text-emerald-700' : 'bg-red-50 border-red-100 text-red-700'}`}>
                        {status.includes('Success') ? <CheckCircle2 size={16}/> : <AlertTriangle size={16}/>}
                        {status}
                    </div>
                )}

                <button 
                    onClick={handlePayment}
                    disabled={isVerifying || !isFormValid || isProcessing}
                    className="w-full bg-slate-900 hover:bg-black text-white font-black py-5 rounded-[1.5rem] flex items-center justify-center gap-3 transition-all active:scale-95 disabled:opacity-30 shadow-xl shadow-slate-900/20"
                >
                    {isProcessing ? (
                      <><Loader2 size={20} className="animate-spin text-emerald-400"/> SECURING BLOCKCHAIN...</>
                    ) : (
                      <><ShieldCheck size={20} className="text-emerald-400" /> CONFIRM & PAY {cryptoToCharge} {selectedToken.symbol}</>
                    )}
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
                <div className="flex flex-col space-y-4">
                    {currentTransactions.map((tx, idx) => (
                        <div 
                          key={idx} 
                          onClick={() => setSelectedReceipt(tx)} 
                          className="p-4 bg-slate-50 rounded-2xl border border-slate-100 flex justify-between items-center cursor-pointer hover:bg-emerald-50 hover:border-emerald-100 transition-all group"
                        >
                            <div>
                                <p className="text-xs font-black text-slate-800 uppercase group-hover:text-emerald-700 transition-colors">{tx.network} {tx.service}</p>
                                <p className="text-[10px] text-slate-500">{tx.date} • <span className={tx.status === 'SUCCESS' ? 'text-emerald-600 font-bold' : 'text-orange-500 font-bold'}>{tx.status}</span></p>
                            </div>
                            <div className="text-right flex flex-col items-end gap-1">
                                <p className="text-xs font-black text-emerald-600">₦{tx.amountNaira}</p>
                                <span className="text-[8px] font-black uppercase tracking-widest bg-slate-200 text-slate-500 px-2 py-0.5 rounded-full group-hover:bg-emerald-200 group-hover:text-emerald-800 transition-colors flex items-center gap-1">
                                  View Receipt <ExternalLink size={8}/>
                                </span>
                            </div>
                        </div>
                    ))}

                    {totalPages > 1 && (
                      <div className="flex justify-between items-center mt-4 pt-4 border-t border-slate-100">
                        <button 
                          onClick={() => setCurrentPage(p => Math.max(1, p - 1))} 
                          disabled={currentPage === 1} 
                          className="flex items-center gap-1 px-3 py-2 text-[10px] font-black uppercase text-slate-500 hover:text-emerald-600 disabled:opacity-30 transition-colors"
                        >
                          <ChevronLeft size={14} /> Prev
                        </button>
                        <span className="text-[10px] font-black tracking-widest text-slate-400">PAGE {currentPage} OF {totalPages}</span>
                        <button 
                          onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} 
                          disabled={currentPage === totalPages} 
                          className="flex items-center gap-1 px-3 py-2 text-[10px] font-black uppercase text-slate-500 hover:text-emerald-600 disabled:opacity-30 transition-colors"
                        >
                          Next <ChevronRight size={14} />
                        </button>
                      </div>
                    )}
                </div>
             )}
          </div>
        )}

        <footer className="mt-12 w-full border-t border-slate-200 pt-8 pb-4 flex flex-col items-center gap-4">
          <div className="flex items-center gap-2 opacity-50">
             <ShieldCheck size={14} className="text-emerald-600" />
             <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Secured by Celo Network</span>
          </div>
          <div className="flex gap-6">
            <a href="#" onClick={(e) => { e.preventDefault(); setIsTermsOpen(true); }} className="text-[10px] font-black text-slate-400 hover:text-emerald-600 uppercase tracking-tighter">Terms</a>
            <a href="#" onClick={(e) => { e.preventDefault(); setIsPrivacyOpen(true); }} className="text-[10px] font-black text-slate-400 hover:text-emerald-600 uppercase tracking-tighter">Privacy</a>
          </div>
          <p className="text-[9px] font-medium text-slate-300 uppercase tracking-[0.2em] mt-2">© 2026 MASONODE ORGANISATION</p>
        </footer>
      </div>
    </main>
  );
}
