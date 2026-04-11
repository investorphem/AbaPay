"use client";

import { useState, useEffect, useMemo } from "react";
import { createWalletClient, createPublicClient, custom, http, parseUnits, formatUnits } from "viem";
import { celo, celoSepolia } from "viem/chains";
import { 
  ShieldCheck, Zap, AlertTriangle, CheckCircle2, ChevronDown, 
  Loader2, Coins, Briefcase, ListPlus, Users, Landmark, XCircle, RefreshCw, Tv, GraduationCap
} from "lucide-react";
import { supabase } from "@/utils/supabase";
import { ELECTRICITY_DISCOS } from "./discos"; 

import { TermsModal, PrivacyModal, ReceiptModal, SelectionModal } from "@/components/Modals";
import { 
  ABAPAY_ABI, ERC20_ABI, SERVICES, CABLE_PROVIDERS_LIST, TELECOM_PROVIDERS, 
  INTERNET_PROVIDERS, SUPPORTED_TOKENS, SUPPORTED_COUNTRIES, PRE_SELECT_AMOUNTS, 
  ELEC_PRE_SELECT_AMOUNTS, DATA_CATEGORIES, ITEMS_PER_PAGE, extractVtpassArray,
  ELECTRICITY_PROVIDER_IDS, EDUCATION_PROVIDERS
} from "@/constants";
import { HistoryTab } from "@/components/HistoryTab";

