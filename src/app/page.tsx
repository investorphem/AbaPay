"use client";

import React, { useState, useEffect, useMemo, useRef } from "react";
import { createWalletClient, createPublicClient, custom, http, parseUnits, formatUnits } from "viem";
import { celo, celoSepolia } from "viem/chains";
import Link from "next/link";
import { 
  ShieldCheck, Zap, AlertTriangle, CheckCircle2, ChevronDown, 
  Loader2, Coins, Briefcase, ListPlus, Users, Landmark, XCircle, 
  RefreshCw, Tv, GraduationCap, Send, Globe
} from "lucide-react";
import { supabase } from "@/utils/supabase";
import { ELECTRICITY_DISCOS } from "./discos"; 

import { ReceiptModal, SelectionModal } from "@/components/Modals";
import { TermsModal, PrivacyModal } from "@/components/Modals";
import PointsBadge from "@/components/PointsBadge"; 
import DataVariationsUI from "@/components/DataVariationsUI"; 
import AppFooter from "@/components/AppFooter"; 
import BankTab from "@/components/BankTab"; // ⚡ OUR NEW BANK COMPONENT ⚡
import { 
  ABAPAY_ABI, ERC20_ABI, SERVICES, CABLE_PROVIDERS_LIST, TELECOM_PROVIDERS, 
  INTERNET_PROVIDERS, SUPPORTED_TOKENS, SUPPORTED_COUNTRIES, PRE_SELECT_AMOUNTS, 
  ELEC_PRE_SELECT_AMOUNTS, ITEMS_PER_PAGE, extractVtpassArray,
  ELECTRICITY_PROVIDER_IDS, EDUCATION_PROVIDERS
} from "@/constants";
import { HistoryTab } from "@/components/HistoryTab";

