"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { createWalletClient, createPublicClient, custom, http, parseUnits, formatUnits } from "viem";
import { celo, celoSepolia } from "viem/chains";
import { 
  Wallet, Receipt, ShieldCheck, Zap, AlertTriangle, 
  CheckCircle2, ExternalLink, Lightbulb, Phone, Wifi, Tv, 
  ChevronDown, Loader2, HelpCircle, XCircle, Mail, 
  Paperclip, Send, Coins, Briefcase, Download, Share2,
  ChevronLeft, ChevronRight, RefreshCw, ListPlus, Users, Landmark, Globe
} from "lucide-react";
import { supabase } from "@/utils/supabase";
import { ELECTRICITY_DISCOS } from "./discos";

// --- WEB3 CONFIG ---
const ABAPAY_ABI = [{"inputs":[{"internalType":"address","name":"tokenAddress","type":"address"},{"internalType":"string","name":"serviceType","type":"string"},{"internalType":"string","name":"accountNumber","type":"string"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"payBill","outputs":[],"stateMutability":"nonpayable","type":"function"}];
const ERC20_ABI = [
  {"inputs":[{"internalType":"address","name":"spender","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"approve","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"address","name":"account","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"}
];

const SERVICES = [
  { id: "AIRTIME", name: "Buy Airtime", icon: Phone, color: "text-[#34d399]", bg: "bg-emerald-500/10" },
  { id: "INTERNET", name: "Internet", icon: Globe, color: "text-[#0ea5e9]", bg: "bg-sky-500/10" },
  { id: "ELECTRICITY", name: "Electricity", icon: Lightbulb, color: "text-[#f97316]", bg: "bg-orange-500/10" },
  { id: "CABLE", name: "Cable TV", icon: Tv, color: "text-[#ec4899]", bg: "bg-pink-500/10" },
];

const ELECTRICITY_PROVIDER_IDS = ELECTRICITY_DISCOS.map(d => d.serviceID); 

const CABLE_PROVIDERS_LIST = [
  { serviceID: "dstv", displayName: "DSTV", logo: "/dstv.png" },
  { serviceID: "gotv", displayName: "GOTV", logo: "/gotv.png" },
  { serviceID: "showmax", displayName: "Showmax", logo: "/showmax.png" },
];

const TELECOM_PROVIDERS = ["mtn", "glo", "9mobile", "airtel"]; 

const INTERNET_PROVIDERS = [
  { serviceID: "mtn-data", displayName: "MTN Data", logo: "/mtn.png" },
  { serviceID: "glo-data", displayName: "Glo Data", logo: "/glo.png" },
  { serviceID: "airtel-data", displayName: "Airtel Data", logo: "/airtel.png" },
  { serviceID: "9mobile-data", displayName: "9Mobile Data", logo: "/9mobile.png" },
  { serviceID: "smile-direct", displayName: "Smile Network", logo: "/smile.png" },
  { serviceID: "spectranet", displayName: "Spectranet", logo: "/spectranet.png" }
];

const SUPPORTED_TOKENS = [
  { symbol: "USD₮", decimals: 6, mainnet: "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e", sepolia: "0xd077A400968890Eacc75cdc901F0356c943e4fDb", logo: "/usdt.png" },
  { symbol: "USDC", decimals: 6, mainnet: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", sepolia: "0x01C5C0122039549AD1493B8220cABEdD739BC44E", logo: "/usdc.png" },
  { symbol: "USDm", decimals: 18, mainnet: "0x765DE816845861e75A25fCA122bb6898B8B1282a", sepolia: "0xdE9e4C3ce781b4bA68120d6261cbad65ce0aB00b", logo: "/cusd.png" },
];

const SUPPORTED_COUNTRIES = [
  { code: "NG", name: "Nigeria", flag: "🇳🇬", disabled: false },
  { code: "SOON", name: "Other countries coming soon", flag: "🌍", disabled: true }
];

const PRE_SELECT_AMOUNTS = ["100", "200", "500", "1000", "2000"];
const ELEC_PRE_SELECT_AMOUNTS = ["1000", "2000", "5000", "10000", "20000"];
const DATA_CATEGORIES = ["Daily", "Weekly", "Monthly", "Social", "Mega", "Broadband"];
const ITEMS_PER_PAGE = 5;

const extractVtpassArray = (data: any): any[] => {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (data.content && Array.isArray(data.content.varations)) return data.content.varations;
  if (data.content && Array.isArray(data.content.variations)) return data.content.variations;
  if (data.content && Array.isArray(data.content)) return data.content;
  if (data.data && Array.isArray(data.data)) return data.data;
  if (data.content && typeof data.content === 'object') {
    const nestedArrays = Object.values(data.content).filter(v => Array.isArray(v as any));
    if (nestedArrays.length > 0) return nestedArrays[0] as any[];
    return Object.values(data.content); 
  }
  return [];
};

export default function Home() {
  const [isInitiallyLoading, setIsInitiallyLoading] = useState(true);
  const [address, setAddress] = useState<string | null>(null);
  const [client, setClient] = useState<any>(null);
  const [nairaAmount, setNairaAmount] = useState(""); 
  const [accountNumber, setAccountNumber] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [status, setStatus] = useState("");
  
  const [activeTab, setActiveTab] = useState<"pay" | "bank" | "history">("pay");
  const [isMiniPay, setIsMiniPay] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false); 

  const [customerName, setCustomerName] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);

  const [cableCurrentBouquet, setCableCurrentBouquet] = useState<string | null>(null);
  const [cableRenewAmount, setCableRenewAmount] = useState<number | null>(null);
  const [cableSubscriptionType, setCableSubscriptionType] = useState<"renew" | "change">("renew");
  const [cableVariations, setCableVariations] = useState<any[]>([]);
  const [selectedCablePlan, setSelectedCablePlan] = useState<any>(null);

  // ⚡ INTERNET STATES ⚡
  const [internetVariations, setInternetVariations] = useState<any[]>([]);
  const [selectedInternetPlan, setSelectedInternetPlan] = useState<any>(null);
  const [internetAccountId, setInternetAccountId] = useState<string | null>(null);

  // ⚡ BANK TRANSFER STATES ⚡
  const [bankVariations, setBankVariations] = useState<any[]>([]);
  const [selectedBank, setSelectedBank] = useState<any>(null);
  const [isFetchingBanks, setIsFetchingBanks] = useState(false);

  const [activeCountry, setActiveCountry] = useState(SUPPORTED_COUNTRIES[0]);
  const [activeService, setActiveService] = useState(SERVICES[0]);
  const [elecProvider, setElecProvider] = useState(ELECTRICITY_PROVIDER_IDS[0]);
  const [cableProvider, setCableProvider] = useState(CABLE_PROVIDERS_LIST[0].serviceID);
  const [telecomProvider, setTelecomProvider] = useState(TELECOM_PROVIDERS[0]);
  const [internetProvider, setInternetProvider] = useState(INTERNET_PROVIDERS[0].serviceID);
  const [meterType, setMeterType] = useState<"prepaid" | "postpaid">("prepaid");
  const [activeDataCategory, setActiveDataCategory] = useState(DATA_CATEGORIES[0]);

  const [selectedReceipt, setSelectedReceipt] = useState<any>(null); 
  const [isTermsOpen, setIsTermsOpen] = useState(false); 
  const [isPrivacyOpen, setIsPrivacyOpen] = useState(false); 
  const [isSupportOpen, setIsSupportOpen] = useState(false);
  const [supportMessage, setSupportMessage] = useState("");
  const [supportTxHash, setSupportTxHash] = useState<string | null>(null);
  const [supportFile, setSupportFile] = useState<File | null>(null);
  const [isSendingSupport, setIsSendingSupport] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [isSelectionModalOpen, setIsSelectionModalOpen] = useState(false);
  const [modalTitle, setModalTitle] = useState("");
  const [modalOptions, setModalOptions] = useState<any[]>([]); 
  const [modalCallback, setModalCallback] = useState<((value: string) => void) | null>(null);
  const [modalType, setModalType] = useState<'standard' | 'token' | 'provider' | 'country' | 'bank'>('standard'); 
  const [toast, setToast] = useState<{title: string, message: string, type: 'success' | 'error'} | null>(null);
  const [currentPage, setCurrentPage] = useState(1);

  const [selectedToken, setSelectedToken] = useState(SUPPORTED_TOKENS[0]);
  const [walletBalance, setWalletBalance] = useState("0.00");
  const [isFetchingBalance, setIsFetchingBalance] = useState(false);
  const [exchangeRate, setExchangeRate] = useState<number>(1550); 
  const [transactions, setTransactions] = useState<any[]>([]);

  const isMainnet = process.env.NEXT_PUBLIC_NETWORK === "celo";
  const activeChain = isMainnet ? celo : celoSepolia;
  const ABAPAY_CONTRACT = process.env.NEXT_PUBLIC_ABAPAY_ADDRESS as `0x${string}`;

  const showToast = (title: string, message: string, type: 'success' | 'error' = 'success') => {
    setToast({ title, message, type });
    setTimeout(() => setToast(null), 5000);
  };

  const dynamicMinAmount = useMemo(() => {
    if (activeTab === "bank") return 1000;
    if (activeService.id === "ELECTRICITY") return 1000; 
    if (activeService.id === "CABLE") return 500;
    return 100; 
  }, [activeService, activeTab]);

  const dynamicMaxAmount = useMemo(() => {
    if (activeTab === "bank") return 5000000;
    if (activeService.id === "ELECTRICITY") return 1000000; 
    if (activeService.id === "AIRTIME") return 50000;
    return Infinity; 
  }, [activeService, activeTab]);

  const indexOfLastItem = currentPage * ITEMS_PER_PAGE;
  const indexOfFirstItem = indexOfLastItem - ITEMS_PER_PAGE;
  const currentTransactions = transactions.slice(indexOfFirstItem, indexOfLastItem);
  const totalPages = Math.ceil(transactions.length / ITEMS_PER_PAGE);

  useEffect(() => {
    if (status && !isProcessing) setStatus("");
  }, [accountNumber, nairaAmount, activeService, cableSubscriptionType, selectedCablePlan, selectedBank, selectedInternetPlan, activeTab]);

  useEffect(() => {
    if (status && !isProcessing) {
      const timer = setTimeout(() => setStatus(""), 5000); 
      return () => clearTimeout(timer);
    }
  }, [status, isProcessing]);

  useEffect(() => {
    async function initSystem() {
      const savedHistory = localStorage.getItem("abapay_history");
      if (savedHistory) setTransactions(JSON.parse(savedHistory));

      try {
        const { data: settingsData } = await supabase.from('platform_settings').select('exchange_rate').eq('id', 1).single();
        if (settingsData && settingsData.exchange_rate) setExchangeRate(Number(settingsData.exchange_rate));
      } catch (consoleError) {}

      if (typeof window !== "undefined" && (window as any).ethereum) {
        const eth = (window as any).ethereum;
        if (eth.isMiniPay) setIsMiniPay(true);
        const walletClient = createWalletClient({ chain: activeChain, transport: custom(eth) });
        walletClient.requestAddresses().then(([acc]) => {
          setAddress(acc); setClient(walletClient);
        }).catch((e) => console.log("Connection deferred"));
      }

      setTimeout(() => setIsInitiallyLoading(false), 2000);
    }
    initSystem();
  }, [activeChain]);

  useEffect(() => {
    if (!address) return;
    async function fetchCloudHistory() {
      try {
        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
        const { data } = await supabase.from('transactions').select('*').eq('wallet_address', address).gte('created_at', sixMonthsAgo.toISOString()).order('created_at', { ascending: false });

        if (data && data.length > 0) {
          const cloudHistory = data.map((tx: any) => ({
            id: tx.tx_hash.slice(0, 8), date: new Date(tx.created_at).toLocaleString(), status: tx.status,
            amountNaira: tx.amount_naira.toString(), amountCrypto: tx.amount_usdt.toString(), tokenUsed: "USD₮", 
            service: tx.service_category, network: tx.network, txHash: tx.tx_hash, account: tx.account_number,
            refund_hash: tx.refund_hash, purchased_code: tx.purchased_code, request_id: tx.request_id, units: tx.units 
          }));
          setTransactions(cloudHistory);
          localStorage.setItem("abapay_history", JSON.stringify(cloudHistory));
        }
      } catch (e) {}
    }
    fetchCloudHistory();
  }, [address]);

  useEffect(() => {
    async function fetchBalance() {
      if (!address) return;
      setIsFetchingBalance(true);
      try {
        const publicClient = createPublicClient({ chain: activeChain, transport: http() });
        const tokenAddress = isMainnet ? selectedToken.mainnet : selectedToken.sepolia;
        const balanceWei = await publicClient.readContract({ address: tokenAddress as `0x${string}`, abi: ERC20_ABI, functionName: 'balanceOf', args: [address] });
        setWalletBalance(parseFloat(formatUnits(balanceWei as bigint, selectedToken.decimals)).toFixed(4));
      } catch (error) { setWalletBalance("0.00"); }
      setIsFetchingBalance(false);
    }
    fetchBalance();
  }, [address, selectedToken, activeChain, isMainnet]);

  // ⚡ DEDICATED BANK FETCHER (Crash Proof) ⚡
  useEffect(() => {
    if (activeTab === "bank" && bankVariations.length === 0) {
      const fetchBanks = async () => {
        setIsFetchingBanks(true);
        try {
          const res = await fetch(`/api/variations?serviceID=bank-deposit`);
          const data = await res.json();
          let banksArr = extractVtpassArray(data);
          
          if (banksArr && Array.isArray(banksArr) && banksArr.length > 0) {
            const sortedBanks = banksArr.sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""));
            setBankVariations(sortedBanks);
          }
        } catch (e) {}
        setIsFetchingBanks(false);
      };
      fetchBanks();
    }
  }, [activeTab]);

  // ⚡ DEDICATED UTILITY VARIATION FETCHER ⚡
  useEffect(() => {
    if (activeTab !== "pay") return;

    if (activeService.id === "CABLE") {
      const fetchVariations = async () => {
        try {
          const res = await fetch(`/api/variations?serviceID=${cableProvider}`);
          const data = await res.json();
          setCableVariations(extractVtpassArray(data));
        } catch (e) {}
      };
      fetchVariations();
    } else if (activeService.id === "INTERNET") {
      const fetchInternetVariations = async () => {
        setInternetVariations([]);
        try {
          const res = await fetch(`/api/variations?serviceID=${internetProvider}`);
          const data = await res.json();
          setInternetVariations(extractVtpassArray(data));
        } catch (e) {}
      };
      fetchInternetVariations();
    }
  }, [activeTab, activeService.id, cableProvider, internetProvider]);

  // ⚡ AUTO NETWORK DETECTION ⚡
  useEffect(() => {
    if (activeTab === "pay") {
      if (activeService.id === "AIRTIME" && accountNumber.length >= 4) {
        const prefix = accountNumber.substring(0, 4);
        if (["0803","0806","0810","0813","0814","0816","0903","0906","0913","0916","0703","0706"].includes(prefix)) setTelecomProvider("mtn");
        else if (["0802","0808","0812","0902","0907","0912","0701","0708"].includes(prefix)) setTelecomProvider("airtel");
        else if (["0805","0807","0811","0905","0705","0915"].includes(prefix)) setTelecomProvider("glo");
        else if (["0809","0817","0818","0908","0909"].includes(prefix)) setTelecomProvider("9mobile");
      }
      if (activeService.id === "INTERNET" && internetProvider.includes("-data") && accountNumber.length >= 4) {
        const prefix = accountNumber.substring(0, 4);
        if (["0803","0806","0810","0813","0814","0816","0903","0906","0913","0916","0703","0706"].includes(prefix)) setInternetProvider("mtn-data");
        else if (["0802","0808","0812","0902","0907","0912","0701","0708"].includes(prefix)) setInternetProvider("airtel-data");
        else if (["0805","0807","0811","0905","0705","0915"].includes(prefix)) setInternetProvider("glo-data");
        else if (["0809","0817","0818","0908","0909"].includes(prefix)) setInternetProvider("9mobile-data");
      }
    }
  }, [accountNumber, activeService, activeTab, internetProvider]);

  // ⚡ MERCHANT VERIFICATION ENGINE ⚡
  const verifyMerchant = async () => {
    setIsVerifying(true);
    setCustomerName(null);
    setCableCurrentBouquet(null);
    setCableRenewAmount(null);
    setInternetAccountId(null);

    try {
        let serviceID = "";
        let reqType = undefined;

        if (activeTab === "bank") {
           serviceID = "bank-deposit";
           reqType = selectedBank?.variation_code;
        } else {
           serviceID = activeService.id === "ELECTRICITY" ? elecProvider : activeService.id === "INTERNET" ? internetProvider : cableProvider;
           reqType = activeService.id === "ELECTRICITY" ? meterType : undefined;
        }

        const res = await fetch(`/api/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ billersCode: accountNumber, serviceID: serviceID, type: reqType }) 
        });

        const data = await res.json();

        if (data.code === '000') {
          setCustomerName(data.content.Customer_Name || data.content.account_name || data.content.name);

          if (activeTab === "pay" && activeService.id === "INTERNET" && internetProvider === "smile-direct") {
             setInternetAccountId(data.content.AccountId || data.content.account_id);
          }

          if (activeTab === "pay" && activeService.id === "CABLE") {
            setCableCurrentBouquet(data.content.Current_Bouquet || "Unknown Package");
            if (data.content.Renewal_Amount && ['dstv', 'gotv'].includes(cableProvider)) {
              setCableRenewAmount(data.content.Renewal_Amount);
              if (cableSubscriptionType === "renew") setNairaAmount(data.content.Renewal_Amount.toString());
            }
          }
        } else {
            setStatus("Account could not be verified.");
        }
    } catch (e) {}
    setIsVerifying(false);
  };

  useEffect(() => {
    if (activeTab === "bank") {
       if (accountNumber.length === 10 && selectedBank) verifyMerchant();
       else setCustomerName(null);
    } else if (activeTab === "pay") {
       if (activeService.id === "ELECTRICITY" && accountNumber.length >= 10) verifyMerchant();
       else if (activeService.id === "CABLE" && cableProvider !== "showmax" && accountNumber.length >= 10) verifyMerchant();
       else if (activeService.id === "INTERNET" && internetProvider === "smile-direct" && accountNumber.includes('@') && accountNumber.includes('.')) {
          const timeoutId = setTimeout(() => verifyMerchant(), 1000);
          return () => clearTimeout(timeoutId);
       } else {
          setCustomerName(null);
       }
    }
  }, [accountNumber, elecProvider, cableProvider, activeService, meterType, selectedBank, internetProvider, activeTab]);

  const { cryptoToCharge, currentFee } = useMemo(() => {
    const bill = parseFloat(nairaAmount) || 0;
    const fee = (activeTab === "bank" || activeService.id === "ELECTRICITY" || activeService.id === "CABLE") ? 100 : 0;
    const crypto = (bill + fee) / exchangeRate;
    return { cryptoToCharge: crypto.toFixed(4), currentFee: fee };
  }, [nairaAmount, exchangeRate, activeService, activeTab]);

  const filteredInternetDataPlans = useMemo(() => {
    if (!internetVariations || internetVariations.length === 0) return [];
    
    if (internetProvider === 'smile-direct' || internetProvider === 'spectranet') {
        return internetVariations;
    }

    return internetVariations.filter(plan => {
      const name = (plan.name || "").toLowerCase();
      let category = "Monthly";

      if (name.includes('broadband') || name.includes('router') || name.includes('5g') || name.includes('hynet')) category = "Broadband";
      else if (name.includes('social') || name.includes('whatsapp') || name.includes('ig') || name.includes('instagram') || name.includes('tiktok') || name.includes('youtube') || name.includes('facebook') || name.includes('opera') || name.includes('xot')) category = "Social";
      else if (name.includes('60 day') || name.includes('90 day') || name.includes('120 day') || name.includes('year') || name.includes('mega') || name.includes('3 month') || name.includes('2 month')) category = "Mega";
      else if (name.includes('month') || name.includes('30 day')) category = "Monthly";
      else if (name.includes('week') || name.includes('7 day') || name.includes('14 day') || name.includes('weekend')) category = "Weekly";
      else if (name.includes('1 day') || name.includes('2 day') || name.includes('3 day') || name.includes('daily') || name.includes('24 hrs') || name.includes('24hrs') || name.includes('night') || name.includes('hourly')) category = "Daily";

      return category === activeDataCategory;
    }).sort((a, b) => parseFloat(a.variation_amount) - parseFloat(b.variation_amount));

  }, [internetVariations, activeDataCategory, internetProvider]);

  const isFormValid = useMemo(() => {
    const amount = parseFloat(nairaAmount);
    if (!nairaAmount || isNaN(amount) || amount < dynamicMinAmount || amount > dynamicMaxAmount) return false;

    if (activeTab === "bank") {
       return accountNumber.length === 10 && customerName !== null && selectedBank !== null && customerPhone.length >= 10;
    }

    if (activeTab === "pay") {
      if (activeService.id === "AIRTIME") return accountNumber.length === 11 && accountNumber.startsWith("0");
      if (activeService.id === "INTERNET") {
        if (internetProvider === 'smile-direct') {
          return internetAccountId !== null && selectedInternetPlan !== null && customerPhone.length >= 10;
        } else if (internetProvider === 'spectranet') {
          return accountNumber.length >= 5 && selectedInternetPlan !== null && customerPhone.length >= 10;
        } else {
          return accountNumber.length === 11 && accountNumber.startsWith("0") && selectedInternetPlan !== null;
        }
      }
      if (activeService.id === "ELECTRICITY") return accountNumber.length >= 10 && customerName !== null;
      if (activeService.id === "CABLE") {
        if (cableProvider === "showmax") return accountNumber.length >= 11 && selectedCablePlan !== null;
        if (accountNumber.length < 10 || customerName === null) return false;
        if (['dstv', 'gotv'].includes(cableProvider)) {
          if (cableSubscriptionType === 'change' && !selectedCablePlan) return false;
        } else {
          if (!selectedCablePlan) return false;
        }
        return true;
      }
    }
    return false;
  }, [accountNumber, nairaAmount, activeService, customerName, dynamicMinAmount, dynamicMaxAmount, cableSubscriptionType, selectedCablePlan, selectedBank, selectedInternetPlan, internetAccountId, customerPhone, internetProvider, activeTab]);

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
      } catch (switchError) { await client.addChain({ chain: activeChain }); }

      const valueInWei = parseUnits(cryptoToCharge, selectedToken.decimals);
      const tokenAddress = isMainnet ? selectedToken.mainnet : selectedToken.sepolia;
      const publicClient = createPublicClient({ chain: activeChain, transport: http() });

      setStatus("Awaiting token approval...");
      const approvalHash = await client.writeContract({ address: tokenAddress as `0x${string}`, abi: ERC20_ABI, functionName: 'approve', args: [ABAPAY_CONTRACT, valueInWei], account: address });
      
      setStatus("Mining approval on Celo Mainnet... Please wait.");
      await publicClient.waitForTransactionReceipt({ hash: approvalHash });
      setStatus("Approval confirmed! Please sign the final payment...");

      let vtpassServiceID = "";
      let displayNetwork = "";
      let finalVariationCode = 'prepaid';
      let payloadBillersCode = accountNumber;
      let uiCategory = "";

      if (activeTab === "bank") {
        vtpassServiceID = "bank-deposit"; 
        displayNetwork = selectedBank.name;
        finalVariationCode = selectedBank.variation_code; 
        uiCategory = "BANK";
      } else {
        uiCategory = activeService.id;
        if (activeService.id === "ELECTRICITY") {
          vtpassServiceID = elecProvider; displayNetwork = elecProvider; finalVariationCode = meterType;
        } else if (activeService.id === "CABLE") {
          vtpassServiceID = cableProvider; displayNetwork = cableProvider;
          if (['dstv', 'gotv'].includes(cableProvider)) finalVariationCode = cableSubscriptionType === 'change' ? selectedCablePlan?.variation_code : 'none'; 
          else finalVariationCode = selectedCablePlan?.variation_code || 'none';
        } else if (activeService.id === "INTERNET") {
          vtpassServiceID = internetProvider; 
          if (internetProvider === 'smile-direct') { displayNetwork = "Smile Network"; payloadBillersCode = internetAccountId || accountNumber; }
          else if (internetProvider === 'spectranet') displayNetwork = "Spectranet";
          else displayNetwork = internetProvider.replace('-data', ''); 
          finalVariationCode = selectedInternetPlan?.variation_code || 'none'; 
        } else {
          vtpassServiceID = telecomProvider; displayNetwork = telecomProvider;
        }
      }

      const hash = await client.writeContract({
        address: ABAPAY_CONTRACT, abi: ABAPAY_ABI, functionName: 'payBill', args: [tokenAddress, vtpassServiceID, payloadBillersCode, valueInWei], account: address
      });

      setStatus(`${selectedToken.symbol} Secured. Processing...`);

      const backendPayload = {
        serviceID: vtpassServiceID, serviceCategory: uiCategory, network: displayNetwork.toUpperCase(), 
        billersCode: payloadBillersCode, amount: cryptoToCharge, nairaAmount: nairaAmount, token: selectedToken.symbol,
        txHash: hash, variation_code: finalVariationCode, phone: customerPhone || accountNumber, wallet_address: address,
        subscription_type: activeTab === "pay" && activeService.id === "CABLE" && ['dstv', 'gotv'].includes(cableProvider) ? cableSubscriptionType : undefined
      };

      const newTx: any = { 
        id: hash.slice(0,8), date: new Date().toLocaleString(), status: "PENDING", amountNaira: nairaAmount, amountCrypto: cryptoToCharge,
        tokenUsed: selectedToken.symbol, service: uiCategory === "BANK" ? "Bank Transfer" : activeService.name, 
        network: displayNetwork.toUpperCase(), txHash: hash, account: accountNumber
      };

      setAccountNumber(""); setNairaAmount(""); setCustomerPhone(""); setCustomerName(null);
      setSelectedCablePlan(null); setCableCurrentBouquet(null);
      setSelectedBank(null); setSelectedInternetPlan(null); setInternetAccountId(null);

      const res = await fetch('/api/pay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(backendPayload) });
      const result = await res.json();

      if (result.success) {
        setStatus("Success! Token/Ref Dispatched.");
        newTx.status = "SUCCESS"; newTx.purchased_code = result.purchased_code; newTx.units = result.units; newTx.request_id = result.data?.requestId; 
        showToast("Transaction Successful", "Your transaction has been successfully processed.", "success");
      } else {
        setStatus(`Error: ${result.message || 'Transaction Failed'}`);
        newTx.status = "FAILED_VENDING";
      }

      const updatedHistory = [newTx, ...transactions];
      setTransactions(updatedHistory); localStorage.setItem("abapay_history", JSON.stringify(updatedHistory));
      setCurrentPage(1);

      const balanceWei = await publicClient.readContract({ address: tokenAddress as `0x${string}`, abi: ERC20_ABI, functionName: 'balanceOf', args: [address] });
      setWalletBalance(parseFloat(formatUnits(balanceWei as bigint, selectedToken.decimals)).toFixed(4));

    } catch (e) { setStatus("Transaction Cancelled."); } finally { setIsProcessing(false); }
  };

  const handleResetService = (s: any) => {
    setActiveService(s); setAccountNumber(""); setCustomerName(null); setNairaAmount(""); 
    setCableCurrentBouquet(null); setCableRenewAmount(null); setSelectedCablePlan(null);
    setCableSubscriptionType("renew"); setSelectedBank(null); setSelectedInternetPlan(null); setInternetAccountId(null);
  };

  const openSelectionModal = (type: 'standard' | 'token' | 'provider' | 'country' | 'bank', title: string, options: any[], callback: (value: string) => void) => {
    setModalType(type as any); setModalTitle(title); setModalOptions(options); setModalCallback(() => callback); setIsSelectionModalOpen(true);
  };

  const handleCountryChange = (countryCode: string) => {
    const country = SUPPORTED_COUNTRIES.find(c => c.code === countryCode);
    if (country && !country.disabled) { setActiveCountry(country); handleResetService(SERVICES[0]); }
  };

  const handleShareReceipt = async () => {
    const receiptText = `🧾 AbaPay Receipt\n\nDate: ${selectedReceipt.date}\nStatus: ${selectedReceipt.status}\nProduct: ${selectedReceipt.network} ${selectedReceipt.service}\nRecipient: ${selectedReceipt.account}\nAmount Paid: ₦${selectedReceipt.amountNaira}\nCrypto Used: ${selectedReceipt.amountCrypto} ${selectedReceipt.tokenUsed}\nTx Hash: ${selectedReceipt.txHash}\n\nSecured by Celo Network`;
    if (navigator.share) { try { await navigator.share({ title: 'Receipt', text: receiptText }); } catch (err) {} } 
    else { try { await navigator.clipboard.writeText(receiptText); showToast("Copied!", "Receipt details copied to clipboard.", "success"); } catch (err) {} }
  };

  const submitSupportTicket = async () => {
    if (!supportMessage.trim()) return;
    setIsSendingSupport(true);
    try {
      const formData = new FormData(); formData.append("message", supportMessage);
      if (address) formData.append("userAddress", address); if (supportTxHash) formData.append("txHash", supportTxHash); if (supportFile) formData.append("file", supportFile);
      await fetch('/api/support', { method: 'POST', body: formData });
      setIsSupportOpen(false); setSupportMessage(""); setSupportFile(null); setSupportTxHash(null); 
      showToast("Ticket Submitted", "Support has received your request.", "success");
    } catch (error) { showToast("Connection Error", "Failed to send the ticket.", "error"); } finally { setIsSendingSupport(false); }
  };

  useEffect(() => {
    const checkRefunds = async () => {
      if (activeTab === "history" && transactions.length > 0) {
        const failedHashes = transactions.filter(tx => tx.status !== 'SUCCESS').map(tx => tx.txHash);
        if (failedHashes.length === 0) return;
        try {
          const { data } = await supabase.from('transactions').select('tx_hash, status, refund_hash').in('tx_hash', failedHashes);
          if (data && data.length > 0) {
            let updated = false;
            const newHistory = transactions.map(tx => {
              const dbRecord = data.find(r => r.tx_hash === tx.txHash);
              if (dbRecord && dbRecord.status === 'REFUNDED' && tx.status !== 'REFUNDED') { updated = true; return { ...tx, status: 'REFUNDED', refund_hash: dbRecord.refund_hash }; }
              return tx;
            });
            if (updated) { setTransactions(newHistory); localStorage.setItem("abapay_history", JSON.stringify(newHistory)); }
          }
        } catch(e) {}
      }
    };
    checkRefunds();
  }, [activeTab]);

  const currentDisco = useMemo(() => { return ELECTRICITY_DISCOS.find(d => d.serviceID === elecProvider); }, [elecProvider]);
  const currentCable = useMemo(() => { return CABLE_PROVIDERS_LIST.find(c => c.serviceID === cableProvider); }, [cableProvider]);
  const currentInternet = useMemo(() => { return INTERNET_PROVIDERS.find(c => c.serviceID === internetProvider); }, [internetProvider]);

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900 font-sans p-4 flex flex-col items-center pb-20 relative">
      <style>{`@keyframes logoScale { 0%, 100% { transform: scale(1); opacity: 0.9; } 50% { transform: scale(1.1); opacity: 1; } } .animate-logo-scale { animation: logoScale 1.5s ease-in-out infinite; } .no-scrollbar::-webkit-scrollbar { display: none; } .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }`}</style>
      
      {isInitiallyLoading && (
        <div className="fixed inset-0 z-[100] bg-white flex flex-col items-center justify-center animate-in fade-out duration-500 fill-mode-forwards" style={{ animationDelay: '1.5s' }}>
          <img src="/logo.png" alt="AbaPay" className="h-28 w-auto object-contain animate-logo-scale mb-10" />
          <div className="flex flex-col items-center gap-2">
             <div className="w-12 h-0.5 bg-emerald-500 rounded-full animate-pulse" />
             <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Loading AbaPay Protocol...</p>
          </div>
        </div>
      )}

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

      {selectedReceipt && (
        <div className="fixed inset-0 z-[60] bg-slate-900/80 backdrop-blur-md flex justify-center items-center p-6 animate-in fade-in">
           <div className="bg-white w-full max-w-sm rounded-[2.5rem] overflow-hidden shadow-2xl animate-in zoom-in-95">
              <div className="bg-emerald-600 p-8 text-white text-center relative">
                 <button onClick={() => setSelectedReceipt(null)} className="absolute top-4 right-4 bg-white/20 p-1.5 rounded-full hover:bg-white/30 transition-colors"><XCircle size={20}/></button>
                 <CheckCircle2 size={48} className="mx-auto mb-3 opacity-90" />
                 <h2 className="text-xl font-black tracking-tight">Payment Receipt</h2>
                 <p className="text-emerald-100 text-xs font-bold uppercase tracking-widest mt-1">AbaPay Secured</p>
              </div>
              <div className="p-8 space-y-4">
                 <div className="flex justify-between border-b border-slate-100 pb-3">
                    <span className="text-slate-400 text-[10px] font-bold uppercase tracking-wider">Status</span>
                    <span className={`font-black text-xs uppercase ${selectedReceipt.status === 'SUCCESS' ? 'text-emerald-600' : selectedReceipt.status === 'REFUNDED' ? 'text-blue-600' : 'text-orange-500'}`}>{selectedReceipt.status}</span>
                 </div>
                 <div className="flex justify-between border-b border-slate-100 pb-3">
                    <span className="text-slate-400 text-[10px] font-bold uppercase tracking-wider">Date & Time</span>
                    <span className="text-slate-800 font-bold text-xs">{selectedReceipt.date}</span>
                 </div>
                 <div className="flex justify-between border-b border-slate-100 pb-3">
                    <span className="text-slate-400 text-[10px] font-bold uppercase tracking-wider">Service</span>
                    <span className="text-slate-800 font-black text-xs text-right w-2/3 uppercase">{selectedReceipt.network} {selectedReceipt.service}</span>
                 </div>
                 <div className="flex justify-between border-b border-slate-100 pb-3">
                    <span className="text-slate-400 text-[10px] font-bold uppercase tracking-wider">{selectedReceipt.service === 'Electricity' ? 'Meter Number' : selectedReceipt.service === 'Send Money' ? 'Account No' : 'Recipient'}</span>
                    <span className="text-slate-800 font-mono font-bold text-xs">{selectedReceipt.account}</span>
                 </div>
                 {selectedReceipt.request_id && (
                   <div className="flex justify-between border-b border-slate-100 pb-3">
                      <span className="text-slate-400 text-[10px] font-bold uppercase tracking-wider">Transaction ID</span>
                      <span className="text-slate-800 font-mono font-bold text-[10px]">{selectedReceipt.request_id}</span>
                   </div>
                 )}
                 {selectedReceipt.units && selectedReceipt.units !== "N/A" && (selectedReceipt.service?.toUpperCase() === 'ELECTRICITY' || selectedReceipt.service === 'Electricity') && (
                   <div className="flex justify-between border-b border-slate-100 pb-3">
                      <span className="text-slate-400 text-[10px] font-bold uppercase tracking-wider">Purchased Units</span>
                      <span className="text-slate-800 font-black text-xs">{selectedReceipt.units} kWh</span>
                   </div>
                 )}
                 <div className="flex justify-between border-b border-slate-100 pb-3">
                    <span className="text-slate-400 text-[10px] font-bold uppercase tracking-wider">Amount Paid</span>
                    <div className="text-right">
                       <p className="text-slate-800 font-black text-sm">₦{selectedReceipt.amountNaira}</p>
                       <p className="text-slate-400 text-[9px] font-bold">{selectedReceipt.amountCrypto} {selectedReceipt.tokenUsed || 'USD₮'}</p>
                    </div>
                 </div>
                 {selectedReceipt.status === 'SUCCESS' && selectedReceipt.purchased_code && selectedReceipt.purchased_code !== "Vended Successfully" && (selectedReceipt.service?.toUpperCase() === 'ELECTRICITY' || selectedReceipt.service === 'Electricity') && (
                   <div className="mt-4 bg-orange-50 border-2 border-orange-200 rounded-xl p-4 text-center">
                      <p className="text-[10px] font-black text-orange-600 uppercase tracking-widest mb-1">Meter Token PIN</p>
                      <p className="font-mono text-xl font-black text-slate-900 tracking-[0.2em] break-all">{selectedReceipt.purchased_code.replace(/token\s*[:\-]*\s*/gi, '').trim()}</p>
                      <p className="text-[9px] font-bold text-orange-500 mt-2">Enter this exactly as shown into your meter.</p>
                   </div>
                 )}
                 {selectedReceipt.status === 'REFUNDED' && selectedReceipt.refund_hash && (
                   <div className="flex justify-between border-b border-slate-100 pb-3">
                      <span className="text-slate-400 text-[10px] font-bold uppercase tracking-wider">Refund Hash</span>
                      <a href={`https://${isMainnet?'':'sepolia.'}celoscan.io/tx/${selectedReceipt.refund_hash}`} target="_blank" className="text-blue-600 font-mono font-bold text-xs flex items-center justify-end gap-1 hover:underline">View Transfer <ExternalLink size={10}/></a>
                   </div>
                 )}
                 <button onClick={() => window.open(`https://${isMainnet?'':'sepolia.'}celoscan.io/tx/${selectedReceipt.txHash}`)} className="w-full py-3 bg-slate-50 hover:bg-slate-100 rounded-xl text-[10px] font-black uppercase tracking-widest text-slate-500 flex items-center justify-center gap-2 transition-colors">Verify on Celoscan <ExternalLink size={12}/></button>
                 <div className="flex gap-2">
                    <button onClick={handleShareReceipt} className="flex-1 py-4 bg-slate-900 hover:bg-slate-800 text-white rounded-2xl text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 transition-colors active:scale-95 shadow-xl shadow-slate-900/20"><Share2 size={16}/> Share</button>
                    {selectedReceipt.status !== 'SUCCESS' && selectedReceipt.status !== 'REFUNDED' && (
                       <button onClick={() => { setSupportTxHash(selectedReceipt.txHash); setSupportMessage(""); setSelectedReceipt(null); setIsSupportOpen(true); }} className="flex-1 py-4 bg-orange-100 hover:bg-orange-200 text-orange-700 rounded-2xl text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 transition-colors active:scale-95"><HelpCircle size={16}/> Support</button>
                    )}
                 </div>
              </div>
           </div>
        </div>
      )}

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
                 <p>Utility numbers provided (like phone or meter numbers) are securely passed to our fiat vending partners solely for the purpose of delivering your purchased service.</p>
              </div>
           </div>
        </div>
      )}

      {isSelectionModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center p-4 animate-in fade-in" onClick={() => setIsSelectionModalOpen(false)}>
           <div className="bg-white w-full max-w-sm rounded-[2rem] shadow-2xl p-6 animate-in zoom-in-95 duration-200" onClick={(e) => e.stopPropagation()}>
              <div className="flex justify-between items-center mb-6 shrink-0 border-b border-slate-100 pb-4">
                <h2 className="text-xl font-black text-slate-900 tracking-tight">{modalTitle}</h2>
                <button onClick={() => setIsSelectionModalOpen(false)} className="p-2 bg-slate-100 rounded-full hover:bg-slate-200 transition-colors"><XCircle size={20} className="text-slate-500" /></button>
              </div>
              <div className="space-y-2.5 max-h-[50vh] overflow-y-auto pr-1">
                 
                 {modalType === 'country' && SUPPORTED_COUNTRIES.map(country => (
                   <button 
                     key={country.code} 
                     onClick={() => { 
                        if (!country.disabled) {
                            modalCallback?.(country.code); 
                            setIsSelectionModalOpen(false); 
                        }
                     }}
                     disabled={country.disabled}
                     className={`w-full text-left p-4 rounded-xl font-bold text-sm transition-all flex justify-between items-center ${
                         country.disabled 
                         ? 'bg-slate-50 border border-slate-100 text-slate-400 cursor-not-allowed' 
                         : 'text-slate-700 bg-slate-50 border border-slate-100 hover:border-emerald-300 hover:bg-emerald-50/50'
                     }`}
                   >
                     <div className="flex items-center gap-3">
                       <span className="text-2xl">{country.flag}</span>
                       <span className={`font-black ${country.disabled ? 'text-slate-400' : 'text-slate-800'}`}>{country.name}</span>
                     </div>
                     {activeCountry.code === country.code && <CheckCircle2 size={18} className="text-emerald-500"/>}
                   </button>
                 ))}

                 {modalType === 'bank' && isFetchingBanks && (
                   <div className="flex flex-col items-center justify-center p-6 gap-3 text-slate-400">
                     <Loader2 className="animate-spin text-blue-500" size={24} />
                     <span className="text-xs font-bold uppercase tracking-widest">Connecting to NIBSS...</span>
                   </div>
                 )}
                 {modalType === 'bank' && !isFetchingBanks && bankVariations?.length === 0 && (
                   <div className="p-6 text-center text-slate-500 font-bold text-xs">No banks available.</div>
                 )}
                 {modalType === 'bank' && !isFetchingBanks && bankVariations?.map(bank => (
                   <button 
                     key={bank.variation_code} 
                     onClick={() => { modalCallback?.(bank); setIsSelectionModalOpen(false); }}
                     className="w-full text-left p-4 rounded-xl font-bold text-slate-700 bg-slate-50 border border-slate-100 text-xs hover:border-blue-300 hover:bg-blue-50/50 transition-all flex justify-between items-center"
                   >
                     <span>{bank.name}</span>
                     {selectedBank?.variation_code === bank.variation_code && <CheckCircle2 size={18} className="text-blue-500"/>}
                   </button>
                 ))}

                 {modalType === 'token' && SUPPORTED_TOKENS.map(token => (
                   <button 
                     key={token.symbol} 
                     onClick={() => { modalCallback?.(token.symbol); setIsSelectionModalOpen(false); }}
                     className="w-full text-left p-4 rounded-xl font-bold text-slate-700 bg-slate-50 border border-slate-100 uppercase text-xs hover:border-emerald-300 hover:bg-emerald-50/50 transition-all flex justify-between items-center"
                   >
                     <div className="flex items-center gap-3">
                       <img src={token.logo} alt={token.symbol} className="w-6 h-6 object-contain rounded-full shadow-sm bg-white" />
                       <span className="text-sm font-black text-slate-800 tracking-tight">{token.symbol}</span>
                     </div>
                     {selectedToken.symbol === token.symbol && <CheckCircle2 size={18} className="text-emerald-500"/>}
                   </button>
                 ))}

                 {modalType === 'provider' && (modalOptions as any[]).map(provider => (
                    <button 
                        key={provider.serviceID} 
                        onClick={() => { modalCallback?.(provider.serviceID); setIsSelectionModalOpen(false); }}
                        className={`w-full text-left p-4 rounded-2xl font-bold text-slate-700 bg-white border hover:bg-slate-50 transition-all flex justify-between items-center group hover:border-slate-300`}
                    >
                        <div className="flex items-center gap-4">
                            <div className="w-12 h-12 shrink-0 rounded-full border border-slate-100 bg-white p-0.5 flex items-center justify-center shadow-sm overflow-hidden group-hover:shadow-md transition-shadow">
                                <img src={provider.logo} alt={provider.displayName} className="w-full h-full object-contain" onError={(e) => { e.currentTarget.style.display = 'none'; e.currentTarget.parentElement!.innerHTML = `<span class="text-[9px] font-black uppercase text-slate-400">${provider.displayName.slice(0,3)}</span>`; }} />
                            </div>
                            <div>
                                <span className="text-sm font-black text-slate-900 tracking-tight">{provider.displayName}</span>
                            </div>
                        </div>
                        {(activeService.id === 'ELECTRICITY' ? elecProvider === provider.serviceID : activeService.id === 'INTERNET' ? internetProvider === provider.serviceID : cableProvider === provider.serviceID) && (
                          <CheckCircle2 size={20} className={activeService.id === 'ELECTRICITY' ? "text-orange-500" : activeService.id === 'INTERNET' ? "text-sky-500" : "text-pink-500"}/>
                        )}
                    </button>
                 ))}
              </div>
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
            <button 
              onClick={() => openSelectionModal('country', "Select Region", SUPPORTED_COUNTRIES, handleCountryChange)}
              className="bg-slate-50 border border-slate-100 hover:border-emerald-200 px-3 py-1.5 rounded-xl flex items-center gap-2 transition-all shadow-sm active:scale-95"
            >
              <span className="text-lg leading-none">{activeCountry.flag}</span>
              <span className="text-[10px] font-black text-slate-700 uppercase tracking-widest">{activeCountry.code}</span>
              <ChevronDown size={14} className="text-slate-400" />
            </button>
          </div>
        </div>

        <div className="flex gap-2 bg-slate-200/50 p-1.5 rounded-2xl mb-6 shadow-inner">
            <button onClick={() => setActiveTab("pay")} className={`flex-1 py-3 rounded-xl text-xs font-black transition-all ${activeTab === 'pay' ? 'bg-white text-emerald-600 shadow-xl' : 'text-slate-500 hover:text-slate-700'}`}>PAY BILLS</button>
            <button onClick={() => { setActiveTab("bank"); handleResetService(SERVICES[0]); }} className={`flex-1 py-3 rounded-xl text-xs font-black transition-all ${activeTab === 'bank' ? 'bg-white text-emerald-600 shadow-xl' : 'text-slate-500 hover:text-slate-700'}`}>SEND MONEY</button>
            <button onClick={() => setActiveTab("history")} className={`flex-1 py-3 rounded-xl text-xs font-black transition-all ${activeTab === 'history' ? 'bg-white text-emerald-600 shadow-xl' : 'text-slate-500 hover:text-slate-700'}`}>HISTORY</button>
        </div>

        {activeTab === 'bank' ? (
          <div className="bg-white border border-slate-100 rounded-[2.5rem] p-8 shadow-2xl shadow-emerald-900/10 animate-in fade-in zoom-in-95">
            <div className="space-y-5">
                <div className="bg-slate-50 border border-slate-100 p-4 rounded-2xl flex justify-between items-center animate-in fade-in">
                  <div 
                    className="flex items-center gap-2 cursor-pointer hover:bg-slate-100 p-2 -ml-2 rounded-xl transition-colors" 
                    onClick={() => openSelectionModal('token', "Select Token", SUPPORTED_TOKENS, (symbol) => setSelectedToken(SUPPORTED_TOKENS.find(t => t.symbol === symbol)!))}
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
                    <label className="text-[10px] font-black text-slate-400 uppercase mb-3 block">Select Destination Bank</label>
                    <button 
                        onClick={() => openSelectionModal('bank', "Select Destination Bank", bankVariations, (bank: any) => setSelectedBank(bank))}
                        className="w-full bg-white border border-slate-200 p-4 rounded-2xl flex justify-between items-center hover:border-blue-400 transition-colors shadow-sm active:scale-[0.98]"
                    >
                        <div className="flex items-center gap-4">
                            <div className="w-12 h-12 shrink-0 rounded-full border border-slate-100 bg-blue-50 flex items-center justify-center shadow-inner">
                                <Landmark className="text-blue-500" size={20} />
                            </div>
                            <div>
                                <span className="text-sm font-black text-slate-900 tracking-tight">{selectedBank ? selectedBank.name : 'Choose a Bank'}</span>
                            </div>
                        </div>
                        <ChevronDown size={18} className="text-slate-400"/>
                    </button>
                </div>

                <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase mb-2 flex justify-between">
                      <span>Account Number (10 Digits)</span>
                      <span className={accountNumber.length === 10 ? "text-emerald-500" : "text-slate-400"}>{accountNumber.length}/10</span>
                    </label>
                    <input 
                        type="tel" placeholder="Enter Account Number"
                        maxLength={10}
                        className={`w-full bg-slate-50 border p-5 rounded-2xl font-black text-xl text-slate-800 outline-none transition-all ${
                          accountNumber.length > 0 && accountNumber.length < 10 
                          ? "border-red-300 focus:border-red-500" 
                          : "border-slate-100 focus:border-emerald-500"
                        }`}
                        value={accountNumber}
                        onChange={(e) => setAccountNumber(e.target.value.replace(/[^0-9]/g, ''))}
                    />
                    {isVerifying && <p className="text-[10px] text-blue-500 font-bold mt-2 animate-pulse flex items-center gap-1.5"><Loader2 size={12} className="animate-spin"/> Verifying Account Details...</p>}
                    {customerName && (
                        <div className="mt-2 bg-emerald-500/10 p-4 rounded-xl border border-emerald-500/20 flex items-center gap-3 animate-in fade-in">
                            <CheckCircle2 size={18} className="text-emerald-600" />
                            <div className="flex-1">
                                <span className="text-sm font-black text-emerald-800 line-clamp-1">{customerName}</span>
                                <p className="text-[10px] font-black text-emerald-600 uppercase">Account Verified</p>
                            </div>
                        </div>
                    )}
                </div>

                <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase mb-2 flex justify-between items-center">
                       <span>Transfer Amount</span>
                       <span className="text-emerald-500 bg-emerald-500/10 px-2 py-1 rounded font-black">MIN: ₦1,000 • MAX: ₦5,000,000</span>
                    </label>
                    <div className="relative mb-3">
                        <input 
                            type="number" 
                            placeholder="Enter Amount" 
                            className={`w-full bg-slate-50 border p-6 rounded-2xl font-black text-3xl text-slate-800 outline-none transition-all shadow-inner ${
                              nairaAmount && (parseFloat(nairaAmount) < 1000 || parseFloat(nairaAmount) > 5000000)
                              ? "border-red-300 focus:border-red-500" 
                              : "border-slate-100 focus:border-emerald-500"
                            }`}
                            value={nairaAmount}
                            onChange={(e) => setNairaAmount(e.target.value)}
                        />
                        <div className="absolute right-5 top-1/2 -translate-y-1/2 text-right">
                            <p className="text-sm font-black text-emerald-600">{cryptoToCharge} {selectedToken.symbol}</p>
                            {currentFee > 0 && <p className="text-[9px] font-black text-orange-500 tracking-wider">+₦{currentFee} FEE</p>}
                        </div>
                    </div>
                </div>

                <div className="animate-in fade-in">
                     <input 
                        type="tel" placeholder="Sender's Phone Number (For Receipt)"
                        maxLength={11}
                        className="w-full bg-slate-50 border border-slate-100 p-5 rounded-2xl font-bold text-slate-700 outline-none focus:border-emerald-500 transition-colors shadow-inner"
                        onChange={(e) => setCustomerPhone(e.target.value.replace(/[^0-9]/g, ''))}
                    />
                </div>

                {status && (
                    <div className={`p-5 rounded-2xl border flex items-center gap-4 animate-in fade-in slide-in-from-top-2 shadow-sm ${status.includes('Success') || status.includes('Secured') || status.includes('Initiating') ? 'bg-emerald-50 border-emerald-100 text-emerald-800' : status.includes('Verifying') || status.includes('Blockchain') || status.includes('confirmed') || status.includes('Mining') || status.includes('Processing') ? 'bg-blue-50 border-blue-100 text-blue-800' : 'bg-red-50 border-red-100 text-red-800'}`}>
                        {status.includes('Success') ? <CheckCircle2 size={24} className="text-emerald-600"/> : status.includes('Verifying') || status.includes('Blockchain') || status.includes('confirmed') || status.includes('Mining') || status.includes('Processing') ? <Loader2 size={24} className="animate-spin text-blue-600"/> : <AlertTriangle size={24} className="text-red-600"/>}
                        <p className="text-sm font-black tracking-tight">{status}</p>
                    </div>
                )}

                <button 
                    onClick={handlePayment}
                    disabled={isVerifying || !isFormValid || isProcessing}
                    className="w-full bg-slate-900 hover:bg-black text-white font-black py-6 rounded-3xl flex items-center justify-center gap-3.5 transition-all active:scale-95 disabled:opacity-30 shadow-xl shadow-slate-900/20 text-lg tracking-tight"
                >
                    {isProcessing ? (
                      <><Loader2 size={24} className="animate-spin text-emerald-400"/> SECURING PROTOCOL...</>
                    ) : (
                      <><ShieldCheck size={24} className="text-emerald-400" /> CONFIRM & PAY {cryptoToCharge} {selectedToken.symbol}</>
                    )}
                </button>
            </div>
          </div>
        ) : activeTab === 'pay' ? (
          <div className="bg-white border border-slate-100 rounded-[2.5rem] p-8 shadow-2xl shadow-emerald-900/10 animate-in fade-in zoom-in-95">
            <div className="flex overflow-x-auto gap-3 pb-2 mb-4 no-scrollbar">
                {SERVICES.map(s => (
                    <button 
                        key={s.id} 
                        onClick={() => handleResetService(s)}
                        className={`min-w-[80px] p-4 rounded-2xl border-2 transition-all flex flex-col items-center justify-center gap-2 shrink-0 ${
                            activeService.id === s.id ? 'border-emerald-500 bg-emerald-50/50 scale-105' : 'border-slate-50 bg-slate-50/50 hover:bg-slate-100'
                        }`}
                    >
                        <s.icon size={20} className={s.color} />
                        <span className="text-[8px] font-black uppercase tracking-widest">{s.name}</span>
                    </button>
                ))}
            </div>

            <div className="space-y-5">
                <div className="bg-slate-50 border border-slate-100 p-4 rounded-2xl flex justify-between items-center animate-in fade-in">
                  <div 
                    className="flex items-center gap-2 cursor-pointer hover:bg-slate-100 p-2 -ml-2 rounded-xl transition-colors" 
                    onClick={() => openSelectionModal('token', "Select Token", SUPPORTED_TOKENS, (symbol) => setSelectedToken(SUPPORTED_TOKENS.find(t => t.symbol === symbol)!))}
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
                        {activeService.id === "AIRTIME" ? "Select Network" : "Choose Provider"}
                    </label>

                    {activeService.id === "INTERNET" ? (
                        <button 
                            onClick={() => openSelectionModal('provider', "Select Provider", INTERNET_PROVIDERS, setInternetProvider)}
                            className="w-full bg-white border border-slate-200 p-4 rounded-2xl flex justify-between items-center hover:border-sky-400 transition-colors shadow-sm active:scale-[0.98]"
                        >
                            <div className="flex items-center gap-4">
                                <div className="w-12 h-12 shrink-0 rounded-full border border-slate-100 bg-sky-50 flex items-center justify-center shadow-inner overflow-hidden">
                                    <img src={currentInternet?.logo || '/wifi.png'} alt={currentInternet?.displayName} className="w-full h-full object-contain" onError={(e) => { e.currentTarget.style.display = 'none'; e.currentTarget.parentElement!.innerHTML = `<span class="text-[9px] font-black uppercase text-sky-500">${currentInternet?.displayName.slice(0,3) || 'NET'}</span>`; }} />
                                </div>
                                <div>
                                    <span className="text-sm font-black text-slate-900 tracking-tight">{currentInternet?.displayName || 'Select Internet Provider'}</span>
                                </div>
                            </div>
                            <ChevronDown size={18} className="text-slate-400"/>
                        </button>
                    ) : activeService.id === "AIRTIME" ? (
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
                            <div className="w-12 h-12 rounded-full bg-white shadow-sm border border-slate-100 flex items-center justify-center p-0.5 overflow-hidden">
                              <img src={`/${provider}.png`} alt={provider} className="w-full h-full object-contain" onError={(e) => { e.currentTarget.style.display = 'none'; e.currentTarget.parentElement!.innerHTML = `<span class="text-[9px] font-black uppercase text-slate-400">${provider.slice(0,3)}</span>`; }} />
                            </div>
                            <span className={`text-[9px] font-black uppercase tracking-wider ${telecomProvider === provider ? 'text-emerald-700' : 'text-slate-500'}`}>{provider}</span>
                          </button>
                        ))}
                      </div>
                    ) : activeService.id === "ELECTRICITY" ? (
                        <button 
                            onClick={() => openSelectionModal('provider', "Select Provider", ELECTRICITY_DISCOS, setElecProvider)}
                            className="w-full bg-white border border-slate-200 p-4 rounded-2xl flex justify-between items-center hover:border-orange-400 transition-colors shadow-sm active:scale-[0.98]"
                        >
                            <div className="flex items-center gap-4">
                                <div className="w-12 h-12 shrink-0 rounded-full border border-slate-100 bg-white p-0.5 flex items-center justify-center shadow-inner overflow-hidden">
                                    <img src={currentDisco?.logo} alt={currentDisco?.displayName} className="w-full h-full object-contain" />
                                </div>
                                <div><span className="text-sm font-black text-slate-900 tracking-tight">{currentDisco?.displayName}</span></div>
                            </div>
                            <ChevronDown size={18} className="text-slate-400"/>
                        </button>
                    ) : (
                      <button 
                        onClick={() => openSelectionModal('provider', "Select Provider", CABLE_PROVIDERS_LIST, setCableProvider)}
                        className="w-full bg-white border border-slate-200 p-4 rounded-2xl flex justify-between items-center hover:border-pink-400 transition-colors shadow-sm active:scale-[0.98]"
                      >
                        <div className="flex items-center gap-4">
                            <div className="w-12 h-12 shrink-0 rounded-full border border-slate-100 bg-white p-0.5 flex items-center justify-center shadow-inner overflow-hidden">
                                <img src={currentCable?.logo} alt={currentCable?.displayName} className="w-full h-full object-contain" />
                            </div>
                            <div><span className="text-sm font-black text-slate-900 tracking-tight">{currentCable?.displayName}</span></div>
                        </div>
                        <ChevronDown size={18} className="text-slate-400"/>
                      </button>
                    )}

                    {activeService.id === "ELECTRICITY" && (
                       <div className="flex gap-2 mt-4 p-1.5 bg-slate-100 rounded-2xl border border-slate-200 shadow-inner">
                          <button onClick={() => setMeterType("prepaid")} className={`flex-1 py-3 text-[11px] font-black uppercase rounded-xl transition-all ${meterType === "prepaid" ? "bg-white shadow-lg text-emerald-600" : "text-slate-500"}`}>Prepaid</button>
                          <button onClick={() => setMeterType("postpaid")} className={`flex-1 py-3 text-[11px] font-black uppercase rounded-xl transition-all ${meterType === "postpaid" ? "bg-white shadow-lg text-emerald-600" : "text-slate-500"}`}>Postpaid</button>
                       </div>
                    )}
                </div>

                <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase mb-2 flex justify-between">
                      <span>{activeService.id === "INTERNET" ? (internetProvider === 'smile-direct' ? "Enter Smile Email" : internetProvider === 'spectranet' ? "Spectranet ID / Phone" : "Phone Number (11 Digits)") : activeService.id === "AIRTIME" || (activeService.id === "CABLE" && cableProvider === "showmax") ? "Phone Number (11 Digits)" : "Account / Smartcard No"}</span>
                      {(activeService.id === "AIRTIME" || (activeService.id === "INTERNET" && internetProvider.includes('-data')) || (activeService.id === "CABLE" && cableProvider === "showmax")) && (
                        <span className={accountNumber.length === 11 ? "text-emerald-500" : "text-slate-400"}>{accountNumber.length}/11</span>
                      )}
                    </label>
                    <input 
                        type={activeService.id === "INTERNET" && internetProvider === 'smile-direct' ? "email" : "tel"} 
                        placeholder={activeService.id === "INTERNET" ? (internetProvider === 'smile-direct' ? "example@email.com" : internetProvider === 'spectranet' ? "Enter Spectranet ID" : "08000000000") : activeService.id === "AIRTIME" || (activeService.id === "CABLE" && cableProvider === "showmax") ? "08000000000" : "Enter Number"}
                        maxLength={activeService.id === "INTERNET" && internetProvider === 'smile-direct' ? undefined : activeService.id === "AIRTIME" || (activeService.id === "INTERNET" && internetProvider.includes('-data')) || (activeService.id === "CABLE" && cableProvider === "showmax") ? 11 : 20}
                        className={`w-full bg-slate-50 border p-5 rounded-2xl font-black text-xl text-slate-800 outline-none transition-all ${
                          ((activeService.id === "AIRTIME" || (activeService.id === "INTERNET" && internetProvider.includes('-data')) || (activeService.id === "CABLE" && cableProvider === "showmax")) && accountNumber.length > 0 && accountNumber.length < 11) 
                          ? "border-red-300 focus:border-red-500" 
                          : "border-slate-100 focus:border-emerald-500"
                        }`}
                        value={accountNumber}
                        onChange={(e) => {
                            if (activeService.id === "INTERNET" && internetProvider === 'smile-direct') setAccountNumber(e.target.value);
                            else setAccountNumber(e.target.value.replace(/[^0-9]/g, ''));
                        }}
                    />
                    {isVerifying && <p className="text-[10px] text-blue-500 font-bold mt-2 animate-pulse flex items-center gap-1.5"><Loader2 size={12} className="animate-spin"/> Verifying Account Details...</p>}

                    {customerName && (activeService.id === "ELECTRICITY" || (activeService.id === "INTERNET" && internetProvider === 'smile-direct')) && (
                        <div className="mt-2 bg-emerald-500/10 p-4 rounded-xl border border-emerald-500/20 flex items-center gap-3 animate-in fade-in">
                            <CheckCircle2 size={18} className="text-emerald-600" />
                            <div className="flex-1">
                                <span className="text-sm font-black text-emerald-800 line-clamp-1">{customerName}</span>
                                <p className="text-[10px] font-black text-emerald-600 uppercase">{activeService.id === "INTERNET" ? "Smile Email Verified" : "Meter Verified Successfully"}</p>
                            </div>
                        </div>
                    )}
                </div>

                {/* ⚡ INTERNET PACKAGES ⚡ */}
                {activeService.id === "INTERNET" && (
                  <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 shadow-sm animate-in fade-in slide-in-from-top-4">
                     
                     {/* IF TELECOM DATA, SHOW CATEGORY BUTTONS */}
                     {internetProvider.includes("-data") && (
                       <div className="flex gap-2 mb-4 border-b border-slate-200 pb-3 overflow-x-auto no-scrollbar shadow-inner bg-slate-100 p-1.5 rounded-2xl">
                          {DATA_CATEGORIES.map(cat => (
                            <button 
                               key={cat} 
                               onClick={() => { setActiveDataCategory(cat); setSelectedInternetPlan(null); setNairaAmount(""); }} 
                               className={`px-4 py-2.5 rounded-xl text-[11px] font-black uppercase transition-all whitespace-nowrap ${activeDataCategory === cat ? (cat === 'Broadband' ? 'bg-white shadow-lg text-orange-600' : cat === 'Social' ? 'bg-white shadow-lg text-blue-500' : 'bg-white shadow-lg text-purple-600') : 'text-slate-500 hover:text-slate-700'}`}
                            >
                              {cat === 'Broadband' ? <span className="flex items-center gap-1.5"><Briefcase size={14}/> {cat}</span> : cat === 'Social' ? <span className="flex items-center gap-1.5"><Users size={14}/> {cat}</span> : cat}
                            </button>
                          ))}
                        </div>
                     )}

                     {!internetProvider.includes("-data") && (
                        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">Select {internetProvider === 'smile-direct' ? 'Smile' : 'Spectranet'} Plan</p>
                     )}
                     
                     {selectedInternetPlan ? (
                        <div className="relative animate-in zoom-in-95 duration-200 mt-2">
                           <button onClick={() => { setSelectedInternetPlan(null); setNairaAmount(""); }} className="absolute -top-3 -right-3 bg-slate-200 text-slate-500 hover:text-slate-800 hover:bg-slate-300 rounded-full p-1 transition-all z-10 shadow-sm border border-white">
                             <XCircle size={16}/>
                           </button>
                           <div className="p-4 rounded-2xl border-2 border-sky-500 bg-sky-50 shadow-sm text-left">
                              <p className="font-black text-slate-900 text-lg tracking-tight">{selectedInternetPlan.name}</p>
                              <p className="text-[10px] text-sky-500 font-bold uppercase tracking-wider mb-2">Selected Package</p>
                              <div className="pt-2 border-t border-sky-200/50 flex justify-between items-end">
                                  <p className="font-black text-sky-600 text-xl leading-none">₦{parseFloat(selectedInternetPlan.variation_amount).toLocaleString()}</p>
                                  <p className="text-[10px] text-slate-500 font-bold">{(parseFloat(selectedInternetPlan.variation_amount) / exchangeRate).toFixed(4)} {selectedToken.symbol}</p>
                               </div>
                           </div>
                        </div>
                     ) : (
                        <div className="grid grid-cols-1 gap-2 max-h-[35vh] overflow-y-auto pr-1">
                          {internetVariations.length === 0 ? (
                            <p className="text-center text-xs font-bold text-slate-400 py-4"><Loader2 className="animate-spin inline-block mr-2" size={14}/> Fetching Packages...</p>
                          ) : filteredInternetDataPlans.length === 0 ? (
                            <p className="text-center text-xs font-bold text-slate-400 py-4">No packages available for this selection.</p>
                          ) : (
                            filteredInternetDataPlans.map((plan) => {
                              const cryptoPlanCost = (parseFloat(plan.variation_amount) / exchangeRate).toFixed(4);
                              return (
                                <button 
                                  key={plan.variation_code} 
                                  onClick={() => { setSelectedInternetPlan(plan); setNairaAmount(plan.variation_amount); }} 
                                  className="p-3 rounded-xl border border-slate-200 bg-white hover:border-sky-300 transition-all text-left flex justify-between items-center group"
                                >
                                  <div>
                                    <p className="font-black text-slate-800 text-xs">{plan.name}</p>
                                    <p className="text-[9px] text-slate-400 font-bold mt-0.5">{cryptoPlanCost} {selectedToken.symbol}</p>
                                  </div>
                                  <p className="font-black text-sky-600 text-sm group-hover:scale-110 transition-transform">₦{parseFloat(plan.variation_amount).toLocaleString()}</p>
                                </button>
                              );
                            })
                          )}
                        </div>
                     )}
                  </div>
                )}

                {activeService.id === "CABLE" && (cableProvider === "showmax" || customerName) && (
                  <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 shadow-sm animate-in fade-in slide-in-from-top-4">
                     {cableProvider !== "showmax" && (
                         <div className="flex items-start justify-between border-b border-slate-200 pb-3 mb-3">
                            <div>
                              <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">Verified Customer</p>
                              <p className="font-black text-slate-800 text-sm">{customerName}</p>
                              {['dstv', 'gotv'].includes(cableProvider) && (
                                <p className="text-xs font-bold text-emerald-600 mt-1 flex items-center gap-1"><Tv size={12}/> {cableCurrentBouquet}</p>
                              )}
                            </div>
                         </div>
                     )}

                     {['dstv', 'gotv'].includes(cableProvider) ? (
                       <>
                         <div className="flex gap-2 p-1.5 bg-slate-200/50 rounded-xl mb-4 shadow-inner">
                            <button 
                              onClick={() => { setCableSubscriptionType("renew"); setNairaAmount(cableRenewAmount ? cableRenewAmount.toString() : ""); setSelectedCablePlan(null); }} 
                              className={`flex-1 flex items-center justify-center gap-2 py-3 text-[11px] font-black uppercase tracking-wider rounded-xl transition-all ${cableSubscriptionType === "renew" ? "bg-white text-emerald-600 shadow-lg" : "text-slate-500 hover:text-slate-700"}`}
                            >
                              <RefreshCw size={14}/> Renew Plan
                            </button>
                            <button 
                              onClick={() => { setCableSubscriptionType("change"); setNairaAmount(""); }} 
                              className={`flex-1 flex items-center justify-center gap-2 py-3 text-[11px] font-black uppercase tracking-wider rounded-xl transition-all ${cableSubscriptionType === "change" ? "bg-white text-blue-600 shadow-lg" : "text-slate-500 hover:text-slate-700"}`}
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
                            selectedCablePlan ? (
                               <div className="relative animate-in zoom-in-95 duration-200 mt-2">
                                  <button onClick={() => { setSelectedCablePlan(null); setNairaAmount(""); }} className="absolute -top-3 -right-3 bg-slate-200 text-slate-500 hover:text-slate-800 hover:bg-slate-300 rounded-full p-1 transition-all z-10 shadow-sm border border-white">
                                    <XCircle size={16}/>
                                  </button>
                                  <div className="p-4 rounded-2xl border-2 border-blue-500 bg-blue-50 shadow-sm text-left">
                                     <p className="font-black text-slate-900 text-lg tracking-tight">{selectedCablePlan.name}</p>
                                     <p className="text-[10px] text-blue-500 font-bold uppercase tracking-wider mb-2">Selected Package</p>
                                     <div className="pt-2 border-t border-blue-200/50 flex justify-between items-end">
                                         <p className="font-black text-blue-600 text-xl leading-none">₦{parseFloat(selectedCablePlan.variation_amount).toLocaleString()}</p>
                                         <p className="text-[10px] text-slate-500 font-bold">{(parseFloat(selectedCablePlan.variation_amount) / exchangeRate).toFixed(4)} {selectedToken.symbol}</p>
                                     </div>
                                  </div>
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
                                         className="p-3 rounded-xl border border-slate-200 bg-white hover:border-slate-300 transition-all text-left flex justify-between items-center group"
                                       >
                                         <div>
                                           <p className="font-black text-slate-800 text-xs">{plan.name}</p>
                                           <p className="text-[9px] text-slate-400 font-bold mt-0.5">{cryptoPlanCost} {selectedToken.symbol}</p>
                                         </div>
                                         <p className="font-black text-blue-600 text-sm group-hover:scale-110 transition-transform">₦{parseFloat(plan.variation_amount).toLocaleString()}</p>
                                       </button>
                                     );
                                   })
                                 )}
                               </div>
                            )
                         )}
                       </>
                     ) : (
                       selectedCablePlan ? (
                          <div className="relative animate-in zoom-in-95 duration-200 mt-2">
                             <button onClick={() => { setSelectedCablePlan(null); setNairaAmount(""); }} className="absolute -top-3 -right-3 bg-slate-200 text-slate-500 hover:text-slate-800 hover:bg-slate-300 rounded-full p-1 transition-all z-10 shadow-sm border border-white">
                               <XCircle size={16}/>
                             </button>
                             <div className="p-4 rounded-2xl border-2 border-blue-500 bg-blue-50 shadow-sm text-left">
                                <p className="font-black text-slate-900 text-lg tracking-tight">{selectedCablePlan.name}</p>
                                <p className="text-[10px] text-blue-500 font-bold uppercase tracking-wider mb-2">Selected Package</p>
                                <div className="pt-2 border-t border-blue-200/50 flex justify-between items-end">
                                    <p className="font-black text-blue-600 text-xl leading-none">₦{parseFloat(selectedCablePlan.variation_amount).toLocaleString()}</p>
                                    <p className="text-[10px] text-slate-500 font-bold">{(parseFloat(selectedCablePlan.variation_amount) / exchangeRate).toFixed(4)} {selectedToken.symbol}</p>
                                 </div>
                             </div>
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
                                    className="p-3 rounded-xl border border-slate-200 bg-white hover:border-slate-300 transition-all text-left flex justify-between items-center group"
                                  >
                                    <div>
                                      <p className="font-black text-slate-800 text-xs">{plan.name}</p>
                                      <p className="text-[9px] text-slate-400 font-bold mt-0.5">{cryptoPlanCost} {selectedToken.symbol}</p>
                                    </div>
                                    <p className="font-black text-blue-600 text-sm group-hover:scale-110 transition-transform">₦{parseFloat(plan.variation_amount).toLocaleString()}</p>
                                  </button>
                                );
                              })
                            )}
                          </div>
                       )
                     )}
                  </div>
                )}

                <div className={activeService.id === "INTERNET" || activeService.id === "CABLE" ? "hidden" : ""}>
                    <label className="text-[10px] font-black text-slate-400 uppercase mb-2 flex justify-between items-center">
                       <span>Naira Value</span>
                       <span className="text-emerald-500 bg-emerald-500/10 px-2 py-1 rounded font-black">MIN: ₦{dynamicMinAmount.toLocaleString()} • MAX: {dynamicMaxAmount === Infinity ? 'NO LIMIT' : `₦${dynamicMaxAmount.toLocaleString()}`}</span>
                    </label>
                    <div className="relative mb-3">
                        <input 
                            type="number" 
                            placeholder="Enter Amount" 
                            className={`w-full bg-slate-50 border p-6 rounded-2xl font-black text-3xl text-slate-800 outline-none transition-all shadow-inner ${
                              nairaAmount && (parseFloat(nairaAmount) < dynamicMinAmount || parseFloat(nairaAmount) > dynamicMaxAmount)
                              ? "border-red-300 focus:border-red-500" 
                              : "border-slate-100 focus:border-emerald-500"
                            }`}
                            value={nairaAmount}
                            onChange={(e) => setNairaAmount(e.target.value)}
                        />
                        <div className="absolute right-5 top-1/2 -translate-y-1/2 text-right">
                            <p className="text-sm font-black text-emerald-600">{cryptoToCharge} {selectedToken.symbol}</p>
                            {currentFee > 0 && <p className="text-[9px] font-black text-orange-500 tracking-wider">+₦{currentFee} FEE</p>}
                        </div>
                    </div>

                    {nairaAmount && (parseFloat(nairaAmount) < dynamicMinAmount || parseFloat(nairaAmount) > dynamicMaxAmount) && (
                        <p className="text-[10px] font-bold text-red-500 flex items-center gap-1.5 mt-[-6px] mb-3 animate-in fade-in">
                            <AlertTriangle size={12} /> Please enter an amount between ₦{dynamicMinAmount.toLocaleString()} and ₦{dynamicMaxAmount.toLocaleString()}.
                        </p>
                    )}

                    {(activeService.id === "AIRTIME" || activeService.id === "ELECTRICITY") && (
                       <div className="flex gap-2.5 overflow-x-auto py-1.5 no-scrollbar bg-slate-100 p-2 rounded-2xl shadow-inner">
                          {(activeService.id === "AIRTIME" ? PRE_SELECT_AMOUNTS : ELEC_PRE_SELECT_AMOUNTS).map(amount => {
                            const cryptoAmtCost = (parseInt(amount) / exchangeRate).toFixed(4);
                            return (
                              <button key={amount} onClick={() => setNairaAmount(amount)} className={`flex-1 min-w-[70px] py-4 rounded-xl font-black transition-all whitespace-nowrap ${nairaAmount === amount ? 'bg-white shadow-lg text-emerald-700 scale-105' : 'bg-slate-50 hover:bg-slate-200 text-slate-700'}`}>
                                 ₦{parseInt(amount).toLocaleString()}
                                 <p className="text-[8px] mt-0.5 text-slate-400 font-bold">{cryptoAmtCost} {selectedToken.symbol}</p>
                              </button>
                            );
                          })}
                       </div>
                    )}
                </div>

                {(activeService.id === "ELECTRICITY" || activeService.id === "INTERNET") && (
                    <div className="animate-in fade-in">
                         <input 
                            type="tel" placeholder={activeService.id === "INTERNET" ? "Customer Phone Number" : "Phone for SMS Token (11 Digits)"}
                            maxLength={11}
                            className="w-full bg-slate-50 border border-slate-100 p-5 rounded-2xl font-bold text-slate-700 outline-none focus:border-emerald-500 transition-colors shadow-inner"
                            onChange={(e) => setCustomerPhone(e.target.value.replace(/[^0-9]/g, ''))}
                        />
                    </div>
                )}

                {status && (
                    <div className={`p-5 rounded-2xl border flex items-center gap-4 animate-in fade-in slide-in-from-top-2 shadow-sm ${status.includes('Success') || status.includes('Secured') || status.includes('Initiating') ? 'bg-emerald-50 border-emerald-100 text-emerald-800' : status.includes('Verifying') || status.includes('Blockchain') || status.includes('confirmed') || status.includes('Mining') || status.includes('Processing') ? 'bg-blue-50 border-blue-100 text-blue-800' : 'bg-red-50 border-red-100 text-red-800'}`}>
                        {status.includes('Success') ? <CheckCircle2 size={24} className="text-emerald-600"/> : status.includes('Verifying') || status.includes('Blockchain') || status.includes('confirmed') || status.includes('Mining') || status.includes('Processing') ? <Loader2 size={24} className="animate-spin text-blue-600"/> : <AlertTriangle size={24} className="text-red-600"/>}
                        <p className="text-sm font-black tracking-tight">{status}</p>
                    </div>
                )}

                <button 
                    onClick={handlePayment}
                    disabled={isVerifying || !isFormValid || isProcessing}
                    className="w-full bg-slate-900 hover:bg-black text-white font-black py-6 rounded-3xl flex items-center justify-center gap-3.5 transition-all active:scale-95 disabled:opacity-30 shadow-xl shadow-slate-900/20 text-lg tracking-tight"
                >
                    {isProcessing ? (
                      <><Loader2 size={24} className="animate-spin text-emerald-400"/> SECURING PROTOCOL...</>
                    ) : (
                      <><ShieldCheck size={24} className="text-emerald-400" /> CONFIRM & PAY {cryptoToCharge} {selectedToken.symbol}</>
                    )}
                </button>
            </div>
          </div>
        ) : (
          <div className="bg-white border border-slate-100 rounded-[2.5rem] p-6 shadow-2xl animate-in slide-in-from-bottom-4">
             {transactions.length === 0 ? (
                <div className="py-24 text-center">
                    <div className="bg-slate-100 w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-5 shadow-inner">
                        <Receipt size={40} className="text-slate-300" />
                    </div>
                    <p className="text-slate-400 text-xs font-black uppercase tracking-widest">No transaction activity found</p>
                </div>
             ) : (
                <div className="flex flex-col space-y-4">
                    {currentTransactions.map((tx, idx) => (
                        <div 
                          key={idx} 
                          onClick={() => setSelectedReceipt(tx)} 
                          className="p-5 bg-slate-50 rounded-2xl border border-slate-100 flex justify-between items-center cursor-pointer hover:bg-emerald-50 hover:border-emerald-100 transition-all group shadow-sm active:scale-98"
                        >
                            <div>
                                <p className="text-sm font-black text-slate-900 uppercase group-hover:text-emerald-700 transition-colors tracking-tight">{tx.network} {tx.service}</p>
                                <p className="text-[10px] font-medium text-slate-500 mt-0.5">{tx.date} • <span className={tx.status === 'SUCCESS' ? 'text-emerald-600 font-bold' : tx.status === 'REFUNDED' ? 'text-blue-500 font-bold' : 'text-red-500 font-bold'}>{tx.status}</span></p>
                            </div>
                            <div className="text-right flex flex-col items-end gap-1.5">
                                <p className="text-sm font-black text-emerald-600">₦{tx.amountNaira.toLocaleString()}</p>
                                <span className="text-[9px] font-black uppercase tracking-widest bg-slate-200 text-slate-500 px-3 py-1 rounded-full group-hover:bg-emerald-200 group-hover:text-emerald-800 transition-all flex items-center gap-1">
                                  View Receipt <ExternalLink size={10}/>
                                </span>
                            </div>
                        </div>
                    ))}

                    {totalPages > 1 && (
                      <div className="flex justify-between items-center mt-6 pt-5 border-t border-slate-100">
                        <button 
                          onClick={() => setCurrentPage(p => Math.max(1, p - 1))} 
                          disabled={currentPage === 1} 
                          className="flex items-center gap-1.5 px-4 py-2 text-[10px] font-black uppercase tracking-widest bg-slate-100 rounded-lg text-slate-500 hover:bg-slate-200 hover:text-emerald-600 disabled:opacity-30 transition-all"
                        >
                          <ChevronLeft size={16} /> Prev
                        </button>
                        <span className="text-[10px] font-black tracking-widest text-slate-400 bg-slate-100 px-3 py-1.5 rounded-full">PAGE {currentPage} OF {totalPages}</span>
                        <button 
                          onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} 
                          disabled={currentPage === totalPages} 
                          className="flex items-center gap-1.5 px-4 py-2 text-[10px] font-black uppercase tracking-widest bg-slate-100 rounded-lg text-slate-500 hover:bg-slate-200 hover:text-emerald-600 disabled:opacity-30 transition-all"
                        >
                          Next <ChevronRight size={16} />
                        </button>
                      </div>
                    )}
                </div>
             )}
          </div>
        )}

        <footer className="mt-12 w-full border-t border-slate-200 pt-8 pb-4 flex flex-col items-center gap-4 animate-in fade-in">
          <div className="flex items-center gap-2.5 bg-white px-4 py-1.5 rounded-full shadow-sm border border-slate-100">
             <ShieldCheck size={16} className="text-emerald-600" />
             <span className="text-[11px] font-bold text-slate-500 uppercase tracking-widest">Decentralized & Secured by Celo Network</span>
          </div>
          <div className="flex gap-6">
            <a href="#" onClick={(e) => { e.preventDefault(); setIsTermsOpen(true); }} className="text-[10px] font-black text-slate-400 hover:text-emerald-600 uppercase tracking-tight">Terms of Service</a>
            <a href="#" onClick={(e) => { e.preventDefault(); setIsPrivacyOpen(true); }} className="text-[10px] font-black text-slate-400 hover:text-emerald-600 uppercase tracking-tight">Privacy Policy</a>
          </div>
          <p className="text-[9px] font-medium text-slate-300 uppercase tracking-[0.2em] mt-2">© 2026 MASONODE ORGANISATION • THE ABAPAY PROTOCOL v3.0</p>
        </footer>
      </div>
    </main>
  );
}