export default function Home() {
  const [isInitiallyLoading, setIsInitiallyLoading] = useState(true);

  const [address, setAddress] = useState<string | null>(null);
  const [client, setClient] = useState<any>(null);
  const [nairaAmount, setNairaAmount] = useState(""); 
  const [accountNumber, setAccountNumber] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [status, setStatus] = useState("");

  const [activeTab, setActiveTab] = useState<"pay" | "bank" | "education" | "history">("pay");
  const [isProcessing, setIsProcessing] = useState(false); 
  const [customerName, setCustomerName] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);

  const [cableCurrentBouquet, setCableCurrentBouquet] = useState<string | null>(null);
  const [cableRenewAmount, setCableRenewAmount] = useState<number | null>(null);
  const [cableSubscriptionType, setCableSubscriptionType] = useState<"renew" | "change">("renew");
  const [cableVariations, setCableVariations] = useState<any[]>([]);
  const [selectedCablePlan, setSelectedCablePlan] = useState<any>(null);

  const [internetVariations, setInternetVariations] = useState<any[]>([]);
  const [selectedInternetPlan, setSelectedInternetPlan] = useState<any>(null);
  const [internetAccountId, setInternetAccountId] = useState<string | null>(null);

  const [bankVariations, setBankVariations] = useState<any[]>([]);
  const [selectedBank, setSelectedBank] = useState<any>(null);
  const [isFetchingBanks, setIsFetchingBanks] = useState(false);

  const [educationProvider, setEducationProvider] = useState("waec");
  const [educationVariations, setEducationVariations] = useState<any[]>([]);
  const [selectedEducationPlan, setSelectedEducationPlan] = useState<any>(null);

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

  const indexOfLastItem = currentPage * ITEMS_PER_PAGE;
  const indexOfFirstItem = indexOfLastItem - ITEMS_PER_PAGE;
  const currentTransactions = transactions.slice(indexOfFirstItem, indexOfLastItem);
  const totalPages = Math.ceil(transactions.length / ITEMS_PER_PAGE);

  const currentDisco = useMemo(() => ELECTRICITY_DISCOS.find(d => d.serviceID === elecProvider), [elecProvider]);
  const currentCable = useMemo(() => CABLE_PROVIDERS_LIST.find(c => c.serviceID === cableProvider), [cableProvider]);
  const currentInternet = useMemo(() => INTERNET_PROVIDERS.find(c => c.serviceID === internetProvider), [internetProvider]);

  const dynamicMinAmount = useMemo(() => {
    if (activeTab === "bank") return 1000;
    if (activeTab === "education") return 500;
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

  const { cryptoToCharge, currentFee } = useMemo(() => {
    const bill = parseFloat(nairaAmount) || 0;
    const fee = (activeTab === "bank" || activeService.id === "ELECTRICITY" || activeService.id === "CABLE" || activeTab === "education") ? 100 : 0;
    const crypto = (bill + fee) / exchangeRate;
    return { cryptoToCharge: crypto.toFixed(4), currentFee: fee };
  }, [nairaAmount, exchangeRate, activeService, activeTab]);

  // ⚡ STRICT FILTERING FIX FOR INTERNET/SPECTRANET ⚡
  const filteredInternetDataPlans = useMemo(() => {
    if (!internetVariations || internetVariations.length === 0) return [];
    
    // Strict Lock: Only allow variations that actually belong to the selected provider
    let strictVariations = internetVariations;
    if (internetProvider.includes('mtn')) strictVariations = internetVariations.filter(p => p.variation_code.toLowerCase().includes('mtn'));
    else if (internetProvider.includes('airtel')) strictVariations = internetVariations.filter(p => p.variation_code.toLowerCase().includes('airtel'));
    else if (internetProvider.includes('glo')) strictVariations = internetVariations.filter(p => p.variation_code.toLowerCase().includes('glo'));
    else if (internetProvider.includes('9mobile')) strictVariations = internetVariations.filter(p => p.variation_code.toLowerCase().includes('9mobile'));
    else if (internetProvider === 'spectranet') strictVariations = internetVariations.filter(p => p.variation_code.toLowerCase().includes('spectranet'));
    else if (internetProvider === 'smile-direct') strictVariations = internetVariations.filter(p => p.variation_code.toLowerCase().includes('smile'));

    // Spectranet & Smile don't use standard categories (Daily/Monthly)
    if (internetProvider === 'spectranet' || internetProvider === 'smile-direct') return strictVariations;

    // Apply categories for standard networks
    return strictVariations.filter(plan => {
      const name = (plan.name || "").toLowerCase();
      let category = "Monthly"; 

      if (name.includes('broadband') || name.includes('router') || name.includes('5g') || name.includes('hynet') || name.includes('unlimited')) category = "Broadband";
      else if (name.includes('social') || name.includes('whatsapp') || name.includes('ig') || name.includes('instagram') || name.includes('tiktok') || name.includes('youtube') || name.includes('facebook') || name.includes('opera') || name.includes('xot')) category = "Social";
      else if (name.includes('60 day') || name.includes('90 day') || name.includes('120 day') || name.includes('year') || name.includes('365') || name.includes('mega') || name.includes('3 month') || name.includes('2 month') || name.includes('quarterly') || name.includes('annual')) category = "Mega";
      else if (name.includes('month') || name.includes('30 day')) category = "Monthly";
      else if (name.includes('week') || name.includes('7 day') || name.includes('14 day') || name.includes('weekend')) category = "Weekly";
      else if (name.includes('1 day') || name.includes('2 day') || name.includes('3 day') || name.includes('daily') || name.includes('24 hrs') || name.includes('24hrs') || name.includes('night') || name.includes('hourly')) category = "Daily";

      return category === activeDataCategory;
    }).sort((a, b) => parseFloat(a.variation_amount || "0") - parseFloat(b.variation_amount || "0"));
  }, [internetVariations, activeDataCategory, internetProvider]);

  const isFormValid = useMemo(() => {
    const amount = parseFloat(nairaAmount);
    if (!nairaAmount || isNaN(amount) || amount < dynamicMinAmount || amount > dynamicMaxAmount) return false;

    if (activeTab === "bank") return accountNumber.length === 10 && customerName !== null && selectedBank !== null && customerPhone.length >= 10;

    if (activeTab === "education") {
      if (educationProvider === "jamb") return accountNumber.length >= 10 && customerName !== null && selectedEducationPlan !== null && customerPhone.length >= 10;
      return selectedEducationPlan !== null && customerPhone.length >= 10;
    }

    if (activeTab === "pay") {
      if (activeService.id === "AIRTIME") return accountNumber.length === 11 && accountNumber.startsWith("0");
      if (activeService.id === "INTERNET") {
        if (internetProvider === 'smile-direct') return internetAccountId !== null && selectedInternetPlan !== null && customerPhone.length >= 10;
        else if (internetProvider === 'spectranet') return accountNumber.length >= 5 && selectedInternetPlan !== null && customerPhone.length >= 10;
        else return accountNumber.length === 11 && accountNumber.startsWith("0") && selectedInternetPlan !== null;
      }
      if (activeService.id === "ELECTRICITY") return accountNumber.length >= 10 && customerName !== null && customerPhone.length >= 10;
      if (activeService.id === "CABLE") {
        if (cableProvider === "showmax") return accountNumber.length >= 11 && selectedCablePlan !== null;
        if (accountNumber.length < 10 || customerName === null) return false;
        if (['dstv', 'gotv'].includes(cableProvider) && cableSubscriptionType === 'change' && !selectedCablePlan) return false;
        if (!['dstv', 'gotv'].includes(cableProvider) && !selectedCablePlan) return false;
        return true;
      }
    }
    return false;
  }, [accountNumber, nairaAmount, activeService, customerName, dynamicMinAmount, dynamicMaxAmount, cableSubscriptionType, selectedCablePlan, selectedBank, selectedInternetPlan, internetAccountId, customerPhone, internetProvider, activeTab, cableProvider, selectedEducationPlan, educationProvider]);

  const showToast = (title: string, message: string, type: 'success' | 'error' = 'success') => {
    setToast({ title, message, type });
    setTimeout(() => setToast(null), 5000);
  };

  const handleProviderChange = (newProvider: string, type: 'internet' | 'telecom' | 'cable' | 'elec' | 'bank' | 'education') => {
    setNairaAmount(""); setAccountNumber(""); setCustomerName(null); setCustomerPhone("");
    if (type === 'internet') { 
        setInternetVariations([]); 
        setInternetProvider(newProvider); 
        setSelectedInternetPlan(null); 
        setInternetAccountId(null); 
    } 
    else if (type === 'telecom') { setTelecomProvider(newProvider); } 
    else if (type === 'cable') { setCableProvider(newProvider); setSelectedCablePlan(null); setCableCurrentBouquet(null); setCableRenewAmount(null); setCableSubscriptionType("renew"); } 
    else if (type === 'elec') { setElecProvider(newProvider); } 
    else if (type === 'bank') { setSelectedBank(newProvider); }
    else if (type === 'education') { setEducationProvider(newProvider); setSelectedEducationPlan(null); }
  };

  const handleResetService = (s: any) => {
    setActiveService(s); setAccountNumber(""); setCustomerName(null); setNairaAmount(""); setCustomerPhone("");
    setCableCurrentBouquet(null); setCableRenewAmount(null); setSelectedCablePlan(null);
    setCableSubscriptionType("renew"); setSelectedBank(null); setSelectedInternetPlan(null); setInternetAccountId(null);
    setSelectedEducationPlan(null); setInternetVariations([]); 
  };

  const openSelectionModal = (type: 'standard' | 'token' | 'provider' | 'country' | 'bank', title: string, options: any[], callback: (value: string) => void) => {
    setModalType(type as any); setModalTitle(title); setModalOptions(options); setModalCallback(() => callback); setIsSelectionModalOpen(true);
  };

  const handleCountryChange = (countryCode: string) => {
    const country = SUPPORTED_COUNTRIES.find(c => c.code === countryCode);
    if (country && !country.disabled) { setActiveCountry(country); handleResetService(SERVICES[0]); }
  };

  const handleShareReceipt = async () => {
    const receiptText = `🧾 AbaPay Receipt\n\nDate: ${selectedReceipt?.date}\nStatus: ${selectedReceipt?.status}\nProduct: ${selectedReceipt?.network} ${selectedReceipt?.service}\nRecipient: ${selectedReceipt?.account}\nAmount Paid: ₦${selectedReceipt?.amountNaira}\nCrypto Used: ${selectedReceipt?.amountCrypto} ${selectedReceipt?.tokenUsed}\nTx Hash: ${selectedReceipt?.txHash}\n\nSecured by Celo Network`;
    if (navigator.share) { try { await navigator.share({ title: 'Receipt', text: receiptText }); } catch (err) {} } 
    else { try { await navigator.clipboard.writeText(receiptText); showToast("Copied!", "Receipt details copied to clipboard.", "success"); } catch (err) {} }
  };

  const fetchBanksManual = async () => {
    setIsFetchingBanks(true);
    try {
      const res = await fetch(`/api/variations?serviceID=bank-deposit`);
      const data = await res.json();
      
      if (data.code === '011' || !data.content || !data.content.variations) {
        setBankVariations([
            { variation_code: 'access', name: 'ACCESS BANK PLC' },
            { variation_code: 'firstbank', name: 'FIRST BANK OF NIGERIA PLC' },
            { variation_code: 'gtb', name: 'GTBANK PLC' },
            { variation_code: 'opay', name: 'OPAY' },
            { variation_code: 'moniepoint', name: 'MONIEPOINT MICROFINANCE BANK' },
            { variation_code: 'uba', name: 'UBA - UNITED BANK FOR AFRICA PLC' },
            { variation_code: 'zenith', name: 'ZENITH BANK PLC' }
        ]);
        return;
      }

      let banksArr = extractVtpassArray(data);
      if (banksArr && Array.isArray(banksArr) && banksArr.length > 0) {
        setBankVariations(banksArr.sort((a: any, b: any) => (a.name || "").localeCompare(b.name || "")));
      } else { 
        throw new Error("Empty");
      }
    } catch (e) {
      setBankVariations([
        { variation_code: 'access', name: 'ACCESS BANK PLC' },
        { variation_code: 'gtb', name: 'GTBANK PLC' },
        { variation_code: 'opay', name: 'OPAY' },
        { variation_code: 'moniepoint', name: 'MONIEPOINT MICROFINANCE BANK' },
        { variation_code: 'zenith', name: 'ZENITH BANK PLC' }
      ]);
    } finally { 
      setIsFetchingBanks(false); 
    }
  };

  const verifyMerchant = async () => {
    setIsVerifying(true); setCustomerName(null); setCableCurrentBouquet(null); setCableRenewAmount(null); setInternetAccountId(null);
    try {
        let serviceID = ""; let reqType = undefined;

        if (activeTab === "bank") { 
          serviceID = "bank-deposit"; reqType = selectedBank?.variation_code; 
        } else if (activeTab === "education" && educationProvider === "jamb") {
          serviceID = "jamb"; reqType = selectedEducationPlan?.variation_code;
        } else { 
          serviceID = activeService.id === "ELECTRICITY" ? elecProvider : activeService.id === "INTERNET" ? internetProvider : cableProvider; 
          reqType = activeService.id === "ELECTRICITY" ? meterType : undefined; 
        }

        const res = await fetch(`/api/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ billersCode: accountNumber, serviceID: serviceID, type: reqType }) });
        const data = await res.json();

        if (data.code === '000') {
          setCustomerName(data.content.Customer_Name || data.content.account_name || data.content.name);
          if (activeTab === "pay" && activeService.id === "INTERNET" && internetProvider === "smile-direct") setInternetAccountId(data.content.AccountId || data.content.account_id);
          if (activeTab === "pay" && activeService.id === "CABLE") {
            setCableCurrentBouquet(data.content.Current_Bouquet || "Unknown Package");
            if (data.content.Renewal_Amount && ['dstv', 'gotv'].includes(cableProvider)) {
              setCableRenewAmount(data.content.Renewal_Amount);
              if (cableSubscriptionType === "renew") setNairaAmount(data.content.Renewal_Amount.toString());
            }
          }
        } else { setStatus("Account could not be verified."); }
    } catch (e) {}
    setIsVerifying(false);
  };

  const handlePayment = async () => {
    if (!address || !client) return setStatus("Connect Wallet First");
    if (parseFloat(cryptoToCharge) > parseFloat(walletBalance)) return setStatus(`Insufficient ${selectedToken.symbol} Balance.`);

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

      let vtpassServiceID = ""; let displayNetwork = ""; let finalVariationCode = 'prepaid'; let payloadBillersCode = accountNumber; let uiCategory = "";

      if (activeTab === "bank") {
        vtpassServiceID = "bank-deposit"; displayNetwork = selectedBank.name; finalVariationCode = selectedBank.variation_code; uiCategory = "BANK";
      } else if (activeTab === "education") {
        vtpassServiceID = educationProvider; 
        displayNetwork = educationProvider === "waec" ? "WAEC Result Checker" : educationProvider === "waec-registration" ? "WAEC Registration" : "JAMB PIN Vending"; 
        finalVariationCode = selectedEducationPlan?.variation_code || 'none'; 
        uiCategory = "EDUCATION"; 
        payloadBillersCode = educationProvider === "jamb" ? accountNumber : customerPhone;
      } else {
        uiCategory = activeService.id;
        if (activeService.id === "ELECTRICITY") { vtpassServiceID = elecProvider; displayNetwork = elecProvider; finalVariationCode = meterType; } 
        else if (activeService.id === "CABLE") {
          vtpassServiceID = cableProvider; displayNetwork = cableProvider;
          if (['dstv', 'gotv'].includes(cableProvider)) finalVariationCode = cableSubscriptionType === 'change' ? selectedCablePlan?.variation_code : 'none'; 
          else finalVariationCode = selectedCablePlan?.variation_code || 'none';
        } else if (activeService.id === "INTERNET") {
          vtpassServiceID = internetProvider; 
          if (internetProvider === 'smile-direct') { displayNetwork = "Smile Network"; payloadBillersCode = internetAccountId || accountNumber; }
          else if (internetProvider === 'spectranet') displayNetwork = "Spectranet";
          else displayNetwork = internetProvider.replace('-data', ''); 
          finalVariationCode = selectedInternetPlan?.variation_code || 'none'; 
        } else { vtpassServiceID = telecomProvider; displayNetwork = telecomProvider; }
      }

      const hash = await client.writeContract({ address: ABAPAY_CONTRACT, abi: ABAPAY_ABI, functionName: 'payBill', args: [tokenAddress, vtpassServiceID, payloadBillersCode, valueInWei], account: address });
      setStatus(`${selectedToken.symbol} Secured. Processing...`);

      const backendPayload = {
        serviceID: vtpassServiceID, serviceCategory: uiCategory, network: displayNetwork.toUpperCase(), billersCode: payloadBillersCode, amount: cryptoToCharge, nairaAmount: nairaAmount, token: selectedToken.symbol, txHash: hash, variation_code: finalVariationCode, phone: customerPhone || accountNumber, wallet_address: address, subscription_type: activeTab === "pay" && activeService.id === "CABLE" && ['dstv', 'gotv'].includes(cableProvider) ? cableSubscriptionType : undefined
      };

      const newTx: any = { id: hash.slice(0,8), date: new Date().toLocaleString(), status: "PENDING", amountNaira: nairaAmount, amountCrypto: cryptoToCharge, tokenUsed: selectedToken.symbol, service: uiCategory === "BANK" ? "Bank Transfer" : uiCategory === "EDUCATION" ? "Education PIN" : activeService.name, network: displayNetwork.toUpperCase(), txHash: hash, account: uiCategory === "EDUCATION" ? customerPhone : accountNumber };

      setAccountNumber(""); setNairaAmount(""); setCustomerPhone(""); setCustomerName(null); setSelectedCablePlan(null); setCableCurrentBouquet(null); setSelectedBank(null); setSelectedInternetPlan(null); setInternetAccountId(null); setSelectedEducationPlan(null);

      const res = await fetch('/api/pay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(backendPayload) });
      const result = await res.json();

      if (result.success) {
        setStatus("Success! Token/Ref Dispatched."); newTx.status = "SUCCESS"; newTx.purchased_code = result.purchased_code; newTx.units = result.units; newTx.request_id = result.data?.requestId; showToast("Transaction Successful", "Your transaction has been successfully processed.", "success");
      } else {
        setStatus(`Error: ${result.message || 'Transaction Failed'}`); newTx.status = "FAILED_VENDING";
      }

      const updatedHistory = [newTx, ...transactions];
      setTransactions(updatedHistory); localStorage.setItem("abapay_history", JSON.stringify(updatedHistory)); setCurrentPage(1);

      const balanceWei = await publicClient.readContract({ address: tokenAddress as `0x${string}`, abi: ERC20_ABI, functionName: 'balanceOf', args: [address] });
      setWalletBalance(parseFloat(formatUnits(balanceWei as bigint, selectedToken.decimals)).toFixed(4));
    } catch (e) { setStatus("Transaction Cancelled."); } finally { setIsProcessing(false); }
  };

  useEffect(() => {
    const fallbackTimer = setTimeout(() => setIsInitiallyLoading(false), 2000);
    return () => clearTimeout(fallbackTimer);
  }, []);

  useEffect(() => {
    if (status && !isProcessing) { const timer = setTimeout(() => setStatus(""), 5000); return () => clearTimeout(timer); }
  }, [status, isProcessing]);

  useEffect(() => {
    async function initSystem() {
      try { const savedHistory = localStorage.getItem("abapay_history"); if (savedHistory) setTransactions(JSON.parse(savedHistory)); } catch(e) {}
      try { const { data: settingsData } = await supabase.from('platform_settings').select('exchange_rate').eq('id', 1).single(); if (settingsData && settingsData.exchange_rate) setExchangeRate(Number(settingsData.exchange_rate)); } catch (consoleError) {}
      try {
        if (typeof window !== "undefined" && (window as any).ethereum) {
          const eth = (window as any).ethereum;
          const walletClient = createWalletClient({ chain: activeChain, transport: custom(eth) });
          walletClient.requestAddresses().then(([acc]) => { setAddress(acc); setClient(walletClient); }).catch((e) => console.log("Connection deferred"));
        }
      } catch (e) {}
    }
    initSystem();
  }, [activeChain]);

  useEffect(() => {
    if (!address) return;
    async function fetchCloudHistory() {
      try {
        const sixMonthsAgo = new Date(); sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
        const { data } = await supabase.from('transactions').select('*').eq('wallet_address', address).gte('created_at', sixMonthsAgo.toISOString()).order('created_at', { ascending: false });
        if (data && data.length > 0) {
          const cloudHistory = data.map((tx: any) => ({ id: tx.tx_hash.slice(0, 8), date: new Date(tx.created_at).toLocaleString(), status: tx.status, amountNaira: tx.amount_naira.toString(), amountCrypto: tx.amount_usdt.toString(), tokenUsed: "USD₮", service: tx.service_category, network: tx.network, txHash: tx.tx_hash, account: tx.account_number, refund_hash: tx.refund_hash, purchased_code: tx.purchased_code, request_id: tx.request_id, units: tx.units }));
          setTransactions(cloudHistory); localStorage.setItem("abapay_history", JSON.stringify(cloudHistory));
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

  useEffect(() => { fetchBanksManual(); }, []);

  useEffect(() => {
    if (activeTab === "education") {
      const fetchEducation = async () => {
        setEducationVariations([]);
        try {
          const res = await fetch(`/api/variations?serviceID=${educationProvider}`);
          const data = await res.json();
          setEducationVariations(extractVtpassArray(data));
        } catch (e) {}
      };
      fetchEducation();
    }
  }, [activeTab, educationProvider]);

  useEffect(() => {
    if (activeTab !== "pay") return;
    if (activeService.id === "CABLE") {
      const fetchVariations = async () => { try { const res = await fetch(`/api/variations?serviceID=${cableProvider}`); const data = await res.json(); setCableVariations(extractVtpassArray(data)); } catch (e) {} }; fetchVariations();
    } else if (activeService.id === "INTERNET") {
      const fetchInternetVariations = async () => { setInternetVariations([]); try { const res = await fetch(`/api/variations?serviceID=${internetProvider}`); const data = await res.json(); setInternetVariations(extractVtpassArray(data)); } catch (e) {} }; fetchInternetVariations();
    }
  }, [activeTab, activeService.id, cableProvider, internetProvider]);

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
  }, [accountNumber, activeService.id, activeTab, internetProvider]);

  useEffect(() => {
    if (activeTab === "bank") { if (accountNumber.length === 10 && selectedBank) verifyMerchant(); else setCustomerName(null); } 
    else if (activeTab === "education" && educationProvider === "jamb") {
       if (accountNumber.length >= 10 && selectedEducationPlan) verifyMerchant(); else setCustomerName(null);
    }
    else if (activeTab === "pay") {
       if (activeService.id === "ELECTRICITY" && accountNumber.length >= 10) verifyMerchant();
       else if (activeService.id === "CABLE" && cableProvider !== "showmax" && accountNumber.length >= 10) verifyMerchant();
       else if (activeService.id === "INTERNET" && internetProvider === "smile-direct" && accountNumber.includes('@') && accountNumber.includes('.')) { const timeoutId = setTimeout(() => verifyMerchant(), 1000); return () => clearTimeout(timeoutId); } 
       else { setCustomerName(null); }
    }
  }, [accountNumber, elecProvider, cableProvider, activeService.id, meterType, selectedBank, internetProvider, activeTab, educationProvider, selectedEducationPlan]);

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
  }, [activeTab, transactions]);

  const getCurrentModalValue = () => {
    if (modalType === 'country') return activeCountry.code;
    if (modalType === 'bank') return selectedBank?.variation_code;
    if (modalType === 'token') return selectedToken.symbol;
    if (modalType === 'provider') {
      if (activeTab === 'education') return educationProvider;
      if (activeService.id === 'ELECTRICITY') return elecProvider;
      if (activeService.id === 'INTERNET') return internetProvider;
      if (activeService.id === 'CABLE') return cableProvider;
    }
    if (modalType === 'standard') return telecomProvider;
    return null;
  };

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

      <TermsModal isOpen={isTermsOpen} onClose={() => setIsTermsOpen(false)} />
      <PrivacyModal isOpen={isPrivacyOpen} onClose={() => setIsPrivacyOpen(false)} />
      <ReceiptModal receipt={selectedReceipt} isMainnet={isMainnet} onClose={() => setSelectedReceipt(null)} onShare={handleShareReceipt} />
      <SelectionModal 
        isOpen={isSelectionModalOpen} 
        onClose={() => setIsSelectionModalOpen(false)} 
        title={modalTitle} 
        type={modalType} 
        options={modalOptions} 
        onSelect={modalCallback} 
        isFetchingBanks={isFetchingBanks} 
        selectedValue={getCurrentModalValue()} 
        onRetryBanks={fetchBanksManual} 
      />

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

        <div className="flex gap-2 bg-slate-200/50 p-1.5 rounded-2xl mb-6 shadow-inner overflow-x-auto no-scrollbar">
            <button onClick={() => { setActiveTab("pay"); handleResetService(SERVICES[0]); }} className={`flex-1 min-w-[75px] py-3 rounded-xl text-[10px] sm:text-xs font-black transition-all ${activeTab === 'pay' ? 'bg-white text-emerald-600 shadow-xl' : 'text-slate-500 hover:text-slate-700'}`}>BILLS</button>
            <button onClick={() => { setActiveTab("bank"); handleResetService(SERVICES[0]); }} className={`flex-1 min-w-[75px] py-3 rounded-xl text-[10px] sm:text-xs font-black transition-all ${activeTab === 'bank' ? 'bg-white text-emerald-600 shadow-xl' : 'text-slate-500 hover:text-slate-700'}`}>TRANSFER</button>
            <button onClick={() => { setActiveTab("education"); handleResetService(SERVICES[0]); }} className={`flex-1 min-w-[75px] py-3 rounded-xl text-[10px] sm:text-xs font-black transition-all ${activeTab === 'education' ? 'bg-white text-emerald-600 shadow-xl' : 'text-slate-500 hover:text-slate-700'}`}>EDUCATION</button>
            <button onClick={() => { setActiveTab("history"); handleResetService(SERVICES[0]); }} className={`flex-1 min-w-[75px] py-3 rounded-xl text-[10px] sm:text-xs font-black transition-all ${activeTab === 'history' ? 'bg-white text-emerald-600 shadow-xl' : 'text-slate-500 hover:text-slate-700'}`}>HISTORY</button>
        </div>

        {/* ======================================= */}
        {/* EDUCATION BLOCK */}
        {/* ======================================= */}
        {activeTab === 'education' && (
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
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Balance</p>
                    <div className="flex items-center justify-end gap-1">
                      {isFetchingBalance ? <Loader2 size={12} className="animate-spin text-emerald-500"/> : <Coins size={12} className="text-emerald-500"/>}
                      <p className="font-mono font-black text-sm text-slate-800">{walletBalance} <span className="text-[10px]">{selectedToken.symbol}</span></p>
                    </div>
                  </div>
                </div>

                <div className="animate-in slide-in-from-left-2 mb-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase mb-3 block">Service</label>
                    <button 
                        onClick={() => openSelectionModal('provider', "Select Education Service", EDUCATION_PROVIDERS, (val) => handleProviderChange(val, 'education'))}
                        className="w-full bg-white border border-slate-200 p-4 rounded-2xl flex justify-between items-center hover:border-emerald-400 transition-colors shadow-sm active:scale-[0.98]"
                    >
                        <div className="flex items-center gap-4">
                            <div className="w-12 h-12 shrink-0 rounded-full border border-slate-100 bg-emerald-50 flex items-center justify-center shadow-inner overflow-hidden">
                                <GraduationCap className="text-emerald-500" size={24} />
                            </div>
                            <div>
                                <span className="text-sm font-black text-slate-900 tracking-tight uppercase">
                                  {EDUCATION_PROVIDERS.find(p => p.serviceID === educationProvider)?.displayName}
                                </span>
                            </div>
                        </div>
                        <ChevronDown size={18} className="text-slate-400"/>
                    </button>
                </div>

                {educationProvider === "jamb" && (
                    <div className="animate-in fade-in slide-in-from-top-2">
                        <label className="text-[10px] font-black text-slate-400 uppercase mb-2 flex justify-between">
                          <span>Profile ID</span>
                          <span className={accountNumber.length >= 10 ? "text-emerald-500" : "text-slate-400"}>{accountNumber.length}/10</span>
                        </label>
                        <input 
                            type="tel" placeholder="Enter ID"
                            maxLength={15}
                            className={`w-full bg-slate-50 border p-5 rounded-2xl font-black text-xl text-slate-800 outline-none transition-all ${
                              accountNumber.length > 0 && accountNumber.length < 10 ? "border-red-300 focus:border-red-500" : "border-slate-100 focus:border-emerald-500"
                            }`}
                            value={accountNumber}
                            onChange={(e) => setAccountNumber(e.target.value.replace(/[^0-9]/g, ''))}
                        />
                        {isVerifying && <p className="text-[10px] text-blue-500 font-bold mt-2 animate-pulse flex items-center gap-1.5"><Loader2 size={12} className="animate-spin"/> Verifying...</p>}
                        {customerName && (
                            <div className="mt-2 bg-emerald-500/10 p-4 rounded-xl border border-emerald-500/20 flex items-center gap-3 animate-in fade-in">
                                <CheckCircle2 size={18} className="text-emerald-600" />
                                <div className="flex-1">
                                    <span className="text-sm font-black text-emerald-800 line-clamp-1">{customerName}</span>
                                    <p className="text-[10px] font-black text-emerald-600 uppercase">Verified</p>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 shadow-sm animate-in fade-in slide-in-from-top-4">
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">Select Plan</p>
                  {selectedEducationPlan ? (
                      <div className="relative animate-in zoom-in-95 duration-200 mt-2">
                          <button onClick={() => { setSelectedEducationPlan(null); setNairaAmount(""); }} className="absolute -top-3 -right-3 bg-slate-200 text-slate-500 hover:text-slate-800 hover:bg-slate-300 rounded-full p-1 transition-all z-10 shadow-sm border border-white">
                            <XCircle size={16}/>
                          </button>
                          <div className="p-4 rounded-2xl border-2 border-emerald-500 bg-emerald-50 shadow-sm text-left">
                            <p className="font-black text-slate-900 text-sm pr-2">{selectedEducationPlan.name}</p>
                            <div className="pt-2 border-t border-emerald-200/50 flex justify-between items-end">
                                <p className="font-black text-emerald-600 text-xl">₦{parseFloat(selectedEducationPlan.variation_amount || "0").toLocaleString()}</p>
                                <p className="text-[10px] text-slate-500 font-bold">{(parseFloat(selectedEducationPlan.variation_amount || "0") / exchangeRate).toFixed(4)} {selectedToken.symbol}</p>
                              </div>
                          </div>
                      </div>
                  ) : (
                      <div className="grid grid-cols-1 gap-2 max-h-[30vh] overflow-y-auto pr-1">
                        {educationVariations.length === 0 ? (
                          <p className="text-center text-xs font-bold text-slate-400 py-4"><Loader2 className="animate-spin inline-block mr-2" size={14}/> Loading...</p>
                        ) : (
                          educationVariations.map((plan) => (
                            <button 
                              key={plan.variation_code} 
                              onClick={() => { setSelectedEducationPlan(plan); setNairaAmount(plan.variation_amount ? plan.variation_amount.toString() : "0"); }} 
                              className="p-3 rounded-xl border border-slate-200 bg-white hover:border-emerald-300 transition-all text-left flex justify-between items-center group"
                            >
                              <div className="mr-2">
                                <p className="font-black text-slate-800 text-xs line-clamp-2">{plan.name}</p>
                                <p className="text-[9px] text-slate-400 font-bold mt-1">{(parseFloat(plan.variation_amount || "0") / exchangeRate).toFixed(4)} {selectedToken.symbol}</p>
                              </div>
                              <p className="font-black text-emerald-600 text-sm group-hover:scale-110 transition-transform shrink-0">₦{parseFloat(plan.variation_amount || "0").toLocaleString()}</p>
                            </button>
                          ))
                        )}
                      </div>
                  )}
                </div>

                <div className="animate-in fade-in">
                    <label className="text-[10px] font-black text-slate-400 uppercase mb-2 flex justify-between">
                      <span>SMS Phone</span>
                      <span className={customerPhone.length >= 10 ? "text-emerald-500" : "text-slate-400"}>{customerPhone.length}/11</span>
                    </label>
                    <input 
                        type="tel" placeholder="08000000000"
                        maxLength={11}
                        className={`w-full bg-slate-50 border p-5 rounded-2xl font-black text-xl text-slate-800 outline-none transition-all ${
                          customerPhone.length > 0 && customerPhone.length < 10 ? "border-red-300 focus:border-red-500" : "border-slate-100 focus:border-emerald-500"
                        }`}
                        value={customerPhone}
                        onChange={(e) => setCustomerPhone(e.target.value.replace(/[^0-9]/g, ''))}
                    />
                </div>

                {status && (
                    <div className={`p-5 rounded-2xl border flex items-center gap-4 animate-in fade-in shadow-sm ${status.includes('Success') || status.includes('Secured') || status.includes('Initiating') ? 'bg-emerald-50 border-emerald-100 text-emerald-800' : 'bg-blue-50 border-blue-100 text-blue-800'}`}>
                        {status.includes('Success') ? <CheckCircle2 size={24}/> : <Loader2 size={24} className="animate-spin"/>}
                        <p className="text-sm font-black tracking-tight">{status}</p>
                    </div>
                )}

                <button 
                    onClick={handlePayment}
                    disabled={!isFormValid || isProcessing}
                    className="w-full bg-slate-900 hover:bg-black text-white font-black py-6 rounded-3xl flex items-center justify-center gap-3.5 transition-all active:scale-95 disabled:opacity-30 shadow-xl shadow-slate-900/20 text-lg tracking-tight"
                >
                    {isProcessing ? <Loader2 size={24} className="animate-spin text-emerald-400"/> : <ShieldCheck size={24} className="text-emerald-400" />}
                    {isProcessing ? 'PROCESSING...' : `PAY ${cryptoToCharge} ${selectedToken.symbol}`}
                </button>
            </div>
          </div>
        )}

        {/* ======================================= */}
        {/* BANK BLOCK */}
        {/* ======================================= */}
        {activeTab === 'bank' && (
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
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Balance</p>
                    <div className="flex items-center justify-end gap-1">
                      {isFetchingBalance ? <Loader2 size={12} className="animate-spin text-emerald-500"/> : <Coins size={12} className="text-emerald-500"/>}
                      <p className="font-mono font-black text-sm text-slate-800">{walletBalance}</p>
                    </div>
                  </div>
                </div>

                <div className="animate-in slide-in-from-left-2 mb-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase mb-3 block">Bank</label>
                    <button 
                        onClick={() => openSelectionModal('bank', "Select Destination Bank", bankVariations, (val: any) => {
                            const foundBank = bankVariations.find(b => b.variation_code === val);
                            handleProviderChange(foundBank, 'bank');
                        })}
                        className="w-full bg-white border border-slate-200 p-4 rounded-2xl flex justify-between items-center hover:border-blue-400 transition-colors shadow-sm active:scale-[0.98]"
                    >
                        <div className="flex items-center gap-4">
                            <div className="w-12 h-12 shrink-0 rounded-full border border-slate-100 bg-blue-50 flex items-center justify-center shadow-inner">
                                <Landmark className="text-blue-500" size={20} />
                            </div>
                            <span className="text-sm font-black text-slate-900 tracking-tight">{selectedBank ? selectedBank.name : 'Select Bank'}</span>
                        </div>
                        <ChevronDown size={18} className="text-slate-400"/>
                    </button>
                </div>

                <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase mb-2 flex justify-between">
                      <span>Account No</span>
                      <span className={accountNumber.length === 10 ? "text-emerald-500" : "text-slate-400"}>{accountNumber.length}/10</span>
                    </label>
                    <input 
                        type="tel" placeholder="1234567890"
                        maxLength={10}
                        className={`w-full bg-slate-50 border p-5 rounded-2xl font-black text-xl text-slate-800 outline-none transition-all ${
                          accountNumber.length > 0 && accountNumber.length < 10 ? "border-red-300" : "border-slate-100 focus:border-emerald-500"
                        }`}
                        value={accountNumber}
                        onChange={(e) => setAccountNumber(e.target.value.replace(/[^0-9]/g, ''))}
                    />
                    {isVerifying && <p className="text-[10px] text-blue-500 font-bold mt-2 animate-pulse flex items-center gap-1.5"><Loader2 size={12} className="animate-spin"/> Verifying...</p>}
                    {customerName && (
                        <div className="mt-2 bg-emerald-500/10 p-4 rounded-xl border border-emerald-500/20 flex items-center gap-3 animate-in fade-in">
                            <CheckCircle2 size={18} className="text-emerald-600" />
                            <div className="flex-1">
                                <span className="text-sm font-black text-emerald-800 line-clamp-1">{customerName}</span>
                                <p className="text-[10px] font-black text-emerald-600 uppercase">Verified</p>
                            </div>
                        </div>
                    )}
                </div>

                <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase mb-2 flex justify-between items-center">
                       <span>Amount</span>
                       <span className="text-emerald-500 font-black">MIN ₦1,000</span>
                    </label>
                    <div className="relative mb-3">
                        <input 
                            type="number" 
                            placeholder="Amount" 
                            className="w-full bg-slate-50 border border-slate-100 p-6 rounded-2xl font-black text-3xl text-slate-800 outline-none shadow-inner"
                            value={nairaAmount}
                            onChange={(e) => setNairaAmount(e.target.value)}
                        />
                        <div className="absolute right-5 top-1/2 -translate-y-1/2 text-right">
                            <p className="text-sm font-black text-emerald-600">{cryptoToCharge} {selectedToken.symbol}</p>
                            {currentFee > 0 && <p className="text-[9px] font-black text-orange-500">+₦{currentFee} FEE</p>}
                        </div>
                    </div>
                    {/* ⚡ MIN MAX ALERT FOR BANK ⚡ */}
                    {nairaAmount && (parseFloat(nairaAmount) < dynamicMinAmount || parseFloat(nairaAmount) > dynamicMaxAmount) && (
                        <div className="bg-red-50 border border-red-200 p-3 rounded-xl mt-2 flex items-center gap-2 animate-in fade-in">
                            <AlertTriangle size={16} className="text-red-500 shrink-0" />
                            <p className="text-xs font-black text-red-600">
                                {parseFloat(nairaAmount) < dynamicMinAmount ? `Amount is below the minimum of ₦${dynamicMinAmount.toLocaleString()}` : `Amount exceeds the maximum of ₦${dynamicMaxAmount.toLocaleString()}`}
                            </p>
                        </div>
                    )}
                </div>

                <div className="animate-in fade-in">
                     <input 
                        type="tel" placeholder="Sender's Phone (Receipt)"
                        maxLength={11}
                        className="w-full bg-slate-50 border border-slate-100 p-5 rounded-2xl font-bold text-slate-700 outline-none focus:border-emerald-500 transition-colors"
                        onChange={(e) => setCustomerPhone(e.target.value.replace(/[^0-9]/g, ''))}
                    />
                </div>

                {status && (
                    <div className={`p-5 rounded-2xl border flex items-center gap-4 animate-in fade-in ${status.includes('Success') ? 'bg-emerald-50 border-emerald-100' : 'bg-blue-50 border-blue-100'}`}>
                        {status.includes('Success') ? <CheckCircle2 size={24}/> : <Loader2 size={24} className="animate-spin"/>}
                        <p className="text-sm font-black tracking-tight">{status}</p>
                    </div>
                )}

                <button 
                    onClick={handlePayment}
                    disabled={isVerifying || !isFormValid || isProcessing}
                    className="w-full bg-slate-900 hover:bg-black text-white font-black py-6 rounded-3xl flex items-center justify-center gap-3.5 transition-all active:scale-95 disabled:opacity-30 shadow-xl shadow-slate-900/20 text-lg tracking-tight"
                >
                    {isProcessing ? <Loader2 size={24} className="animate-spin text-emerald-400"/> : <ShieldCheck size={24} className="text-emerald-400" />}
                    {isProcessing ? 'PROCESSING...' : `TRANSFER ${cryptoToCharge} ${selectedToken.symbol}`}
                </button>
            </div>
          </div>
        )}

        {/* ======================================= */}
        {/* PAY BLOCK */}
        {/* ======================================= */}
        {activeTab === 'pay' && (
          <div className="bg-white border border-slate-100 rounded-[2.5rem] p-8 shadow-2xl shadow-emerald-900/10 animate-in fade-in zoom-in-95">
            {/* ⚡ SMALLER SERVICE INDICATOR FRAME ⚡ */}
            <div className="flex overflow-x-auto gap-2 pb-2 mb-4 no-scrollbar">
                {SERVICES.filter(s => s.id !== 'BANK').map(s => (
                    <button 
                        key={s.id} 
                        onClick={() => handleResetService(s)}
                        className={`min-w-[65px] p-2.5 rounded-xl border-2 transition-all flex flex-col items-center justify-center gap-1.5 shrink-0 ${
                            activeService.id === s.id ? 'border-emerald-500 bg-emerald-50/50 scale-100 shadow-sm' : 'border-slate-100 bg-white hover:bg-slate-50'
                        }`}
                    >
                        <s.icon size={18} className={s.color} />
                        <span className="text-[9px] font-black uppercase tracking-tight">{s.name}</span>
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
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Balance</p>
                    <div className="flex items-center justify-end gap-1">
                      {isFetchingBalance ? <Loader2 size={12} className="animate-spin text-emerald-500"/> : <Coins size={12} className="text-emerald-500"/>}
                      <p className="font-mono font-black text-sm text-slate-800">{walletBalance}</p>
                    </div>
                  </div>
                </div>

                <div className="animate-in slide-in-from-left-2 mb-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase mb-3 block">Provider</label>
                    {activeService.id === "INTERNET" ? (
                        <button 
                            onClick={() => openSelectionModal('provider', "Select Provider", INTERNET_PROVIDERS, (val) => handleProviderChange(val, 'internet'))}
                            className="w-full bg-white border border-slate-200 p-4 rounded-2xl flex justify-between items-center hover:border-sky-400 transition-colors shadow-sm active:scale-[0.98]"
                        >
                            <div className="flex items-center gap-4">
                                <div className="w-12 h-12 shrink-0 rounded-full border border-slate-100 bg-sky-50 flex items-center justify-center shadow-inner overflow-hidden">
                                    <img src={currentInternet?.logo || '/wifi.png'} alt={currentInternet?.displayName} className="w-full h-full object-contain" onError={(e) => { e.currentTarget.src = '/logo.png'; }} />
                                </div>
                                <span className="text-sm font-black text-slate-900 tracking-tight">{currentInternet?.displayName}</span>
                            </div>
                            <ChevronDown size={18} className="text-slate-400"/>
                        </button>
                    ) : activeService.id === "AIRTIME" ? (
                        <button 
                            onClick={() => openSelectionModal('standard', "Select Network", TELECOM_PROVIDERS.map(p => ({ serviceID: p, displayName: p.toUpperCase(), logo: `/${p}.png` })), (val) => handleProviderChange(val, 'telecom'))}
                            className="w-full bg-white border border-slate-200 p-4 rounded-2xl flex justify-between items-center hover:border-emerald-400 transition-colors shadow-sm active:scale-[0.98]"
                        >
                            <div className="flex items-center gap-4">
                                <div className="w-12 h-12 shrink-0 rounded-full border border-slate-100 bg-emerald-50 flex items-center justify-center shadow-inner overflow-hidden">
                                    <img src={`/${telecomProvider}.png`} alt={telecomProvider} className="w-full h-full object-contain" onError={(e) => { e.currentTarget.src = '/logo.png'; }} />
                                </div>
                                <span className="text-sm font-black text-slate-900 tracking-tight uppercase">{telecomProvider}</span>
                            </div>
                            <ChevronDown size={18} className="text-slate-400"/>
                        </button>
                    ) : activeService.id === "ELECTRICITY" ? (
                        <button 
                            onClick={() => openSelectionModal('provider', "Select Provider", ELECTRICITY_DISCOS, (val) => handleProviderChange(val, 'elec'))}
                            className="w-full bg-white border border-slate-200 p-4 rounded-2xl flex justify-between items-center hover:border-orange-400 transition-colors shadow-sm active:scale-[0.98]"
                        >
                            <div className="flex items-center gap-4">
                                <div className="w-12 h-12 shrink-0 rounded-full border border-slate-100 bg-white p-0.5 flex items-center justify-center shadow-inner overflow-hidden">
                                    <img src={currentDisco?.logo} alt={currentDisco?.displayName} className="w-full h-full object-contain" />
                                </div>
                                <span className="text-sm font-black text-slate-900 tracking-tight">{currentDisco?.displayName}</span>
                            </div>
                            <ChevronDown size={18} className="text-slate-400"/>
                        </button>
                    ) : (
                      <button 
                        onClick={() => openSelectionModal('provider', "Select Provider", CABLE_PROVIDERS_LIST, (val) => handleProviderChange(val, 'cable'))}
                        className="w-full bg-white border border-slate-200 p-4 rounded-2xl flex justify-between items-center hover:border-pink-400 transition-colors shadow-sm active:scale-[0.98]"
                      >
                        <div className="flex items-center gap-4">
                            <div className="w-12 h-12 shrink-0 rounded-full border border-slate-100 bg-white p-0.5 flex items-center justify-center shadow-inner overflow-hidden">
                                <img src={currentCable?.logo} alt={currentCable?.displayName} className="w-full h-full object-contain" />
                            </div>
                            <span className="text-sm font-black text-slate-900 tracking-tight">{currentCable?.displayName}</span>
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
                      <span>{activeService.id === "INTERNET" ? (['smile-direct', 'spectranet'].includes(internetProvider) ? "Internet ID / Email" : "Phone No") : activeService.id === "AIRTIME" ? "Phone No" : "Number"}</span>
                      {(activeService.id === "AIRTIME" || (activeService.id === "INTERNET" && internetProvider.includes('-data'))) && (
                        <span className={accountNumber.length === 11 ? "text-emerald-500" : "text-slate-400"}>{accountNumber.length}/11</span>
                      )}
                    </label>
                    <input 
                        type={activeService.id === "INTERNET" && internetProvider === 'smile-direct' ? "email" : "tel"} 
                        placeholder="Enter Number"
                        className={`w-full bg-slate-50 border p-5 rounded-2xl font-black text-xl text-slate-800 outline-none transition-all ${
                          ((activeService.id === "AIRTIME" || (activeService.id === "INTERNET" && internetProvider.includes('-data'))) && accountNumber.length > 0 && accountNumber.length < 11) ? "border-red-300" : "border-slate-100 focus:border-emerald-500"
                        }`}
                        value={accountNumber}
                        onChange={(e) => {
                            if (activeService.id === "INTERNET" && internetProvider === 'smile-direct') setAccountNumber(e.target.value);
                            else setAccountNumber(e.target.value.replace(/[^0-9]/g, ''));
                        }}
                    />
                    {isVerifying && <p className="text-[10px] text-blue-500 font-bold mt-2 animate-pulse flex items-center gap-1.5"><Loader2 size={12} className="animate-spin"/> Verifying...</p>}
                    {customerName && (activeService.id === "ELECTRICITY" || (activeService.id === "INTERNET" && internetProvider === 'smile-direct')) && (
                        <div className="mt-2 bg-emerald-500/10 p-4 rounded-xl border border-emerald-500/20 flex items-center gap-3 animate-in fade-in">
                            <CheckCircle2 size={18} className="text-emerald-600" />
                            <div className="flex-1">
                                <span className="text-sm font-black text-emerald-800 line-clamp-1">{customerName}</span>
                                <p className="text-[10px] font-black text-emerald-600 uppercase">Verified</p>
                            </div>
                        </div>
                    )}
                </div>

                {activeService.id === "INTERNET" && (
                  <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 shadow-sm animate-in fade-in slide-in-from-top-4">
                     {internetProvider !== 'spectranet' && (
                       <div className="flex gap-2 mb-4 overflow-x-auto no-scrollbar shadow-inner bg-slate-100 p-1.5 rounded-2xl">
                          {DATA_CATEGORIES.map(cat => (
                            <button key={cat} onClick={() => { setActiveDataCategory(cat); setSelectedInternetPlan(null); setNairaAmount(""); }} className={`px-4 py-2.5 rounded-xl text-[11px] font-black uppercase transition-all whitespace-nowrap ${activeDataCategory === cat ? 'bg-white shadow-lg text-purple-600' : 'text-slate-500'}`}>{cat}</button>
                          ))}
                        </div>
                     )}

                     {selectedInternetPlan ? (
                        <div className="relative animate-in zoom-in-95 duration-200 mt-2">
                           <button onClick={() => { setSelectedInternetPlan(null); setNairaAmount(""); }} className="absolute -top-3 -right-3 bg-slate-200 text-slate-500 hover:text-slate-800 hover:bg-slate-300 rounded-full p-1 transition-all z-10 shadow-sm border border-white">
                             <XCircle size={16}/>
                           </button>
                           <div className="p-4 rounded-2xl border-2 border-sky-500 bg-sky-50 shadow-sm text-left">
                              <p className="font-black text-slate-900 text-lg">{selectedInternetPlan.name}</p>
                              <div className="pt-2 border-t border-sky-200/50 flex justify-between items-end">
                                  <p className="font-black text-sky-600 text-xl">₦{parseFloat(selectedInternetPlan.variation_amount || "0").toLocaleString()}</p>
                                  <p className="text-[10px] text-slate-500 font-bold">{(parseFloat(selectedInternetPlan.variation_amount || "0") / exchangeRate).toFixed(4)} {selectedToken.symbol}</p>
                               </div>
                           </div>
                        </div>
                     ) : (
                        <div className="grid grid-cols-1 gap-2 max-h-[30vh] overflow-y-auto pr-1">
                          {internetVariations.length === 0 ? (
                            <p className="text-center text-xs font-bold text-slate-400 py-4"><Loader2 className="animate-spin" size={14}/> Loading...</p>
                          ) : filteredInternetDataPlans.map((plan) => (
                                <button key={plan.variation_code} onClick={() => { setSelectedInternetPlan(plan); setNairaAmount(plan.variation_amount ? plan.variation_amount.toString() : "0"); }} className="p-3 rounded-xl border border-slate-200 bg-white hover:border-sky-300 transition-all text-left flex justify-between items-center group">
                                  <div>
                                    <p className="font-black text-slate-800 text-xs">{plan.name}</p>
                                    <p className="text-[9px] text-slate-400 font-bold mt-0.5">{(parseFloat(plan.variation_amount || "0") / exchangeRate).toFixed(4)} {selectedToken.symbol}</p>
                                  </div>
                                  <p className="font-black text-sky-600 text-sm group-hover:scale-110 transition-transform">₦{parseFloat(plan.variation_amount || "0").toLocaleString()}</p>
                                </button>
                          ))}
                        </div>
                     )}
                  </div>
                )}

                {activeService.id === "CABLE" && (cableProvider === "showmax" || customerName) && (
                  <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 shadow-sm animate-in fade-in slide-in-from-top-4">
                     {selectedCablePlan ? (
                          <div className="relative animate-in zoom-in-95 duration-200 mt-2">
                             <button onClick={() => { setSelectedCablePlan(null); setNairaAmount(""); }} className="absolute -top-3 -right-3 bg-slate-200 text-slate-500 hover:text-slate-800 hover:bg-slate-300 rounded-full p-1 transition-all z-10 shadow-sm border border-white">
                               <XCircle size={16}/>
                             </button>
                             <div className="p-4 rounded-2xl border-2 border-blue-500 bg-blue-50 shadow-sm text-left">
                                <p className="font-black text-slate-900 text-lg">{selectedCablePlan.name}</p>
                                <div className="pt-2 border-t border-blue-200/50 flex justify-between items-end">
                                    <p className="font-black text-blue-600 text-xl">₦{parseFloat(selectedCablePlan.variation_amount).toLocaleString()}</p>
                                    <p className="text-[10px] text-slate-500 font-bold">{(parseFloat(selectedCablePlan.variation_amount) / exchangeRate).toFixed(4)} {selectedToken.symbol}</p>
                                 </div>
                             </div>
                          </div>
                       ) : (
                          <div className="grid grid-cols-1 gap-2 max-h-[30vh] overflow-y-auto pr-1">
                            {cableVariations.length === 0 ? (
                              <p className="text-center text-xs font-bold text-slate-400 py-4"><Loader2 className="animate-spin" size={14}/> Loading...</p>
                            ) : cableVariations.map((plan) => (
                                  <button key={plan.variation_code} onClick={() => { setSelectedCablePlan(plan); setNairaAmount(plan.variation_amount); }} className="p-3 rounded-xl border border-slate-200 bg-white hover:border-slate-300 transition-all text-left flex justify-between items-center group">
                                    <p className="font-black text-slate-800 text-xs">{plan.name}</p>
                                    <p className="font-black text-blue-600 text-sm shrink-0 ml-2">₦{parseFloat(plan.variation_amount).toLocaleString()}</p>
                                  </button>
                            ))}
                          </div>
                       )}
                  </div>
                )}

                <div className={activeService.id === "INTERNET" || activeService.id === "CABLE" ? "hidden" : ""}>
                    <label className="text-[10px] font-black text-slate-400 uppercase mb-2 flex justify-between items-center">
                       <span>Amount</span>
                       <span className="text-emerald-500 font-black">MIN ₦{dynamicMinAmount.toLocaleString()}</span>
                    </label>
                    <div className="relative mb-3">
                        <input 
                            type="number" 
                            placeholder="Amount" 
                            className="w-full bg-slate-50 border border-slate-100 p-6 rounded-2xl font-black text-3xl text-slate-800 outline-none shadow-inner"
                            value={nairaAmount}
                            onChange={(e) => setNairaAmount(e.target.value)}
                        />
                        <div className="absolute right-5 top-1/2 -translate-y-1/2 text-right">
                            <p className="text-sm font-black text-emerald-600">{cryptoToCharge} {selectedToken.symbol}</p>
                            {currentFee > 0 && <p className="text-[9px] font-black text-orange-500">+₦{currentFee} FEE</p>}
                        </div>
                    </div>
                    {/* ⚡ MIN MAX ALERT FOR UTILITIES ⚡ */}
                    {nairaAmount && (parseFloat(nairaAmount) < dynamicMinAmount || parseFloat(nairaAmount) > dynamicMaxAmount) && (
                        <div className="bg-red-50 border border-red-200 p-3 rounded-xl mt-2 flex items-center gap-2 animate-in fade-in">
                            <AlertTriangle size={16} className="text-red-500 shrink-0" />
                            <p className="text-xs font-black text-red-600">
                                {parseFloat(nairaAmount) < dynamicMinAmount ? `Amount is below the minimum of ₦${dynamicMinAmount.toLocaleString()}` : `Amount exceeds the maximum of ₦${dynamicMaxAmount.toLocaleString()}`}
                            </p>
                        </div>
                    )}
                </div>

                {/* ⚡ SMS PHONE NUMBER FIX: ONLY FOR ELECTRICITY & SMILE/SPECTRANET ⚡ */}
                {(activeService.id === "ELECTRICITY" || (activeService.id === "INTERNET" && ['smile-direct', 'spectranet'].includes(internetProvider))) && (
                    <div className="animate-in fade-in">
                         <input 
                            type="tel" placeholder="SMS Phone Number"
                            maxLength={11}
                            className="w-full bg-slate-50 border border-slate-100 p-5 rounded-2xl font-bold text-slate-700 outline-none"
                            onChange={(e) => setCustomerPhone(e.target.value.replace(/[^0-9]/g, ''))}
                        />
                    </div>
                )}

                {status && (
                    <div className={`p-5 rounded-2xl border flex items-center gap-4 animate-in fade-in ${status.includes('Success') ? 'bg-emerald-50 border-emerald-100' : 'bg-blue-50 border-blue-100'}`}>
                        {status.includes('Success') ? <CheckCircle2 size={24}/> : <Loader2 size={24} className="animate-spin"/>}
                        <p className="text-sm font-black tracking-tight">{status}</p>
                    </div>
                )}

                <button 
                    onClick={handlePayment}
                    disabled={isVerifying || !isFormValid || isProcessing}
                    className="w-full bg-slate-900 hover:bg-black text-white font-black py-6 rounded-3xl flex items-center justify-center gap-3.5 transition-all active:scale-95 disabled:opacity-30 shadow-xl shadow-slate-900/20 text-lg tracking-tight"
                >
                    {isProcessing ? <Loader2 size={24} className="animate-spin text-emerald-400"/> : <ShieldCheck size={24} className="text-emerald-400" />}
                    {isProcessing ? 'PROCESSING...' : `PAY ${cryptoToCharge} ${selectedToken.symbol}`}
                </button>
            </div>
          </div>
        )}

        {/* HISTORY BLOCK */}
        {activeTab === 'history' && (
          <HistoryTab 
            transactions={transactions} 
            currentTransactions={currentTransactions} 
            currentPage={currentPage} 
            totalPages={totalPages} 
            setCurrentPage={setCurrentPage} 
            setSelectedReceipt={setSelectedReceipt} 
          />
        )}

        <footer className="mt-12 w-full border-t border-slate-200 pt-8 pb-4 flex flex-col items-center gap-4 animate-in fade-in">
          <div className="flex items-center gap-2.5 bg-white px-4 py-1.5 rounded-full shadow-sm border border-slate-100">
             <ShieldCheck size={16} className="text-emerald-600" />
             <span className="text-[11px] font-bold text-slate-500 uppercase tracking-widest">Secured by Celo Network</span>
          </div>
          <div className="flex gap-6">
            <button onClick={() => setIsTermsOpen(true)} className="text-[10px] font-black text-slate-400 hover:text-emerald-600 uppercase">Terms</button>
            <button onClick={() => setIsPrivacyOpen(true)} className="text-[10px] font-black text-slate-400 hover:text-emerald-600 uppercase">Privacy</button>
          </div>
          <p className="text-[9px] font-medium text-slate-300 uppercase tracking-[0.2em] mt-2">© 2026 MASONODE ORGANISATION • v3.0</p>
        </footer>
      </div>
    </main>
  );
}