export default function Home() {
  const [killSwitches, setKillSwitches] = useState<Record<string, boolean>>({});
  const [isInitiallyLoading, setIsInitiallyLoading] = useState(true);
  const [address, setAddress] = useState<string | null>(null);
  const [client, setClient] = useState<any>(null);
  
  const [nairaAmount, setNairaAmount] = useState(""); 
  const [accountNumber, setAccountNumber] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerEmail, setCustomerEmail] = useState(""); 
  const [status, setStatus] = useState("");

  const [activeTab, setActiveTab] = useState<"pay" | "bank" | "education" | "history">("pay");
  const [isProcessing, setIsProcessing] = useState(false); 
  const [customerName, setCustomerName] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const [isConfirmModalOpen, setIsConfirmModalOpen] = useState(false);

  const [beneficiaries, setBeneficiaries] = useState<Record<string, {account: string, name: string | null}[]>>({});
  const [activeDeleteAccount, setActiveDeleteAccount] = useState<string | null>(null);
  const pressTimer = useRef<NodeJS.Timeout | null>(null);
  const isLongPress = useRef(false);

  const [meterAddress, setMeterAddress] = useState<string | null>(null);
  const [dynamicElecMin, setDynamicElecMin] = useState<number>(1000);
  const [meterAccountType, setMeterAccountType] = useState<string | null>(null);
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

  const [activeCountry, setActiveCountry] = useState<{code: string, name: string, flag?: string}>(SUPPORTED_COUNTRIES[0]);
  const [activeService, setActiveService] = useState(SERVICES[0]);
  const [elecProvider, setElecProvider] = useState(ELECTRICITY_PROVIDER_IDS[0]);
  const [cableProvider, setCableProvider] = useState(CABLE_PROVIDERS_LIST[0].serviceID);
  const [telecomProvider, setTelecomProvider] = useState(TELECOM_PROVIDERS[0]);
  const [internetProvider, setInternetProvider] = useState(INTERNET_PROVIDERS[0].serviceID);
  const [meterType, setMeterType] = useState<"prepaid" | "postpaid">("prepaid");

  const [intlCountries, setIntlCountries] = useState<any[]>([]);
  const [intlProductTypes, setIntlProductTypes] = useState<any[]>([]);
  const [intlOperators, setIntlOperators] = useState<any[]>([]);
  const [intlVariations, setIntlVariations] = useState<any[]>([]);
  const [intlCurrency, setIntlCurrency] = useState<string>(""); 
  
  const [selectedIntlProduct, setSelectedIntlProduct] = useState<any>(null);
  const [selectedIntlOperator, setSelectedIntlOperator] = useState<any>(null);
  const [selectedIntlVariation, setSelectedIntlVariation] = useState<any>(null);
  const [intlFlexibleAmount, setIntlFlexibleAmount] = useState("");
  const [isIntlLoading, setIsIntlLoading] = useState(false);

  const [selectedReceipt, setSelectedReceipt] = useState<any>(null); 
  const [isSelectionModalOpen, setIsSelectionModalOpen] = useState(false);
  const [modalTitle, setModalTitle] = useState("");
  const [modalOptions, setModalOptions] = useState<any[]>([]); 
  const [modalCallback, setModalCallback] = useState<((value: string) => void) | null>(null);
  const [modalType, setModalType] = useState<'standard' | 'token' | 'provider' | 'country' | 'bank'>('standard'); 
  const [toast, setToast] = useState<{title: string, message: string, type: 'success' | 'error'} | null>(null);
  const [isSupportOpen, setIsSupportOpen] = useState(false);
  const [supportMessage, setSupportMessage] = useState("");
  const [supportTxHash, setSupportTxHash] = useState<string | null>(null);
  const [supportFile, setSupportFile] = useState<File | null>(null);
  const [isSendingSupport, setIsSendingSupport] = useState(false);

  const [currentPage, setCurrentPage] = useState(1);
  const [selectedToken, setSelectedToken] = useState(SUPPORTED_TOKENS[0]);
  const [walletBalance, setWalletBalance] = useState("0.00");
  const [isFetchingBalance, setIsFetchingBalance] = useState(false);
  const [exchangeRate, setExchangeRate] = useState<number>(1550); 
  const [transactions, setTransactions] = useState<any[]>([]);

  const isMainnet = process.env.NEXT_PUBLIC_NETWORK === "celo";
  const activeChain = isMainnet ? celo : celoSepolia;
  const ABAPAY_CONTRACT = process.env.NEXT_PUBLIC_ABAPAY_ADDRESS as `0x${string}`;
  const GAS_CURRENCY = isMainnet ? "0x765DE816845861e75A25fCA122bb6898B8B1282a" : "0xdE9e4C3ce781b4bA68120d6261cbad65ce0aB00b";

  const indexOfLastItem = currentPage * ITEMS_PER_PAGE;
  const indexOfFirstItem = indexOfLastItem - ITEMS_PER_PAGE;
  const currentTransactions = transactions.slice(indexOfFirstItem, indexOfLastItem);
  const totalPages = Math.ceil(transactions.length / ITEMS_PER_PAGE);

  const currentDisco = useMemo(() => ELECTRICITY_DISCOS.find(d => d.serviceID === elecProvider), [elecProvider]);
  const currentCable = useMemo(() => CABLE_PROVIDERS_LIST.find(c => c.serviceID === cableProvider), [cableProvider]);
  const currentInternet = useMemo(() => INTERNET_PROVIDERS.find(c => c.serviceID === internetProvider), [internetProvider]);

  const isInternational = activeCountry.code !== "NG";

  const isCurrentServiceDisabled = useMemo(() => {
      if (!killSwitches) return false;
      if (isInternational) return false; 
      if (activeTab === 'education') return killSwitches['MASTER_EDUCATION'] === false || killSwitches[`EDU_${educationProvider}`] === false;
      if (activeTab === 'pay') {
          if (activeService.id === "AIRTIME") return killSwitches['MASTER_AIRTIME'] === false || killSwitches[`AIRTIME_${telecomProvider.toLowerCase()}`] === false;
          if (activeService.id === "INTERNET") return killSwitches['MASTER_INTERNET'] === false || killSwitches[`INTERNET_${internetProvider}`] === false;
          if (activeService.id === "ELECTRICITY") return killSwitches['MASTER_ELECTRICITY'] === false || killSwitches[`ELEC_${elecProvider}`] === false;
          if (activeService.id === "CABLE") return killSwitches['MASTER_CABLE'] === false || killSwitches[`CABLE_${cableProvider}`] === false;
      }
      return false;
  }, [killSwitches, activeTab, activeService, educationProvider, telecomProvider, internetProvider, elecProvider, cableProvider, isInternational]);

  const dynamicMinAmount = useMemo(() => {
    if (activeTab === "bank") return 1000;
    if (activeService.id === "AIRTIME") return 100;
    return 100; 
  }, [activeService, activeTab]);

  const dynamicMaxAmount = useMemo(() => {
    if (activeTab === "bank") return 5000000;
    if (activeService.id === "ELECTRICITY") return 1000000; 
    if (activeService.id === "AIRTIME") return 50000;
    return Infinity; 
  }, [activeService, activeTab]);

  const isFixedPlan = isInternational 
    ? (selectedIntlVariation && selectedIntlVariation.fixedPrice === "Yes")
    : (activeTab === "education" || (activeTab === "pay" && (activeService.id === "INTERNET" || activeService.id === "CABLE")));
  
  const currentMinDisplay = (activeTab === "pay" && activeService.id === "ELECTRICITY") ? dynamicElecMin : dynamicMinAmount;

  const displayForeignAmount = useMemo(() => {
      if (!isInternational) return "0";
      if (!selectedIntlVariation) return "0";
      if (selectedIntlVariation.fixedPrice === "Yes") return parseFloat(selectedIntlVariation.variation_amount || "0").toLocaleString();
      return parseFloat(intlFlexibleAmount || "0").toLocaleString();
  }, [isInternational, selectedIntlVariation, intlFlexibleAmount]);

  const calculatedNairaAmount = useMemo(() => {
    if (!isInternational) return nairaAmount;
    if (!selectedIntlVariation) return "0";
    
    const rate = parseFloat(selectedIntlVariation.variation_rate || "1");
    if (selectedIntlVariation.fixedPrice === "Yes") {
        const charged = parseFloat(selectedIntlVariation.charged_amount || "0");
        if (charged > 0) return charged.toString();
        const varAmt = parseFloat(selectedIntlVariation.variation_amount || "0");
        return (varAmt * rate).toString();
    }
    const input = parseFloat(intlFlexibleAmount || "0");
    return (input * rate).toString();
  }, [isInternational, selectedIntlVariation, intlFlexibleAmount, nairaAmount]);

  const { cryptoToCharge, currentFee } = useMemo(() => {
    const bill = parseFloat(calculatedNairaAmount) || 0;
    const fee = (activeTab === "bank" || activeService.id === "ELECTRICITY" || activeService.id === "CABLE" || activeTab === "education") ? 100 : 0;
    const crypto = (bill + fee) / exchangeRate;
    return { cryptoToCharge: crypto.toFixed(4), currentFee: fee };
  }, [calculatedNairaAmount, exchangeRate, activeService, activeTab]);

  const walletBalanceNaira = useMemo(() => {
    const bal = parseFloat(walletBalance);
    if (isNaN(bal)) return "0.00";
    return (bal * exchangeRate).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }, [walletBalance, exchangeRate]);

  const checkoutDetails = useMemo(() => {
    let title = ""; let recipient = accountNumber; let recipientLabel = "Recipient";

    if (isInternational) {
        title = `${activeCountry.name} ${selectedIntlProduct?.name || 'Airtime'}`;
        recipientLabel = "Phone Number";
    } else if (activeTab === "bank") {
      title = `Transfer to ${selectedBank?.name || "Bank"}`; recipientLabel = "Account";
    } else if (activeTab === "education") {
      title = EDUCATION_PROVIDERS.find(p => p.serviceID === educationProvider)?.displayName || "Education";
      recipient = educationProvider === "jamb" ? accountNumber : customerPhone; recipientLabel = educationProvider === "jamb" ? "Profile ID" : "Phone Number";
    } else {
      if (activeService.id === "AIRTIME") { 
         title = `${telecomProvider === 'etisalat' ? '9MOBILE' : telecomProvider.toUpperCase()} Airtime`; 
         recipientLabel = "Phone Number"; 
      } 
      else if (activeService.id === "INTERNET") { title = `${currentInternet?.displayName || "Data"} Plan`; recipientLabel = internetProvider === 'smile-direct' ? "Email Account" : internetProvider === 'spectranet' ? "Spectranet ID" : "Phone Number"; } 
      else if (activeService.id === "ELECTRICITY") { title = `${currentDisco?.displayName || "Electricity"} (${meterType})`; recipientLabel = "Meter No"; } 
      else if (activeService.id === "CABLE") { title = `${currentCable?.displayName || "Cable TV"}`; recipientLabel = "Smartcard / IUC"; }
    }
    return { title, recipient, recipientLabel };
  }, [isInternational, activeCountry, selectedIntlProduct, activeTab, activeService, selectedBank, educationProvider, telecomProvider, currentInternet, internetProvider, currentDisco, meterType, currentCable, accountNumber, customerPhone]);

  const isFormValid = useMemo(() => {
    if (isCurrentServiceDisabled) return false;

    if (isInternational) {
        if (!selectedIntlProduct || !selectedIntlOperator || accountNumber.length < 6) return false;
        if (!selectedIntlVariation) return false;
        if (selectedIntlVariation.fixedPrice !== "Yes" && (!intlFlexibleAmount || parseFloat(intlFlexibleAmount) <= 0)) return false;
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(customerEmail)) return false;
        return true;
    }

    const amount = parseFloat(nairaAmount);
    if (!nairaAmount || isNaN(amount)) return false;
    if (!isFixedPlan) {
        const activeMinAmount = (activeTab === "pay" && activeService.id === "ELECTRICITY") ? dynamicElecMin : dynamicMinAmount;
        if (amount < activeMinAmount || amount > dynamicMaxAmount) return false;
    }
    if (activeTab === "bank") return accountNumber.length === 10 && customerName !== null && selectedBank !== null && customerPhone.length >= 10;
    if (activeTab === "education") {
      if (educationProvider === "jamb") return accountNumber.length >= 10 && customerName !== null && selectedEducationPlan !== null && customerPhone.length >= 10;
      return selectedEducationPlan !== null && customerPhone.length >= 10;
    }
    if (activeTab === "pay") {
      if (activeService.id === "AIRTIME") return accountNumber.length === 11 && accountNumber.startsWith("0");
      if (activeService.id === "INTERNET") {
        if (internetProvider === 'smile-direct') return internetAccountId !== null && selectedInternetPlan !== null && customerPhone.length >= 10;
        else if (internetProvider === 'spectranet') return accountNumber.length >= 5 && selectedInternetPlan !== null;
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
  }, [isInternational, selectedIntlProduct, selectedIntlOperator, selectedIntlVariation, intlFlexibleAmount, customerEmail, accountNumber, nairaAmount, activeService, customerName, dynamicMinAmount, dynamicMaxAmount, dynamicElecMin, cableSubscriptionType, selectedCablePlan, selectedBank, selectedInternetPlan, internetAccountId, customerPhone, internetProvider, activeTab, cableProvider, selectedEducationPlan, educationProvider, isFixedPlan, isCurrentServiceDisabled]);

  const showToast = (title: string, message: string, type: 'success' | 'error' = 'success') => {
    setToast({ title, message, type }); setTimeout(() => setToast(null), 5000);
  };

  const handleProviderChange = (newProvider: string, type: 'internet' | 'telecom' | 'cable' | 'elec' | 'bank' | 'education') => {
    setNairaAmount(""); setAccountNumber(""); setCustomerName(null); setCustomerPhone(""); setCustomerEmail(""); setMeterAddress(null); setDynamicElecMin(1000); setMeterAccountType(null);
    if (type === 'internet') { setInternetVariations([]); setInternetProvider(newProvider); setSelectedInternetPlan(null); setInternetAccountId(null); } 
    else if (type === 'telecom') { setTelecomProvider(newProvider); } 
    else if (type === 'cable') { setCableProvider(newProvider); setSelectedCablePlan(null); setCableCurrentBouquet(null); setCableRenewAmount(null); setCableSubscriptionType("renew"); } 
    else if (type === 'elec') { setElecProvider(newProvider); } 
    else if (type === 'bank') { setSelectedBank(newProvider); }
    else if (type === 'education') { setEducationProvider(newProvider); setSelectedEducationPlan(null); }
  };

  const handleResetService = (s: any) => {
    setActiveService(s); setAccountNumber(""); setCustomerName(null); setNairaAmount(""); setCustomerPhone(""); setCustomerEmail(""); 
    setCableCurrentBouquet(null); setCableRenewAmount(null); setSelectedCablePlan(null);
    setCableSubscriptionType("renew"); setSelectedBank(null); setSelectedInternetPlan(null); setInternetAccountId(null);
    setSelectedEducationPlan(null); setInternetVariations([]); setMeterAddress(null); setDynamicElecMin(1000); setMeterAccountType(null);
    setSelectedIntlProduct(null); setSelectedIntlOperator(null); setSelectedIntlVariation(null); setIntlFlexibleAmount(""); setIntlOperators([]); setIntlVariations([]); setIntlCurrency("");
  };

  const handleTabSwitch = (tab: "pay" | "bank" | "education" | "history") => {
    if (isInternational && tab !== "pay" && tab !== "history") return; 
    setActiveTab(tab); setCustomerPhone(""); setCustomerEmail(""); handleResetService(SERVICES[0]);
  };

  const openSelectionModal = (type: 'standard' | 'token' | 'provider' | 'country' | 'bank', title: string, options: any[], callback: (value: string) => void) => {
    setModalType(type as any); setModalTitle(title); setModalOptions(options); setModalCallback(() => callback); setIsSelectionModalOpen(true);
  };

  const handleCountryChange = (countryCode: string) => {
    const country = intlCountries.find(c => c.code === countryCode) || SUPPORTED_COUNTRIES.find(c => c.code === countryCode);
    if (country) { 
        setActiveCountry(country); 
        if (country.code !== "NG") setActiveTab("pay");
        handleResetService(SERVICES[0]); 
    }
  };

  const getCurrentProviderKey = () => {
    if (activeTab === "bank") return selectedBank?.variation_code;
    if (activeTab === "education") return educationProvider;
    if (activeTab === "pay") {
      if (activeService.id === "AIRTIME") return telecomProvider;
      if (activeService.id === "INTERNET") return internetProvider;
      if (activeService.id === "ELECTRICITY") return `${elecProvider}-${meterType}`;
      if (activeService.id === "CABLE") return cableProvider;
    }
    return null;
  };

  const saveBeneficiary = (account: string, name: string | null) => {
    if (!address) return; 
    const key = getCurrentProviderKey();
    if (!key) return;

    setBeneficiaries(prev => {
      const currentList = prev[key] || [];
      const filteredList = currentList.filter(b => b.account !== account);
      const newList = [{ account, name }, ...filteredList].slice(0, 4); 
      const newStorage = { ...prev, [key]: newList };
      localStorage.setItem(`abapay_beneficiaries_${address}`, JSON.stringify(newStorage));
      return newStorage;
    });
  };

  const removeBeneficiary = (accountToRemove: string) => {
    if (!address) return;
    const key = getCurrentProviderKey();
    if (!key) return;

    setBeneficiaries(prev => {
      const currentList = prev[key] || [];
      const newList = currentList.filter(b => b.account !== accountToRemove);
      const newStorage = { ...prev, [key]: newList };
      localStorage.setItem(`abapay_beneficiaries_${address}`, JSON.stringify(newStorage));
      return newStorage;
    });
  };

  const handleShareReceipt = async () => {
    const receiptText = `🧾 AbaPay Receipt\n\nDate: ${selectedReceipt?.date}\nStatus: ${selectedReceipt?.status}\nProduct: ${selectedReceipt?.network} ${selectedReceipt?.service}\nRecipient: ${selectedReceipt?.account}\nAmount Paid: ₦${selectedReceipt?.amountNaira}\nCrypto Used: ${selectedReceipt?.amountCrypto} ${selectedReceipt?.tokenUsed}\nTx Hash: ${selectedReceipt?.txHash}\n\nSecured by Celo Network`;
    if (navigator.share) { try { await navigator.share({ title: 'Receipt', text: receiptText }); } catch (err) {} } 
    else { try { await navigator.clipboard.writeText(receiptText); showToast("Copied!", "Receipt details copied to clipboard.", "success"); } catch (err) {} }
  };

  const handleSendSupport = async () => {
    if (!supportMessage.trim()) return showToast("Error", "Please enter a message.", "error");
    setIsSendingSupport(true);
    try {
      const formData = new FormData();
      formData.append("message", supportMessage);
      if (address) formData.append("userAddress", address);
      if (supportTxHash) formData.append("txHash", supportTxHash);
      if (supportFile) formData.append("file", supportFile);

      const res = await fetch('/api/support', { method: 'POST', body: formData });
      const data = await res.json();
      if (data.success) {
        showToast("Ticket Sent", data.message, "success");
        setIsSupportOpen(false); setSupportMessage(""); setSupportFile(null);
      } else { showToast("Error", data.message || "Failed to send ticket", "error"); }
    } catch (e) { showToast("Error", "Network error. Failed to send ticket.", "error"); } 
    finally { setIsSendingSupport(false); }
  };

  const fetchBanksManual = async () => {
    setIsFetchingBanks(true);
    try {
      const res = await fetch(`/api/variations?serviceID=bank-deposit`);
      const data = await res.json();
      if (data.code === '011' || !data.content || !data.content.variations) {
        setBankVariations([{ variation_code: 'access', name: 'ACCESS BANK PLC' }, { variation_code: 'firstbank', name: 'FIRST BANK OF NIGERIA PLC' }, { variation_code: 'gtb', name: 'GTBANK PLC' }, { variation_code: 'opay', name: 'OPAY' }, { variation_code: 'moniepoint', name: 'MONIEPOINT MICROFINANCE BANK' }, { variation_code: 'uba', name: 'UBA - UNITED BANK FOR AFRICA PLC' }, { variation_code: 'zenith', name: 'ZENITH BANK PLC' }]);
        return;
      }
      let banksArr = extractVtpassArray(data);
      if (banksArr && Array.isArray(banksArr) && banksArr.length > 0) setBankVariations(banksArr.sort((a: any, b: any) => (a.name || "").localeCompare(b.name || "")));
      else throw new Error("Empty");
    } catch (e) {
      setBankVariations([{ variation_code: 'access', name: 'ACCESS BANK PLC' }, { variation_code: 'gtb', name: 'GTBANK PLC' }, { variation_code: 'opay', name: 'OPAY' }, { variation_code: 'moniepoint', name: 'MONIEPOINT MICROFINANCE BANK' }, { variation_code: 'zenith', name: 'ZENITH BANK PLC' }]);
    } finally { setIsFetchingBanks(false); }
  };

  const verifyMerchant = async () => {
    setIsVerifying(true); setCustomerName(null); setCableCurrentBouquet(null); setCableRenewAmount(null); setInternetAccountId(null);
    setMeterAddress(null); setDynamicElecMin(1000); setMeterAccountType(null); 

    try {
        let serviceID = ""; let reqType = undefined;
        if (activeTab === "bank") { serviceID = "bank-deposit"; reqType = selectedBank?.variation_code; } 
        else if (activeTab === "education" && educationProvider === "jamb") { serviceID = "jamb"; reqType = selectedEducationPlan?.variation_code; } 
        else { 
          serviceID = activeService.id === "ELECTRICITY" ? elecProvider : activeService.id === "INTERNET" ? internetProvider : cableProvider; 
          reqType = activeService.id === "ELECTRICITY" ? meterType : undefined; 
        }

        const res = await fetch(`/api/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ billersCode: accountNumber, serviceID: serviceID, type: reqType }) });
        const data = await res.json();

        if (data.code === '000') {
          setCustomerName(data.content.Customer_Name || data.content.account_name || data.content.name);
          if (data.content.Address) setMeterAddress(data.content.Address);
          if (data.content.Min_Purchase_Amount) setDynamicElecMin(Number(data.content.Min_Purchase_Amount));
          if (data.content.Customer_Account_Type) setMeterAccountType(data.content.Customer_Account_Type);

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

  const processBlockchainPayment = async () => {
    if (!address || !client) return setStatus("Connect Wallet First");
    if (parseFloat(cryptoToCharge) > parseFloat(walletBalance)) return setStatus(`Insufficient ${selectedToken.symbol} Balance.`);

    let activeCooldownKey: string | null = null; 

    if (activeTab === "pay" && activeService.id === "ELECTRICITY" && !isInternational) {
      const cooldownKey = `abapay_elec_${address}_${elecProvider}_${accountNumber}_${nairaAmount}`;
      const lastTxTime = localStorage.getItem(cooldownKey);
      if (lastTxTime) {
        const timeSinceLast = new Date().getTime() - parseInt(lastTxTime);
        if (timeSinceLast < 300000) { setStatus("Duplicate detected. Please wait."); return; }
      }
      localStorage.setItem(cooldownKey, new Date().getTime().toString());
      activeCooldownKey = cooldownKey; 
    }

    setIsProcessing(true); setStatus("Initiating Blockchain Escrow...");

    try {
      try {
        const currentChainId = await client.getChainId();
        if (currentChainId !== activeChain.id) await client.switchChain({ id: activeChain.id });
      } catch (switchError) { await client.addChain({ chain: activeChain }); }

      const valueInWei = parseUnits(cryptoToCharge, selectedToken.decimals);
      const tokenAddress = isMainnet ? selectedToken.mainnet : selectedToken.sepolia;
      const publicClient = createPublicClient({ chain: activeChain, transport: http(undefined, { fetchOptions: { cache: 'no-store' } }), pollingInterval: 4000 });
      const isMiniPay = typeof window !== "undefined" && !!(window as any).ethereum?.isMiniPay;

      const txConfig: any = { account: address as `0x${string}` };
      if (!isMiniPay) txConfig.feeCurrency = GAS_CURRENCY as `0x${string}`; 

      setStatus("Verifying permissions...");
      const currentAllowance = await publicClient.readContract({ address: tokenAddress as `0x${string}`, abi: ERC20_ABI, functionName: 'allowance', args: [address, ABAPAY_CONTRACT], blockTag: 'latest' }) as bigint;

      if (currentAllowance < valueInWei) {
          if (currentAllowance > BigInt(0) && selectedToken.symbol === "USD₮") {
              const resetHash = await client.writeContract({ address: tokenAddress as `0x${string}`, abi: ERC20_ABI, functionName: 'approve', args: [ABAPAY_CONTRACT, BigInt(0)], ...txConfig });
              await publicClient.waitForTransactionReceipt({ hash: resetHash });
          }
          setStatus("Awaiting token approval...");
          const approvalHash = await client.writeContract({ address: tokenAddress as `0x${string}`, abi: ERC20_ABI, functionName: 'approve', args: [ABAPAY_CONTRACT, parseUnits("100000", selectedToken.decimals)], ...txConfig });
          await publicClient.waitForTransactionReceipt({ hash: approvalHash, confirmations: 1 });
      }

      setStatus("Please sign the final payment...");

      let vtpassServiceID = ""; let displayNetwork = ""; let finalVariationCode = 'prepaid'; let payloadBillersCode = accountNumber; let uiCategory = "";

      if (isInternational) {
          vtpassServiceID = "foreign-airtime"; displayNetwork = selectedIntlOperator.name; finalVariationCode = selectedIntlVariation.variation_code; uiCategory = `INTL ${selectedIntlProduct.name.toUpperCase()}`;
      } else if (activeTab === "bank") {
        vtpassServiceID = "bank-deposit"; displayNetwork = selectedBank.name; finalVariationCode = selectedBank.variation_code; uiCategory = "BANK";
      } else if (activeTab === "education") {
        vtpassServiceID = educationProvider; displayNetwork = educationProvider; finalVariationCode = selectedEducationPlan?.variation_code || 'none'; uiCategory = "EDUCATION"; payloadBillersCode = educationProvider === "jamb" ? accountNumber : customerPhone;
      } else {
        uiCategory = activeService.id;
        if (activeService.id === "ELECTRICITY") { vtpassServiceID = elecProvider; displayNetwork = elecProvider; finalVariationCode = meterType; } 
        else if (activeService.id === "CABLE") { vtpassServiceID = cableProvider; displayNetwork = cableProvider; finalVariationCode = (['dstv', 'gotv'].includes(cableProvider) && cableSubscriptionType === 'renew') ? 'none' : selectedCablePlan?.variation_code || 'none'; } 
        else if (activeService.id === "INTERNET") { vtpassServiceID = internetProvider; displayNetwork = internetProvider; finalVariationCode = selectedInternetPlan?.variation_code || 'none'; payloadBillersCode = internetProvider === 'smile-direct' ? (internetAccountId || accountNumber) : accountNumber; } 
        else { vtpassServiceID = telecomProvider; displayNetwork = telecomProvider; }
      }

      const realNonce = await publicClient.getTransactionCount({ address: address as `0x${string}`, blockTag: 'latest' });
      const hash = await client.writeContract({ address: ABAPAY_CONTRACT, abi: ABAPAY_ABI, functionName: 'payBill', args: [tokenAddress, vtpassServiceID, payloadBillersCode, valueInWei], nonce: realNonce, ...txConfig });
      setStatus(`Secured. Processing...`);

      const backendPayload = {
        serviceID: vtpassServiceID, serviceCategory: uiCategory, network: displayNetwork.toUpperCase(), billersCode: payloadBillersCode, amount: cryptoToCharge, 
        nairaAmount: calculatedNairaAmount, token: selectedToken.symbol, txHash: hash, variation_code: finalVariationCode, 
        phone: customerPhone || accountNumber, email: customerEmail, wallet_address: address, 
        subscription_type: activeTab === "pay" && activeService.id === "CABLE" && ['dstv', 'gotv'].includes(cableProvider) ? cableSubscriptionType : undefined,
        meter_account_type: meterAccountType, operator_id: isInternational ? selectedIntlOperator?.operator_id : undefined, country_code: isInternational ? activeCountry.code : undefined, product_type_id: isInternational ? selectedIntlProduct?.product_type_id : undefined
      };

      const newTx: any = { 
          id: hash.slice(0,8), date: new Date().toLocaleString(), status: "PENDING", 
          amountNaira: isInternational ? `${intlCurrency || activeCountry.code} ${displayForeignAmount}` : calculatedNairaAmount, 
          amountCrypto: cryptoToCharge, tokenUsed: selectedToken.symbol, service: uiCategory, network: displayNetwork.toUpperCase(), txHash: hash, account: payloadBillersCode 
      };

      const res = await fetch('/api/pay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(backendPayload) });
      const result = await res.json();

      saveBeneficiary(accountNumber, customerName);
      handleResetService(SERVICES[0]);

            if (result.success) {
        if (result.message && result.message.toLowerCase().includes("processing")) {
           setStatus("Transaction Processing...");
           newTx.status = "PENDING";
           showToast("Transaction Pending", result.message, "success");
        } else {
           setStatus("Success! Token/Ref Dispatched."); 
           newTx.status = "SUCCESS"; 

           if (result.earnedPoints && result.earnedPoints > 0) {
               window.dispatchEvent(new CustomEvent('abapoints-awarded', { detail: result.earnedPoints }));
               showToast("Transaction Successful", `Payment confirmed! You earned +${result.earnedPoints.toFixed(2).replace(/\.00$/, '')} AbaPoints ✨`, "success");
           } else {
               showToast("Transaction Successful", "Your transaction has been successfully processed.", "success");
           }
        }
        newTx.purchased_code = result.purchased_code; newTx.units = result.units; newTx.request_id = result.data?.requestId;
      } else {
        setStatus(`Error: ${result.message || 'Transaction Failed'}`); newTx.status = "FAILED_VENDING";
      }

      const updatedHistory = [newTx, ...transactions];
      setTransactions(updatedHistory); localStorage.setItem(`abapay_history_${address}`, JSON.stringify(updatedHistory));
      setCurrentPage(1);

      const balanceWei = await publicClient.readContract({ address: tokenAddress as `0x${string}`, abi: ERC20_ABI, functionName: 'balanceOf', args: [address] });
      setWalletBalance(parseFloat(formatUnits(balanceWei as bigint, selectedToken.decimals)).toFixed(4));
    } catch (e: any) { 
        if (activeCooldownKey) localStorage.removeItem(activeCooldownKey);
        setStatus(`Error: ${e.shortMessage?.slice(0, 40) || "Transaction Cancelled"}`); 
    } finally { setIsProcessing(false); }
  };

  useEffect(() => { const timer = setTimeout(() => setIsInitiallyLoading(false), 2000); return () => clearTimeout(timer); }, []);
  useEffect(() => { if (status && !isProcessing) { const timer = setTimeout(() => setStatus(""), 5000); return () => clearTimeout(timer); } }, [status, isProcessing]);

  useEffect(() => {
    let intervalId: NodeJS.Timeout;
    async function initSystem() {
      const fetchSettings = async () => {
          try { 
              const { data: settingsData } = await supabase.from('platform_settings').select('exchange_rate, kill_switches').eq('id', 1).single(); 
              if (settingsData) {
                  if (settingsData.exchange_rate) setExchangeRate(Number(settingsData.exchange_rate)); 
                  if (settingsData.kill_switches) setKillSwitches(settingsData.kill_switches);
              }
          } catch (e) {}
      };
      await fetchSettings(); intervalId = setInterval(fetchSettings, 15000); 

      try {
        if (typeof window !== "undefined" && (window as any).ethereum) {
          const eth = (window as any).ethereum;
          const walletClient = createWalletClient({ chain: activeChain, transport: custom(eth) });
          walletClient.requestAddresses().then(([acc]) => { setAddress(acc); setClient(walletClient); }).catch(() => {});
        }
      } catch (e) {}
    }
    initSystem();
    return () => { if (intervalId) clearInterval(intervalId); };
  }, [activeChain]);

  useEffect(() => {
    if (!address) { setTransactions([]); return; }
    try { const savedLocalHistory = localStorage.getItem(`abapay_history_${address}`); if (savedLocalHistory) setTransactions(JSON.parse(savedLocalHistory)); } catch (e) {}

    async function fetchCloudHistory() {
      try {
        const sixMonthsAgo = new Date(); sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
        const { data } = await supabase.from('transactions').select('*').eq('wallet_address', address).gte('created_at', sixMonthsAgo.toISOString()).order('created_at', { ascending: false });
        if (data && data.length > 0) {
          const cloudHistory = data.map((tx: any) => ({ 
             id: tx.tx_hash.slice(0, 8), date: new Date(tx.created_at).toLocaleString(), status: tx.status, 
             amountNaira: tx.amount_naira.toString(), amountCrypto: tx.amount_usdt.toString(), 
             tokenUsed: tx.token_used || "USD₮", service: tx.service_category, network: tx.network, 
             txHash: tx.tx_hash, account: tx.account_number, refund_hash: tx.refund_hash, 
             purchased_code: tx.purchased_code, request_id: tx.request_id, units: tx.units 
          }));
          setTransactions(cloudHistory); localStorage.setItem(`abapay_history_${address}`, JSON.stringify(cloudHistory));
        }
      } catch (e) {}
    }
    fetchCloudHistory();
  }, [address]);

  useEffect(() => {
    if (!address) { setBeneficiaries({}); return; }
    try { const saved = localStorage.getItem(`abapay_beneficiaries_${address}`); if (saved) setBeneficiaries(JSON.parse(saved)); else setBeneficiaries({}); } catch (e) {}
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
    fetch('/api/intl?action=countries')
      .then(res => res.json())
      .then(data => {
          const countriesArr = extractVtpassArray(data);
          if (countriesArr && countriesArr.length > 0) {
              const fetched = countriesArr.map((c: any) => ({ code: c.code || c.country_code || c.id, name: c.name || c.country || c.title })).filter((c:any) => c.code && c.name);
              const merged = [...SUPPORTED_COUNTRIES.filter(c=>!c.disabled), ...fetched.filter((c:any) => c.code !== "NG")];
              setIntlCountries(merged);
          } else {
              setIntlCountries(SUPPORTED_COUNTRIES.filter(c=>!c.disabled));
          }
      })
      .catch(()=>setIntlCountries(SUPPORTED_COUNTRIES.filter(c=>!c.disabled)));
  }, []);

  useEffect(() => {
    if (isInternational) {
        setIsIntlLoading(true);
        fetch(`/api/intl?action=products&code=${activeCountry.code}`)
          .then(res => res.json())
          .then(data => {
              const arr = extractVtpassArray(data);
              if (arr && arr.length > 0) setIntlProductTypes(arr);
              else setIntlProductTypes([]);
          })
          .catch(()=>setIntlProductTypes([]))
          .finally(()=>setIsIntlLoading(false));
    }
  }, [activeCountry, isInternational]);

  useEffect(() => {
    if (isInternational && selectedIntlProduct) {
        const typeId = selectedIntlProduct.product_type_id || selectedIntlProduct.id;
        setIsIntlLoading(true); setIntlOperators([]); setIntlVariations([]); setSelectedIntlOperator(null); setSelectedIntlVariation(null);
        fetch(`/api/intl?action=operators&code=${activeCountry.code}&type_id=${typeId}`)
          .then(res => res.json())
          .then(data => {
              const arr = extractVtpassArray(data);
              if (arr && arr.length > 0) setIntlOperators(arr);
          })
          .catch(()=>setIntlOperators([]))
          .finally(()=>setIsIntlLoading(false));
    }
  }, [selectedIntlProduct, activeCountry, isInternational]);

  useEffect(() => {
    if (isInternational && selectedIntlOperator && selectedIntlProduct) {
        const operatorId = selectedIntlOperator.operator_id || selectedIntlOperator.id;
        const typeId = selectedIntlProduct.product_type_id || selectedIntlProduct.id;
        setIsIntlLoading(true); setIntlVariations([]); setSelectedIntlVariation(null); setIntlCurrency("");
        
        fetch(`/api/intl?action=variations&operator_id=${operatorId}&type_id=${typeId}`)
          .then(res => res.json())
          .then(data => {
              if (data?.content?.Currency || data?.content?.currency) {
                  setIntlCurrency(data.content.Currency || data.content.currency);
              } else if (data?.Currency || data?.currency) {
                  setIntlCurrency(data.Currency || data.currency);
              }
              const arr = extractVtpassArray(data);
              if (arr && arr.length > 0) setIntlVariations(arr);
          })
          .catch(()=>setIntlVariations([]))
          .finally(()=>setIsIntlLoading(false));
    }
  }, [selectedIntlOperator, selectedIntlProduct, isInternational]);

  useEffect(() => {
    if (activeTab === "education" && !isInternational) {
      const fetchEducation = async () => {
        setEducationVariations([]);
        try {
          const res = await fetch(`/api/variations?serviceID=${educationProvider}`);
          const data = await res.json();
          if (data.code === '011') setEducationVariations([]); 
          else setEducationVariations(extractVtpassArray(data) || []);
        } catch (e) { setEducationVariations([]); }
      };
      fetchEducation();
    }
  }, [activeTab, educationProvider, isInternational]);

  useEffect(() => {
    if (activeTab !== "pay" || isInternational) return;
    if (activeService.id === "CABLE") {
      const fetchVariations = async () => { 
        try { 
          const res = await fetch(`/api/variations?serviceID=${cableProvider}`); 
          const data = await res.json(); 
          if (data.code === '011') setCableVariations([]); 
          else setCableVariations(extractVtpassArray(data) || []); 
        } catch (e) { setCableVariations([]); } 
      }; 
      fetchVariations();
    } else if (activeService.id === "INTERNET") {
      const fetchInternetVariations = async () => { 
        setInternetVariations([]); 
        try { 
          const res = await fetch(`/api/variations?serviceID=${internetProvider}`); 
          const data = await res.json(); 
          if (data.code === '011' || data.error) setInternetVariations([]); 
          else setInternetVariations(extractVtpassArray(data) || []); 
        } catch (e) { setInternetVariations([]); } 
      }; 
      fetchInternetVariations();
    }
  }, [activeTab, activeService.id, cableProvider, internetProvider, isInternational]);

  useEffect(() => {
    if (activeTab === "pay" && !isInternational) {
      if (activeService.id === "AIRTIME" && accountNumber.length >= 4) {
        const prefix = accountNumber.substring(0, 4);
        if (["0803","0806","0810","0813","0814","0816","0903","0906","0913","0916","0703","0706"].includes(prefix)) setTelecomProvider("mtn");
        else if (["0802","0808","0812","0902","0907","0912","0701","0708"].includes(prefix)) setTelecomProvider("airtel");
        else if (["0805","0807","0811","0905","0705","0915"].includes(prefix)) setTelecomProvider("glo");
        else if (["0809","0817","0818","0908","0909"].includes(prefix)) setTelecomProvider("etisalat");
      }
      if (activeService.id === "INTERNET" && internetProvider.includes("-data") && accountNumber.length >= 4) {
        const prefix = accountNumber.substring(0, 4);
        if (["0803","0806","0810","0813","0814","0816","0903","0906","0913","0916","0703","0706"].includes(prefix)) setInternetProvider("mtn-data");
        else if (["0802","0808","0812","0902","0907","0912","0701","0708"].includes(prefix)) setInternetProvider("airtel-data");
        else if (["0805","0807","0811","0905","0705","0915"].includes(prefix)) setInternetProvider("glo-data");
        else if (["0809","0817","0818","0908","0909"].includes(prefix)) setInternetProvider("etisalat-data");
      }
    }
  }, [accountNumber, activeService.id, activeTab, internetProvider, isInternational]);

      useEffect(() => {
    // ⚡ DEBOUNCER: Wait 800ms after the user stops typing before verifying
    const timeoutId = setTimeout(() => {
      if (activeTab === "bank") { 
          if (accountNumber.length === 10 && selectedBank) verifyMerchant(); 
          else { setCustomerName(null); setMeterAddress(null); setDynamicElecMin(1000); setMeterAccountType(null); } 
      } 
      else if (activeTab === "education" && educationProvider === "jamb") {
         if (accountNumber.length >= 10 && selectedEducationPlan) verifyMerchant(); 
         else { setCustomerName(null); setMeterAddress(null); setDynamicElecMin(1000); setMeterAccountType(null); }
      }
      else if (activeTab === "pay" && !isInternational) {
         if (activeService.id === "ELECTRICITY" && accountNumber.length >= 10) verifyMerchant();
         else if (activeService.id === "CABLE" && cableProvider !== "showmax" && accountNumber.length >= 10) verifyMerchant();
         else if (activeService.id === "INTERNET" && internetProvider === "smile-direct" && accountNumber.includes('@') && accountNumber.includes('.')) verifyMerchant(); 
         else { setCustomerName(null); setMeterAddress(null); setDynamicElecMin(1000); setMeterAccountType(null); }
      }
    }, 800); // 800 millisecond delay

    // If the user types another number before 800ms, cancel the previous check
    return () => clearTimeout(timeoutId);
  }, [accountNumber, elecProvider, cableProvider, activeService.id, meterType, selectedBank, internetProvider, activeTab, educationProvider, selectedEducationPlan, isInternational]);

  // ⚡ PASTE IT RIGHT HERE ⚡
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

  // The UI starts right below it!
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

      {/* ⚡ CONFIRMATION MODAL ⚡ */}
      {isConfirmModalOpen && (
        <div className="fixed inset-0 z-[300] flex items-end sm:items-center justify-center bg-slate-900/60 backdrop-blur-md animate-in fade-in duration-200">
           <div className="bg-white w-full max-w-md rounded-t-[2.5rem] sm:rounded-[2.5rem] p-6 pb-10 sm:pb-6 shadow-2xl relative animate-in slide-in-from-bottom-10 sm:zoom-in-95 duration-300">
              <div className="w-12 h-1.5 bg-slate-200 rounded-full mx-auto mb-6 sm:hidden"></div>

              <div className="flex justify-between items-center mb-6">
                 <h3 className="text-xl font-black text-slate-900 tracking-tight">Confirm Payment</h3>
                 <button onClick={() => setIsConfirmModalOpen(false)} className="bg-slate-100 p-2 rounded-full text-slate-500 hover:bg-slate-200 transition-colors"><XCircle size={20}/></button>
              </div>

              <div className="text-center mb-8">
                 <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Total Payable</p>
                 
                 <h2 className="text-4xl font-black text-slate-900 mb-2">
                    {isInternational ? `${intlCurrency || activeCountry.code} ${displayForeignAmount}` : `₦${(parseFloat(calculatedNairaAmount || "0") + currentFee).toLocaleString()}`}
                 </h2>

                 <div className="flex items-center justify-center gap-1.5 text-emerald-600 font-bold bg-emerald-50 w-max mx-auto px-4 py-1.5 rounded-full text-sm shadow-inner">
                    <img src={selectedToken.logo} alt="token" className="w-4 h-4 rounded-full"/>
                    {cryptoToCharge} {selectedToken.symbol}
                 </div>
              </div>

              <div className="bg-slate-50 border border-slate-100 rounded-3xl p-5 space-y-4 mb-8 shadow-sm">
                 <div className="flex justify-between items-center">
                    <span className="text-xs font-bold text-slate-500">Service</span>
                    <span className="text-sm font-black text-slate-900 text-right">{checkoutDetails.title}</span>
                 </div>
                 <div className="flex justify-between items-center">
                    <span className="text-xs font-bold text-slate-500">{checkoutDetails.recipientLabel}</span>
                    <span className="text-sm font-black text-slate-900 text-right">{checkoutDetails.recipient}</span>
                 </div>
                 {customerName && (
                     <div className="flex justify-between items-center">
                        <span className="text-xs font-bold text-slate-500">Customer</span>
                        <span className="text-sm font-black text-slate-900 truncate max-w-[180px] text-right">{customerName}</span>
                     </div>
                 )}
                 <div className="flex justify-between items-center pt-4 border-t border-slate-200/60 mt-2">
                    <span className="text-xs font-bold text-slate-500">Processing Fee</span>
                    <span className={`text-sm font-black ${currentFee > 0 ? 'text-orange-500' : 'text-emerald-500'}`}>
                       {currentFee > 0 ? `₦${currentFee}` : 'Free'}
                    </span>
                 </div>
              </div>

              <button 
                  onClick={() => { setIsConfirmModalOpen(false); processBlockchainPayment(); }}
                  className="w-full bg-slate-900 hover:bg-black text-white font-black py-5 rounded-2xl flex items-center justify-center gap-2.5 transition-all active:scale-95 shadow-xl shadow-slate-900/20 text-lg tracking-tight"
              >
                  <ShieldCheck size={22} className="text-emerald-400" />
                  CONFIRM & PAY
              </button>
           </div>
        </div>
      )}

      {isSupportOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm animate-in fade-in">
           <div className="bg-white w-full max-w-md rounded-[2rem] p-6 shadow-2xl relative animate-in zoom-in-95">
              <button onClick={() => { setIsSupportOpen(false); setSupportFile(null); setSupportMessage(""); }} className="absolute top-4 right-4 bg-slate-100 p-2 rounded-full text-slate-500 hover:bg-slate-200 transition-colors"><XCircle size={20}/></button>
              <h3 className="text-xl font-black text-slate-900 mb-2">Need Help?</h3>
              {supportTxHash && <p className="text-xs text-slate-500 mb-4">Transaction Ref: <span className="font-mono bg-slate-100 px-1.5 py-0.5 rounded text-slate-700">{supportTxHash.slice(0, 15)}...</span></p>}

              <textarea 
                  className="w-full bg-slate-50 border border-slate-200 p-4 rounded-xl text-sm outline-none focus:border-emerald-500 min-h-[100px] mb-4 font-medium" 
                  placeholder="Describe your issue so our admins can assist you..." 
                  value={supportMessage} 
                  onChange={(e) => setSupportMessage(e.target.value)} 
              />

              <div className="mb-4">
                 <label className="block text-xs font-bold text-slate-500 mb-2">Attach Screenshot (Optional)</label>
                 <input 
                    type="file" 
                    accept="image/*"
                    onChange={(e) => setSupportFile(e.target.files ? e.target.files[0] : null)}
                    className="w-full text-sm text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-xs file:font-bold file:bg-emerald-50 file:text-emerald-700 hover:file:bg-emerald-100 transition-colors cursor-pointer"
                 />
              </div>

              <button 
                  onClick={handleSendSupport}
                  disabled={isSendingSupport || !supportMessage.trim()}
                  className="w-full bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 disabled:bg-slate-300 text-white font-black py-4 rounded-xl transition-colors tracking-tight flex justify-center items-center gap-2"
              >
                  {isSendingSupport ? <><Loader2 size={18} className="animate-spin"/> SENDING...</> : "SEND TICKET"}
              </button>
           </div>
        </div>
      )}

      <ReceiptModal receipt={selectedReceipt} isMainnet={isMainnet} onClose={() => setSelectedReceipt(null)} onShare={handleShareReceipt} onSupport={() => { setSupportTxHash(selectedReceipt.txHash); setSupportMessage(""); setSelectedReceipt(null); setIsSupportOpen(true); }} />
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

        {/* ⚡ HEADER ⚡ */}
        <div className="flex justify-between items-center bg-white p-4 rounded-3xl shadow-sm border border-slate-100 mb-6">
          <div className="flex items-center gap-3">
            <img src="/logo.png" alt="AbaPay" className="h-10 w-auto object-contain" />
            <div className="flex flex-col">
              <span className="text-xl font-black text-slate-900 leading-none tracking-tight">AbaPay<span className="text-emerald-500">.</span></span>
              <span className="text-[8px] font-black uppercase text-slate-400 tracking-widest mt-1">Seamless Payments.</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <PointsBadge walletAddress={address || undefined} />
            <button 
              onClick={() => openSelectionModal('country', "Select Region", intlCountries.length ? intlCountries : SUPPORTED_COUNTRIES, handleCountryChange)}
              className="bg-slate-50 border border-slate-100 hover:border-emerald-200 px-3 py-1.5 rounded-xl flex items-center gap-2 transition-all shadow-sm active:scale-95"
            >
              <img 
                src={`https://flagcdn.com/w40/${activeCountry.code.toLowerCase()}.png`} 
                alt={activeCountry.code} 
                className="w-5 h-auto rounded-[2px] shadow-sm" 
                onError={(e) => { e.currentTarget.style.display = 'none'; }} 
              />
              <span className="text-[10px] font-black text-slate-700 uppercase tracking-widest">{activeCountry.code}</span>
              <ChevronDown size={14} className="text-slate-400" />
            </button>
          </div>
        </div>

        {/* THE TABS */}
        <div className="flex gap-2 bg-slate-200/50 p-1.5 rounded-2xl mb-6 shadow-inner overflow-x-auto no-scrollbar">
            <button onClick={() => handleTabSwitch("pay")} className={`flex-1 min-w-[75px] py-3 rounded-xl text-[10px] sm:text-xs font-black transition-all ${activeTab === 'pay' ? 'bg-white text-emerald-600 shadow-xl' : 'text-slate-500 hover:text-slate-700'}`}>BILLS</button>
            <button onClick={() => handleTabSwitch("bank")} disabled={isInternational} className={`flex-1 min-w-[75px] py-3 rounded-xl text-[10px] sm:text-xs font-black transition-all ${isInternational ? 'opacity-30 cursor-not-allowed' : activeTab === 'bank' ? 'bg-white text-emerald-600 shadow-xl' : 'text-slate-500 hover:text-slate-700'}`}>TRANSFER</button>
            <button onClick={() => handleTabSwitch("education")} disabled={isInternational} className={`flex-1 min-w-[75px] py-3 rounded-xl text-[10px] sm:text-xs font-black transition-all ${isInternational ? 'opacity-30 cursor-not-allowed' : activeTab === 'education' ? 'bg-white text-emerald-600 shadow-xl' : 'text-slate-500 hover:text-slate-700'}`}>EDUCATION</button>
            <button onClick={() => handleTabSwitch("history")} className={`flex-1 min-w-[75px] py-3 rounded-xl text-[10px] sm:text-xs font-black transition-all ${activeTab === 'history' ? 'bg-white text-emerald-600 shadow-xl' : 'text-slate-500 hover:text-slate-700'}`}>HISTORY</button>
        </div>


        {/* ======================================= */}
        {/* PAY BLOCK */}
        {/* ======================================= */}
        {activeTab === 'pay' && (
          <div className="bg-white border border-slate-100 rounded-[2.5rem] p-8 shadow-2xl shadow-emerald-900/10 animate-in fade-in zoom-in-95">
            
            {/* HIDE NON-AIRTIME TABS IF FOREIGN */}
            {!isInternational && (
                <div className="grid grid-cols-4 gap-2 pb-2 mb-4">
                    {SERVICES.filter(s => s.id !== 'BANK').map(s => (
                        <button 
                            key={s.id} 
                            onClick={() => handleResetService(s)}
                            className={`w-full p-2.5 rounded-xl border-2 transition-all flex flex-col items-center justify-center gap-1.5 ${
                                activeService.id === s.id ? 'border-emerald-500 bg-emerald-50/50 scale-100 shadow-sm' : 'border-slate-100 bg-white hover:bg-slate-50'
                            }`}
                        >
                            <s.icon size={18} className={s.color} />
                            <span className="text-[9px] font-black uppercase tracking-tight text-center">{s.name}</span>
                        </button>
                    ))}
                </div>
            )}

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
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-0.5">Balance</p>
                    <div className="flex items-center justify-end gap-1.5">
                      {isFetchingBalance ? <Loader2 size={14} className="animate-spin text-emerald-500"/> : <Coins size={14} className="text-emerald-500"/>}
                      <div className="flex flex-col items-end">
                        <p className="font-mono font-black text-sm text-slate-800 leading-none">{walletBalance}</p>
                        {!isFetchingBalance && <p className="text-[9px] font-bold text-slate-400 mt-1 tracking-tight">≈ ₦{walletBalanceNaira}</p>}
                      </div>
                    </div>
                  </div>
                </div>

                {/* ⚡ THE PROVIDER SELECTORS (LOCAL OR INTERNATIONAL) ⚡ */}
                <div className="animate-in slide-in-from-left-2 mb-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase mb-3 block">
                        {isInternational ? "Product Type" : "Provider"}
                    </label>

                                        {isInternational ? (
                        <>
                            <button 
                                onClick={() => {
                                    if (intlProductTypes.length === 0) return;
                                    
                                    // ⚡ FIX: Use raw SVG Data URIs so no external files are needed! ⚡
                                    const getIcon = (name: string) => name.toLowerCase().includes('data') 
                                        ? "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%230ea5e9' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M5 12.55a11 11 0 0 1 14.08 0'/%3E%3Cpath d='M1.42 9a16 16 0 0 1 21.16 0'/%3E%3Cpath d='M8.53 16.11a6 6 0 0 1 6.95 0'/%3E%3Cline x1='12' y1='20' x2='12.01' y2='20'/%3E%3C/svg%3E" 
                                        : "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%2310b981' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolygon points='13 2 3 14 12 14 11 22 21 10 12 10 13 2'/%3E%3C/svg%3E";

                                    openSelectionModal('standard', "Select Type", intlProductTypes.map(p => ({
                                        serviceID: p.product_type_id || p.id || p.name, 
                                        displayName: p.name,
                                        logo: getIcon(p.name)
                                    })), (val) => {
                                        setSelectedIntlProduct(intlProductTypes.find(p => (p.product_type_id || p.id || p.name) == val));
                                    });
                                }}
                                className="w-full bg-white border border-slate-200 p-4 rounded-2xl flex justify-between items-center hover:border-emerald-400 transition-colors shadow-sm mb-3"
                            >
                                <div className="flex items-center gap-3">
                                    {selectedIntlProduct && (
                                       <div className="w-10 h-10 shrink-0 rounded-full border border-slate-100 bg-emerald-50/50 flex items-center justify-center shadow-sm overflow-hidden">
                                           <img 
                                              src={selectedIntlProduct.name.toLowerCase().includes('data') 
                                                   ? "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%230ea5e9' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M5 12.55a11 11 0 0 1 14.08 0'/%3E%3Cpath d='M1.42 9a16 16 0 0 1 21.16 0'/%3E%3Cpath d='M8.53 16.11a6 6 0 0 1 6.95 0'/%3E%3Cline x1='12' y1='20' x2='12.01' y2='20'/%3E%3C/svg%3E" 
                                                   : "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%2310b981' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolygon points='13 2 3 14 12 14 11 22 21 10 12 10 13 2'/%3E%3C/svg%3E"} 
                                              className="w-5 h-5 object-contain" 
                                              alt="type" 
                                           />
                                       </div>
                                    )}
                                    <span className="text-sm font-black text-slate-900 tracking-tight uppercase">
                                        {selectedIntlProduct ? selectedIntlProduct.name : (isIntlLoading ? "Loading..." : "Select Product Type")}
                                    </span>
                                </div>
                                {isIntlLoading ? <Loader2 size={16} className="animate-spin"/> : <ChevronDown size={18} className="text-slate-400"/>}
                            </button>

                            {selectedIntlProduct && (
                                <>
                                    <label className="text-[10px] font-black text-slate-400 uppercase mb-3 block mt-4">Network Operator</label>
                                    <button 
                                        onClick={() => {
                                            if (intlOperators.length === 0) return;
                                            openSelectionModal('standard', "Select Network", intlOperators.map(p => ({
                                                serviceID: p.operator_id || p.id || p.name, 
                                                displayName: p.name,
                                                logo: p.operator_image || '/logo.png'
                                            })), (val) => {
                                                setSelectedIntlOperator(intlOperators.find(p => (p.operator_id || p.id || p.name) == val));
                                            });
                                        }}
                                        className="w-full bg-white border border-slate-200 p-4 rounded-2xl flex justify-between items-center hover:border-emerald-400 transition-colors shadow-sm"
                                    >
                                        <div className="flex items-center gap-3">
                                            {selectedIntlOperator && (
                                                <div className="w-10 h-10 shrink-0 rounded-full border border-slate-100 bg-white flex items-center justify-center shadow-sm overflow-hidden">
                                                    <img 
                                                       src={selectedIntlOperator.operator_image || '/logo.png'} 
                                                       alt="operator" 
                                                       className="w-8 h-8 object-contain" 
                                                       // ⚡ FIX: Add onError fallback to stop broken images! ⚡
                                                       onError={(e) => { e.currentTarget.src = '/logo.png'; }} 
                                                    />
                                                </div>
                                            )}
                                            <span className="text-sm font-black text-slate-900 tracking-tight uppercase">
                                                {selectedIntlOperator ? selectedIntlOperator.name : (isIntlLoading ? "Loading..." : "Select Operator")}
                                            </span>
                                        </div>
                                        {isIntlLoading ? <Loader2 size={16} className="animate-spin"/> : <ChevronDown size={18} className="text-slate-400"/>}
                                    </button>
                                </>
                            )}
                        </>
                    ) : (


                            {selectedIntlProduct && (
                                <>
                                    <label className="text-[10px] font-black text-slate-400 uppercase mb-3 block mt-4">Network Operator</label>
                                    <button 
                                        onClick={() => {
                                            if (intlOperators.length === 0) return;
                                            openSelectionModal('standard', "Select Network", intlOperators.map(p => ({
                                                serviceID: p.operator_id || p.id || p.name, 
                                                displayName: p.name,
                                                logo: p.operator_image || '/logo.png'
                                            })), (val) => {
                                                setSelectedIntlOperator(intlOperators.find(p => (p.operator_id || p.id || p.name) == val));
                                            });
                                        }}
                                        className="w-full bg-white border border-slate-200 p-4 rounded-2xl flex justify-between items-center hover:border-emerald-400 transition-colors shadow-sm"
                                    >
                                        <div className="flex items-center gap-3">
                                            {selectedIntlOperator && (
                                                <div className="w-10 h-10 shrink-0 rounded-full border border-slate-100 bg-white flex items-center justify-center shadow-sm overflow-hidden">
                                                    <img src={selectedIntlOperator.operator_image || '/logo.png'} alt="operator" className="w-8 h-8 object-contain" />
                                                </div>
                                            )}
                                            <span className="text-sm font-black text-slate-900 tracking-tight uppercase">
                                                {selectedIntlOperator ? selectedIntlOperator.name : (isIntlLoading ? "Loading..." : "Select Operator")}
                                            </span>
                                        </div>
                                        {isIntlLoading ? <Loader2 size={16} className="animate-spin"/> : <ChevronDown size={18} className="text-slate-400"/>}
                                    </button>
                                </>
                            )}
                        </>
                    ) : (
                        // LOCAL PROVIDERS
                        activeService.id === "INTERNET" ? (
                            <button onClick={() => openSelectionModal('provider', "Select Provider", INTERNET_PROVIDERS, (val) => handleProviderChange(val, 'internet'))} className="w-full bg-white border border-slate-200 p-4 rounded-2xl flex justify-between items-center hover:border-sky-400 transition-colors shadow-sm active:scale-[0.98]">
                                <div className="flex items-center gap-4">
                                    <div className="w-12 h-12 shrink-0 rounded-full border border-slate-100 bg-sky-50 flex items-center justify-center shadow-inner overflow-hidden"><img src={currentInternet?.logo || '/wifi.png'} alt={currentInternet?.displayName} className="w-full h-full object-contain" /></div>
                                    <span className="text-sm font-black text-slate-900 tracking-tight">{currentInternet?.displayName}</span>
                                </div><ChevronDown size={18} className="text-slate-400"/>
                            </button>
                        ) : activeService.id === "AIRTIME" ? (
                            <button 
                                onClick={() => {
                                    const optionsWithStatus = TELECOM_PROVIDERS.map(p => {
                                        const isMasterOff = killSwitches['MASTER_AIRTIME'] === false;
                                        const isProviderOff = killSwitches[`AIRTIME_${p.toLowerCase()}`] === false;
                                        return { 
                                            serviceID: p, 
                                            displayName: p === 'etisalat' ? '9MOBILE' : p.toUpperCase(), 
                                            logo: `/${p === 'etisalat' ? '9mobile' : p}.png`, 
                                            disabled: isMasterOff || isProviderOff 
                                        };
                                    });
                                    openSelectionModal('standard', "Select Network", optionsWithStatus, (val) => handleProviderChange(val, 'telecom'));
                                }}
                                className="w-full bg-white border border-slate-200 p-4 rounded-2xl flex justify-between items-center hover:border-emerald-400 transition-colors shadow-sm active:scale-[0.98]"
                            >
                                <div className="flex items-center gap-4">
                                    <div className="w-12 h-12 shrink-0 rounded-full border border-slate-100 bg-emerald-50 flex items-center justify-center shadow-inner overflow-hidden">
                                        <img src={`/${telecomProvider === 'etisalat' ? '9mobile' : telecomProvider}.png`} alt={telecomProvider} className="w-full h-full object-contain" onError={(e) => { e.currentTarget.src = '/logo.png'; }} />
                                    </div>
                                    <span className="text-sm font-black text-slate-900 tracking-tight uppercase">
                                        {telecomProvider === 'etisalat' ? '9MOBILE' : telecomProvider}
                                    </span>
                                </div>
                                <ChevronDown size={18} className="text-slate-400"/>
                            </button>
                        ) : activeService.id === "ELECTRICITY" ? (
                            <button onClick={() => openSelectionModal('provider', "Select Provider", ELECTRICITY_DISCOS, (val) => handleProviderChange(val, 'elec'))} className="w-full bg-white border border-slate-200 p-4 rounded-2xl flex justify-between items-center hover:border-orange-400 transition-colors shadow-sm active:scale-[0.98]">
                                <div className="flex items-center gap-4">
                                    <div className="w-12 h-12 shrink-0 rounded-full border border-slate-100 bg-white p-0.5 flex items-center justify-center shadow-inner overflow-hidden"><img src={currentDisco?.logo} alt={currentDisco?.displayName} className="w-full h-full object-contain" /></div>
                                    <span className="text-sm font-black text-slate-900 tracking-tight">{currentDisco?.displayName}</span>
                                </div><ChevronDown size={18} className="text-slate-400"/>
                            </button>
                        ) : (
                          <button onClick={() => openSelectionModal('provider', "Select Provider", CABLE_PROVIDERS_LIST, (val) => handleProviderChange(val, 'cable'))} className="w-full bg-white border border-slate-200 p-4 rounded-2xl flex justify-between items-center hover:border-pink-400 transition-colors shadow-sm active:scale-[0.98]">
                            <div className="flex items-center gap-4">
                                <div className="w-12 h-12 shrink-0 rounded-full border border-slate-100 bg-white p-0.5 flex items-center justify-center shadow-inner overflow-hidden"><img src={currentCable?.logo} alt={currentCable?.displayName} className="w-full h-full object-contain" /></div>
                                <span className="text-sm font-black text-slate-900 tracking-tight">{currentCable?.displayName}</span>
                            </div><ChevronDown size={18} className="text-slate-400"/>
                          </button>
                        )
                    )}

                    {(!isInternational && activeService.id === "ELECTRICITY") && (
                       <div className="flex gap-2 mt-4 p-1.5 bg-slate-100 rounded-2xl border border-slate-200 shadow-inner">
                          <button onClick={() => setMeterType("prepaid")} className={`flex-1 py-3 text-[11px] font-black uppercase rounded-xl transition-all ${meterType === "prepaid" ? "bg-white shadow-lg text-emerald-600" : "text-slate-500"}`}>Prepaid</button>
                          <button onClick={() => setMeterType("postpaid")} className={`flex-1 py-3 text-[11px] font-black uppercase rounded-xl transition-all ${meterType === "postpaid" ? "bg-white shadow-lg text-emerald-600" : "text-slate-500"}`}>Postpaid</button>
                       </div>
                    )}
                </div>

                                <div>
                    <label className="text-[10px] font-black text-slate-400 uppercase mb-2 flex justify-between">
                      {/* ⚡ DYNAMIC LABEL FIX ⚡ */}
                      <span>{checkoutDetails.recipientLabel}</span>
                      
                      {(activeService.id === "AIRTIME" || (activeService.id === "INTERNET" && internetProvider.includes('-data')) || isInternational) && (
                        <span className={accountNumber.length >= (isInternational ? 6 : 11) ? "text-emerald-500" : "text-slate-400"}>
                            {isInternational ? `${accountNumber.length} digits` : `${accountNumber.length}/11`}
                        </span>
                      )}
                    </label>

                    <input 
                        type={activeService.id === "INTERNET" && internetProvider === 'smile-direct' ? "email" : "tel"} 
                        placeholder={
                            isInternational ? `Enter ${activeCountry.name} Number` :
                            activeService.id === "INTERNET" && internetProvider === 'smile-direct' ? "example@email.com" : 
                            activeService.id === "INTERNET" && internetProvider === 'spectranet' ? "Enter Spectranet ID" : 
                            "Enter Number"
                        }
                        maxLength={
                            isInternational ? 15 : 
                            activeService.id === "ELECTRICITY" ? 14 : 
                            activeService.id === "CABLE" ? 12 : 
                            (activeService.id === "INTERNET" && internetProvider === 'smile-direct') ? 50 : 
                            11 
                        }
                        className={`w-full bg-slate-50 border p-5 rounded-2xl font-black text-xl text-slate-800 outline-none transition-all ${
                          ((activeService.id === "AIRTIME" || (activeService.id === "INTERNET" && internetProvider.includes('-data'))) && accountNumber.length > 0 && accountNumber.length < 11 && !isInternational) ? "border-red-300" : "border-slate-100 focus:border-emerald-500"
                        }`}
                        value={accountNumber}
                        onChange={(e) => {
                            if (activeService.id === "INTERNET" && internetProvider === 'smile-direct') setAccountNumber(e.target.value);
                            else setAccountNumber(e.target.value.replace(/[^0-9]/g, ''));
                        }}
                    />
                    {isVerifying && <p className="text-[10px] text-blue-500 font-bold mt-2 animate-pulse flex items-center gap-1.5"><Loader2 size={12} className="animate-spin"/> Verifying...</p>}

                    {(() => {
                        const key = getCurrentProviderKey();
                        const list = key ? beneficiaries[key] : [];
                        if (!list || list.length === 0) return null;
                        return (
                            <div className="flex gap-2 overflow-x-auto no-scrollbar mt-3 animate-in fade-in items-center">
                                <span className="text-[9px] font-black uppercase text-slate-400 shrink-0">Recent:</span>
                                {list.map((ben, idx) => (
                                    <button 
                                        key={idx}
                                        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
                                        style={{ WebkitTouchCallout: 'none', WebkitUserSelect: 'none', userSelect: 'none' }}
                                        onTouchStart={() => {
                                            isLongPress.current = false;
                                            pressTimer.current = setTimeout(() => {
                                                isLongPress.current = true;
                                                setActiveDeleteAccount(ben.account);
                                                if (navigator.vibrate) navigator.vibrate(50);
                                                setTimeout(() => setActiveDeleteAccount(null), 4000);
                                            }, 500); 
                                        }}
                                        onTouchEnd={() => { if (pressTimer.current) clearTimeout(pressTimer.current); }}
                                        onTouchMove={() => { if (pressTimer.current) clearTimeout(pressTimer.current); }}
                                        onMouseDown={() => {
                                            isLongPress.current = false;
                                            pressTimer.current = setTimeout(() => {
                                                isLongPress.current = true;
                                                setActiveDeleteAccount(ben.account);
                                                setTimeout(() => setActiveDeleteAccount(null), 4000);
                                            }, 500); 
                                        }}
                                        onMouseUp={() => { if (pressTimer.current) clearTimeout(pressTimer.current); }}
                                        onMouseLeave={() => { if (pressTimer.current) clearTimeout(pressTimer.current); }}
                                        onClick={(e) => {
                                            e.preventDefault();
                                            if (isLongPress.current) {
                                                isLongPress.current = false;
                                                return;
                                            }
                                            if (activeDeleteAccount === ben.account) {
                                                removeBeneficiary(ben.account);
                                                setActiveDeleteAccount(null);
                                            } else {
                                                setAccountNumber(ben.account);
                                                if (ben.name) setCustomerName(ben.name);
                                                setActiveDeleteAccount(null); 
                                            }
                                        }}
                                        className={`shrink-0 text-[10px] font-black py-1.5 px-3 rounded-full flex items-center gap-1.5 transition-all border outline-none select-none ${
                                            activeDeleteAccount === ben.account 
                                            ? 'bg-red-50 text-red-600 border-red-200' 
                                            : 'bg-slate-100 text-slate-600 border-slate-200 hover:bg-emerald-50 hover:text-emerald-700 hover:border-emerald-200' 
                                        }`}
                                    >
                                        {activeDeleteAccount === ben.account ? (
                                            <><XCircle size={12} className="animate-pulse" /> Delete</>
                                        ) : (
                                            <span>{ben.name ? ben.name.split(' ')[0] : ben.account}</span>
                                        )}
                                    </button>
                                ))}
                            </div>
                        );
                    })()}

                    {/* ⚡ VERIFIED BLOCK WITH ADDRESS ⚡ */}
                    {customerName && (activeService.id === "ELECTRICITY" || (activeService.id === "INTERNET" && internetProvider === 'smile-direct')) && (
                        <div className="mt-2 bg-emerald-500/10 p-4 rounded-xl border border-emerald-500/20 flex items-center gap-3 animate-in fade-in">
                            <CheckCircle2 size={18} className="text-emerald-600 shrink-0" />
                            <div className="flex-1">
                                <span className="text-sm font-black text-emerald-800 line-clamp-1">{customerName}</span>
                                {activeService.id === "ELECTRICITY" && meterAddress && (
                                     <p className="text-[10px] font-medium text-emerald-700 leading-tight mt-0.5 pr-2">{meterAddress}</p>
                                )}
                                <p className="text-[10px] font-black text-emerald-600 uppercase mt-0.5">Verified</p>
                            </div>
                        </div>
                    )}
                </div>

                {/* ⚡ INTERNATIONAL VARIATIONS / AMOUNTS ⚡ */}
                {isInternational && selectedIntlOperator && (
                    <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 shadow-sm animate-in fade-in slide-in-from-top-4">
                        {intlVariations.length === 0 ? (
                           <p className="text-center text-xs font-bold text-slate-400 py-4">No packages available.</p>
                        ) : (
                           selectedIntlVariation ? (
                               <div className="relative animate-in zoom-in-95 duration-200 mt-2">
                                  <button onClick={() => { setSelectedIntlVariation(null); setIntlFlexibleAmount(""); }} className="absolute -top-3 -right-3 bg-slate-200 text-slate-500 hover:text-slate-800 hover:bg-slate-300 rounded-full p-1 transition-all z-10 shadow-sm border border-white"><XCircle size={16}/></button>
                                  <div className="p-4 rounded-2xl border-2 border-emerald-500 bg-emerald-50 shadow-sm text-left">
                                     <p className="font-black text-slate-900 text-lg">{selectedIntlVariation.name}</p>
                                     {selectedIntlVariation.fixedPrice !== "Yes" && (
                                         <div className="mt-3 border-t border-emerald-200 pt-3">
                                            <p className="text-[10px] font-bold text-slate-500 mb-1 uppercase tracking-widest">Enter Amount to Send</p>
                                            <input 
                                                type="number" 
                                                placeholder="Amount" 
                                                className="w-full bg-white border border-emerald-200 p-3 rounded-xl font-black text-xl text-emerald-800 outline-none focus:border-emerald-500"
                                                value={intlFlexibleAmount}
                                                onChange={(e) => setIntlFlexibleAmount(e.target.value)}
                                            />
                                         </div>
                                     )}
                                     <div className="pt-3 mt-2 border-t border-emerald-200/50 flex justify-between items-end">
                                         {/* ⚡ HIDING NGN, SHOWING LOCAL CURRENCY ⚡ */}
                                         <p className="font-black text-emerald-600 text-xl">{intlCurrency || activeCountry.code} {displayForeignAmount}</p>
                                         <p className="text-[10px] text-slate-500 font-bold">{cryptoToCharge} {selectedToken.symbol}</p>
                                      </div>
                                  </div>
                               </div>
                           ) : (
                               <div className="grid grid-cols-1 gap-2 max-h-[30vh] overflow-y-auto pr-1">
                                  {intlVariations.map((plan) => {
                                      const rate = parseFloat(plan.variation_rate || "1");
                                      const foreignAmt = parseFloat(plan.variation_amount || "0");
                                      const isFixed = plan.fixedPrice === "Yes";
                                      
                                      let nairaEquivalent = 0;
                                      if (isFixed) {
                                          nairaEquivalent = parseFloat(plan.charged_amount || "0");
                                          if (nairaEquivalent <= 0) nairaEquivalent = foreignAmt * rate;
                                      }
                                      
                                      const cryptoCostEstimate = (nairaEquivalent / exchangeRate).toFixed(4);
                                      const cryptoRateEstimate = (rate / exchangeRate).toFixed(4);

                                      return (
                                        <button key={plan.variation_code} onClick={() => setSelectedIntlVariation(plan)} className="p-3 rounded-xl border border-slate-200 bg-white hover:border-emerald-300 transition-all text-left flex justify-between items-center group">
                                          <div>
                                            <p className="font-black text-slate-800 text-xs">{plan.name}</p>
                                            <p className="text-[9px] text-slate-400 font-bold mt-0.5">
                                                {isFixed ? `Cost: ${cryptoCostEstimate} ${selectedToken.symbol}` : `Rate: ~${cryptoRateEstimate} ${selectedToken.symbol} per ${intlCurrency || activeCountry.code}`}
                                            </p>
                                          </div>
                                          {/* ⚡ HIDING NGN, SHOWING LOCAL CURRENCY ⚡ */}
                                          <p className="font-black text-emerald-600 text-sm group-hover:scale-110 transition-transform">
                                            {isFixed ? `${intlCurrency || activeCountry.code} ${foreignAmt.toLocaleString()}` : "Flexible"}
                                          </p>
                                        </button>
                                      )
                                  })}
                               </div>
                           )
                        )}
                    </div>
                )}

                {/* ⚡ LOCAL VARIATIONS UI ⚡ */}
                {!isInternational && activeService.id === "INTERNET" && (
                  <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 shadow-sm animate-in fade-in slide-in-from-top-4">
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
                        <div className="mt-2">
                          {internetVariations.length === 0 ? (
                            <p className="text-center text-xs font-bold text-slate-400 py-4"><Loader2 className="animate-spin inline-block mr-2" size={14}/> Fetching Live Packages...</p>
                          ) : (
                             <DataVariationsUI 
                               variations={internetVariations} 
                               onSelectPlan={(plan) => {
                                 setSelectedInternetPlan(plan);
                                 setNairaAmount(plan.variation_amount ? plan.variation_amount.toString() : "0");
                               }} 
                             />
                          )}
                        </div>
                     )}
                  </div>
                )}

                {/* CABLE TV SPECIFIC LOGIC */}
                {!isInternational && activeService.id === "CABLE" && (cableProvider === "showmax" || customerName) && (
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
                               {currentFee > 0 && <p className="text-[10px] font-black text-orange-500 mt-1">+₦{currentFee} FEE INCLUDED</p>}
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
                                         <div>
                                            <p className="font-black text-blue-600 text-xl leading-none">₦{parseFloat(selectedCablePlan.variation_amount).toLocaleString()}</p>
                                            {currentFee > 0 && <p className="text-[9px] font-black text-orange-500 mt-1">+₦{currentFee} FEE INCLUDED</p>}
                                         </div>
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
                                    <div>
                                       <p className="font-black text-blue-600 text-xl leading-none">₦{parseFloat(selectedCablePlan.variation_amount).toLocaleString()}</p>
                                       {currentFee > 0 && <p className="text-[9px] font-black text-orange-500 mt-1">+₦{currentFee} FEE INCLUDED</p>}
                                    </div>
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

                {/* LOCAL AIRTIME OR ELECTRICITY INPUT */}
                {!isInternational && (activeService.id === "AIRTIME" || activeService.id === "ELECTRICITY") && (
                    <div>
                        <label className="text-[10px] font-black text-slate-400 uppercase mb-2 flex justify-between items-center">
                           <span>Amount</span>
                           <span className="text-emerald-500 font-black">MIN ₦{currentMinDisplay.toLocaleString()}</span>
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

                        {nairaAmount && !isFixedPlan && (parseFloat(nairaAmount) < currentMinDisplay || parseFloat(nairaAmount) > dynamicMaxAmount) && (
                            <div className="bg-red-50 border border-red-200 p-3 rounded-xl mt-2 flex items-center gap-2 animate-in fade-in">
                                <AlertTriangle size={16} className="text-red-500 shrink-0" />
                                <p className="text-xs font-black text-red-600">
                                    {parseFloat(nairaAmount) < currentMinDisplay ? `Amount is below the minimum of ₦${currentMinDisplay.toLocaleString()}` : `Amount exceeds the maximum of ₦${dynamicMaxAmount.toLocaleString()}`}
                                </p>
                            </div>
                        )}

                        <div className="flex gap-2.5 overflow-x-auto py-1.5 mt-3 no-scrollbar bg-slate-100 p-2 rounded-2xl shadow-inner">
                          {(activeService.id === "AIRTIME" ? PRE_SELECT_AMOUNTS : ELEC_PRE_SELECT_AMOUNTS).map(amountStr => {
                            const amountVal = parseInt(amountStr);
                            const cryptoAmtCost = (amountVal / exchangeRate).toFixed(4);
                            const isDisabled = activeService.id === "ELECTRICITY" && amountVal < currentMinDisplay;

                            return (
                              <button 
                                 key={amountStr} 
                                 onClick={() => !isDisabled && setNairaAmount(amountStr)} 
                                 disabled={isDisabled}
                                 className={`flex-1 min-w-[70px] py-4 rounded-xl font-black transition-all whitespace-nowrap ${isDisabled ? 'bg-slate-200 text-slate-400 opacity-50 cursor-not-allowed' : nairaAmount === amountStr ? 'bg-white shadow-lg text-emerald-700 scale-105' : 'bg-slate-50 hover:bg-slate-200 text-slate-700'}`}
                              >
                                 ₦{amountVal.toLocaleString()}
                                 <p className={`text-[8px] mt-0.5 font-bold ${isDisabled ? 'text-slate-400' : 'text-slate-400'}`}>{cryptoAmtCost} {selectedToken.symbol}</p>
                              </button>
                            );
                          })}
                       </div>
                    </div>
                )}

                {/* ⚡ RESTORED ELECTRICITY SMS FIELD ⚡ */}
                {(!isInternational && (activeService.id === "ELECTRICITY" || (activeService.id === "INTERNET" && internetProvider === 'smile-direct'))) && (
                    <div className="animate-in fade-in mt-3">
                         <label className="text-[10px] font-black text-slate-400 uppercase mb-2 flex justify-between">
                             <span>SMS Phone Number (For Token/Receipt)</span>
                         </label>
                         <input 
                            type="tel" placeholder="08000000000"
                            maxLength={11}
                            className="w-full bg-slate-50 border border-slate-100 p-5 rounded-2xl font-bold text-slate-700 outline-none focus:border-emerald-500 transition-colors"
                            value={customerPhone}
                            onChange={(e) => setCustomerPhone(e.target.value.replace(/[^0-9]/g, ''))}
                        />
                    </div>
                )}

                {/* ⚡ EMAIL / OPTIONAL INFO ⚡ */}
                <div className="animate-in fade-in mt-3">
                     <input 
                        type="email" 
                        placeholder={isInternational ? "Email Address (Required by VTpass)" : "Email Address (Optional for Receipt)"}
                        className={`w-full bg-slate-50 border p-5 rounded-2xl font-bold text-slate-700 outline-none transition-colors ${
                            isInternational && customerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail) ? 'border-red-300 focus:border-red-500' : 'border-slate-100 focus:border-emerald-500'
                        }`}
                        value={customerEmail}
                        onChange={(e) => setCustomerEmail(e.target.value)}
                    />
                    {isInternational && customerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail) && (
                        <p className="text-[10px] text-red-500 font-bold mt-1.5 ml-2">Please enter a valid email address.</p>
                    )}
                </div>

                {status && (
                    <div className={`p-5 rounded-2xl border flex items-center gap-4 animate-in fade-in shadow-sm ${status.includes('Success') || status.includes('Secured') || status.includes('Initiating') ? 'bg-emerald-50 border-emerald-100 text-emerald-800' : status.includes('Processing') ? 'bg-orange-50 border-orange-100 text-orange-800' : 'bg-blue-50 border-blue-100 text-blue-800'}`}>
                        {status.includes('Success') ? <CheckCircle2 size={24}/> : <Loader2 size={24} className="animate-spin"/>}
                        <p className="text-sm font-black tracking-tight">{status}</p>
                    </div>
                )}

                <button 
                    onClick={() => setIsConfirmModalOpen(true)}
                    disabled={isVerifying || !isFormValid || isProcessing || isCurrentServiceDisabled}
                    className={`w-full text-white font-black py-6 rounded-3xl flex items-center justify-center gap-3.5 transition-all active:scale-95 shadow-xl text-lg tracking-tight ${(!isFormValid || isCurrentServiceDisabled) ? 'bg-slate-300 opacity-50 cursor-not-allowed text-slate-500 shadow-none' : 'bg-slate-900 hover:bg-black disabled:opacity-30 shadow-slate-900/20'}`}
                >
                    {isProcessing ? <Loader2 size={24} className="animate-spin text-emerald-400"/> : <ShieldCheck size={24} className={isCurrentServiceDisabled ? 'text-slate-400' : 'text-emerald-400'} />}
                    {isCurrentServiceDisabled ? 'TEMPORARILY OFFLINE' : isProcessing ? 'PROCESSING...' : `PAY ${cryptoToCharge} ${selectedToken.symbol}`}
                </button>
            </div>
          </div>
        )}

        {/* ======================================= */}
        {/* BANK BLOCK (RESTORED) */}
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
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-0.5">Balance</p>
                    <div className="flex items-center justify-end gap-1.5">
                      {isFetchingBalance ? <Loader2 size={14} className="animate-spin text-emerald-500"/> : <Coins size={14} className="text-emerald-500"/>}
                      <div className="flex flex-col items-end">
                        <p className="font-mono font-black text-sm text-slate-800 leading-none">{walletBalance}</p>
                        {!isFetchingBalance && <p className="text-[9px] font-bold text-slate-400 mt-1 tracking-tight">≈ ₦{walletBalanceNaira}</p>}
                      </div>
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

                    {/* ⚡ SAVED BENEFICIARIES UI ⚡ */}
                    {(() => {
                        const key = getCurrentProviderKey();
                        const list = key ? beneficiaries[key] : [];
                        if (!list || list.length === 0) return null;
                        return (
                            <div className="flex gap-2 overflow-x-auto no-scrollbar mt-3 animate-in fade-in items-center">
                                <span className="text-[9px] font-black uppercase text-slate-400 shrink-0">Recent:</span>
                                {list.map((ben, idx) => (
                                    <button 
                                        key={idx}
                                        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
                                        style={{ WebkitTouchCallout: 'none', WebkitUserSelect: 'none', userSelect: 'none' }}
                                        onTouchStart={() => {
                                            isLongPress.current = false;
                                            pressTimer.current = setTimeout(() => {
                                                isLongPress.current = true;
                                                setActiveDeleteAccount(ben.account);
                                                if (navigator.vibrate) navigator.vibrate(50);
                                                setTimeout(() => setActiveDeleteAccount(null), 4000);
                                            }, 500); 
                                        }}
                                        onTouchEnd={() => { if (pressTimer.current) clearTimeout(pressTimer.current); }}
                                        onTouchMove={() => { if (pressTimer.current) clearTimeout(pressTimer.current); }}
                                        onMouseDown={() => {
                                            isLongPress.current = false;
                                            pressTimer.current = setTimeout(() => {
                                                isLongPress.current = true;
                                                setActiveDeleteAccount(ben.account);
                                                setTimeout(() => setActiveDeleteAccount(null), 4000);
                                            }, 500); 
                                        }}
                                        onMouseUp={() => { if (pressTimer.current) clearTimeout(pressTimer.current); }}
                                        onMouseLeave={() => { if (pressTimer.current) clearTimeout(pressTimer.current); }}
                                        onClick={(e) => {
                                            e.preventDefault();
                                            if (isLongPress.current) {
                                                isLongPress.current = false;
                                                return;
                                            }
                                            if (activeDeleteAccount === ben.account) {
                                                removeBeneficiary(ben.account);
                                                setActiveDeleteAccount(null);
                                            } else {
                                                setAccountNumber(ben.account);
                                                if (ben.name) setCustomerName(ben.name);
                                                setActiveDeleteAccount(null); 
                                            }
                                        }}
                                        className={`shrink-0 text-[10px] font-black py-1.5 px-3 rounded-full flex items-center gap-1.5 transition-all border outline-none select-none ${
                                            activeDeleteAccount === ben.account 
                                            ? 'bg-red-50 text-red-600 border-red-200' 
                                            : 'bg-slate-100 text-slate-600 border-slate-200 hover:bg-emerald-50 hover:text-emerald-700 hover:border-emerald-200' 
                                        }`}
                                    >
                                        {activeDeleteAccount === ben.account ? (
                                            <><XCircle size={12} className="animate-pulse" /> Delete</>
                                        ) : (
                                            <span>{ben.name ? ben.name.split(' ')[0] : ben.account}</span>
                                        )}
                                    </button>
                                ))}
                            </div>
                        );
                    })()}

                    {customerName && (
                        <div className="mt-2 bg-emerald-500/10 p-4 rounded-xl border border-emerald-500/20 flex items-center gap-3 animate-in fade-in">
                            <CheckCircle2 size={18} className="text-emerald-600 shrink-0" />
                            <div className="flex-1">
                                <span className="text-sm font-black text-emerald-800 line-clamp-1">{customerName}</span>
                                <p className="text-[10px] font-black text-emerald-600 uppercase mt-0.5">Verified</p>
                            </div>
                        </div>
                    )}
                </div>

                <div>
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
                        value={customerPhone}
                        onChange={(e) => setCustomerPhone(e.target.value.replace(/[^0-9]/g, ''))}
                    />
                </div>

                <div className="animate-in fade-in mt-3">
                     <input 
                        type="email" placeholder="Email Address (Optional for Receipt)"
                        className="w-full bg-slate-50 border border-slate-100 p-5 rounded-2xl font-bold text-slate-700 outline-none focus:border-emerald-500 transition-colors"
                        value={customerEmail}
                        onChange={(e) => setCustomerEmail(e.target.value)}
                    />
                </div>

                {status && (
                    <div className={`p-5 rounded-2xl border flex items-center gap-4 animate-in fade-in ${status.includes('Success') ? 'bg-emerald-50 border-emerald-100' : 'bg-blue-50 border-blue-100'}`}>
                        {status.includes('Success') ? <CheckCircle2 size={24}/> : <Loader2 size={24} className="animate-spin"/>}
                        <p className="text-sm font-black tracking-tight">{status}</p>
                    </div>
                )}

                <button 
                    onClick={() => setIsConfirmModalOpen(true)}
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
        {/* EDUCATION BLOCK */}
        {/* ======================================= */}
        {activeTab === 'education' && (
          <div className="bg-white border border-slate-100 rounded-[2.5rem] p-8 shadow-2xl shadow-emerald-900/10 animate-in fade-in zoom-in-95">
            <div className="space-y-5">
                <div className="bg-slate-50 border border-slate-100 p-4 rounded-2xl flex justify-between items-center animate-in fade-in">
                  <div 
                    className="flex items-center gap-2 cursor-pointer hover:bg-slate-100 p-2 -ml-2 rounded-xl transition-colors" 
                    onClick={() => openSelectionModal('token', "Select Token", SUPPORTED_TOKENS, (symbol: string) => setSelectedToken(SUPPORTED_TOKENS.find(t => t.symbol === symbol)!))}
                  >
                     <img src={selectedToken.logo} alt={selectedToken.symbol} className="w-7 h-7 object-contain rounded-full shadow-sm bg-white" />
                     <span className="font-black text-slate-800 uppercase text-sm tracking-tight">{selectedToken.symbol}</span>
                     <ChevronDown size={14} className="text-slate-400"/>
                  </div>
                  <div className="text-right">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-0.5">Balance</p>
                    <div className="flex items-center justify-end gap-1.5">
                      {isFetchingBalance ? <Loader2 size={14} className="animate-spin text-emerald-500"/> : <Coins size={14} className="text-emerald-500"/>}
                      <div className="flex flex-col items-end">
                        <p className="font-mono font-black text-sm text-slate-800 leading-none">{walletBalance}</p>
                        {!isFetchingBalance && <p className="text-[9px] font-bold text-slate-400 mt-1 tracking-tight">≈ ₦{walletBalanceNaira}</p>}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="animate-in slide-in-from-left-2 mb-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase mb-3 block">Service</label>
                    <button 
                        onClick={() => {
                            const optionsWithStatus = EDUCATION_PROVIDERS.map(p => {
                                const isMasterOff = killSwitches['MASTER_EDUCATION'] === false;
                                const isProviderOff = killSwitches[`EDU_${p.serviceID}`] === false;
                                return { ...p, disabled: isMasterOff || isProviderOff };
                            });
                            openSelectionModal('provider', "Select Education Service", optionsWithStatus, (val: any) => handleProviderChange(val, 'education'));
                        }}
                        className="w-full bg-white border border-slate-200 p-4 rounded-2xl flex justify-between items-center hover:border-emerald-400 transition-colors shadow-sm active:scale-[0.98]"
                    >
                        <div className="flex items-center gap-4">
                            <div className="w-12 h-12 shrink-0 rounded-full border border-slate-100 bg-emerald-50 flex items-center justify-center shadow-inner overflow-hidden">
                                <GraduationCap className="text-emerald-500" size={24} />
                            </div>
                            <div>
                                <span className="text-sm font-black text-slate-900 tracking-tight uppercase">
                                  {EDUCATION_PROVIDERS.find(p => p.serviceID === educationProvider)?.displayName || 'Select Service'}
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

                        {(() => {
                            const key = getCurrentProviderKey();
                            const list = key ? beneficiaries[key] : [];
                            if (!list || list.length === 0) return null;
                            return (
                                <div className="flex gap-2 overflow-x-auto no-scrollbar mt-3 animate-in fade-in items-center">
                                    <span className="text-[9px] font-black uppercase text-slate-400 shrink-0">Recent:</span>
                                    {list.map((ben: any, idx: number) => (
                                        <button 
                                            key={idx}
                                            onClick={(e) => {
                                                e.preventDefault();
                                                setAccountNumber(ben.account);
                                                if (ben.name) setCustomerName(ben.name);
                                            }}
                                            className={`shrink-0 text-[10px] font-black py-1.5 px-3 rounded-full flex items-center gap-1.5 transition-all border outline-none select-none bg-slate-100 text-slate-600 border-slate-200 hover:bg-emerald-50 hover:text-emerald-700 hover:border-emerald-200`}
                                        >
                                            <span>{ben.name ? ben.name.split(' ')[0] : ben.account}</span>
                                        </button>
                                    ))}
                                </div>
                            );
                        })()}

                        {customerName && (
                            <div className="mt-2 bg-emerald-500/10 p-4 rounded-xl border border-emerald-500/20 flex items-center gap-3 animate-in fade-in">
                                <CheckCircle2 size={18} className="text-emerald-600 shrink-0" />
                                <div className="flex-1">
                                    <span className="text-sm font-black text-emerald-800 line-clamp-1">{customerName}</span>
                                    <p className="text-[10px] font-black text-emerald-600 uppercase mt-0.5">Verified</p>
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
                                <div>
                                   <p className="font-black text-emerald-600 text-xl">₦{parseFloat(selectedEducationPlan.variation_amount || "0").toLocaleString()}</p>
                                   {currentFee > 0 && <p className="text-[9px] font-black text-orange-500">+₦{currentFee} FEE INCLUDED</p>}
                                </div>
                                <p className="text-[10px] text-slate-500 font-bold">{cryptoToCharge} {selectedToken.symbol}</p>
                            </div>
                          </div>
                      </div>
                  ) : (
                      <div className="grid grid-cols-1 gap-2 max-h-[30vh] overflow-y-auto pr-1">
                        {educationVariations.length === 0 ? (
                          <p className="text-center text-xs font-bold text-slate-400 py-4"><Loader2 className="animate-spin inline-block mr-2" size={14}/> Loading...</p>
                        ) : (
                          educationVariations.map((plan: any) => (
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

                <div className="animate-in fade-in mt-3">
                     <input 
                        type="email" placeholder="Email Address (Optional for Receipt)"
                        className="w-full bg-slate-50 border border-slate-100 p-5 rounded-2xl font-bold text-slate-700 outline-none focus:border-emerald-500 transition-colors"
                        value={customerEmail}
                        onChange={(e) => setCustomerEmail(e.target.value)}
                    />
                </div>

                {status && (
                    <div className={`p-5 rounded-2xl border flex items-center gap-4 animate-in fade-in shadow-sm ${status.includes('Success') || status.includes('Secured') || status.includes('Initiating') ? 'bg-emerald-50 border-emerald-100 text-emerald-800' : 'bg-blue-50 border-blue-100 text-blue-800'}`}>
                        {status.includes('Success') ? <CheckCircle2 size={24}/> : <Loader2 size={24} className="animate-spin"/>}
                        <p className="text-sm font-black tracking-tight">{status}</p>
                    </div>
                )}

                <button 
                    onClick={() => setIsConfirmModalOpen(true)}
                    disabled={!isFormValid || isProcessing || isCurrentServiceDisabled}
                    className={`w-full text-white font-black py-6 rounded-3xl flex items-center justify-center gap-3.5 transition-all active:scale-95 shadow-xl text-lg tracking-tight ${isCurrentServiceDisabled ? 'bg-slate-300 opacity-50 cursor-not-allowed text-slate-500 shadow-none' : 'bg-slate-900 hover:bg-black disabled:opacity-30 shadow-slate-900/20'}`}
                >
                    {isProcessing ? <Loader2 size={24} className="animate-spin text-emerald-400"/> : <ShieldCheck size={24} className={isCurrentServiceDisabled ? 'text-slate-400' : 'text-emerald-400'} />}
                    {isCurrentServiceDisabled ? 'TEMPORARILY OFFLINE' : isProcessing ? 'PROCESSING...' : `PAY ${cryptoToCharge} ${selectedToken.symbol}`}
                </button>
            </div>
          </div>
        )}

        {/* ======================================= */}
        {/* HISTORY BLOCK */}
        {/* ======================================= */}
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

        <AppFooter />
      </div>
    </main>
  );
}
