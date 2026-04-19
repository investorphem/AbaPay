"use client";

import { useState, useEffect, useMemo } from "react";
import { createWalletClient, createPublicClient, custom, http, formatUnits, parseUnits } from "viem";
import { celo, celoSepolia } from "viem/chains"; 
import { 
  Lock, ArrowDownToLine, Wallet, ShieldAlert, Activity, 
  Database, RefreshCcw, Globe, Zap, ExternalLink, 
  Search, Download, Users, BarChart3, Banknote,
  ChevronLeft, ChevronRight, Loader2, Save, Gauge, RefreshCw, Smartphone, Star
} from "lucide-react";
import { supabase } from "@/utils/supabase";

const ABAPAY_ADMIN_ABI = [
  {"inputs":[],"name":"owner","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"tokenAddress","type":"address"}],"name":"withdrawFunds","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"address","name":"tokenAddress","type":"address"},{"internalType":"address","name":"recipient","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"refundUser","outputs":[],"stateMutability":"nonpayable","type":"function"}
];

const ERC20_ABI = [
  {"inputs":[{"internalType":"address","name":"account","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"recipient","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"transfer","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"}
];

const TOKENS = {
  "USD₮": { decimals: 6, mainnet: "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e", sepolia: "0xd077A400968890Eacc75cdc901F0356c943e4fDb" },
  "USDC": { decimals: 6, mainnet: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", sepolia: "0x01C5C0122039549AD1493B8220cABEdD739BC44E" },
  "cUSD": { decimals: 18, mainnet: "0x765DE816845861e75A25fCA122bb6898B8B1282a", sepolia: "0xdE9e4C3ce781b4bA68120d6261cbad65ce0aB00b" }
};

const ITEMS_PER_PAGE = 10;

type TimeFilter = 'TODAY' | 'WEEK' | 'MONTH' | 'ALL';

export default function AdminDashboard() {
  const [address, setAddress] = useState<string | null>(null);
  const [client, setClient] = useState<any>(null);

  const [isOwner, setIsOwner] = useState<boolean | null>(null);
  const [isAuthenticating, setIsAuthenticating] = useState(true); 
  const [authError, setAuthError] = useState(""); 

  const [usdtVaultBalance, setUsdtVaultBalance] = useState("0.00");
  const [usdcVaultBalance, setUsdcVaultBalance] = useState("0.00");
  const [cusdVaultBalance, setCusdVaultBalance] = useState("0.00");

  const [vtBalance, setVtBalance] = useState("0.00"); 
  const [smsBalance, setSmsBalance] = useState("0");    
  const [status, setStatus] = useState("");
  const [activeTab, setActiveTab] = useState("analytics");
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('ALL'); // ⚡ TIME FILTER STATE

  const [dbTransactions, setDbTransactions] = useState<any[]>([]);
  const [dbUsers, setDbUsers] = useState<any[]>([]); // ⚡ VERIFIED USERS
  const [dbWallets, setDbWallets] = useState<any[]>([]); // ⚡ UNLINKED WALLETS
  
  const [isFetching, setIsFetching] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [identitySearchTerm, setIdentitySearchTerm] = useState(""); // ⚡ SEARCH FOR IDENTITY TAB
  const [filterStatus, setFilterStatus] = useState("ALL");

  const [currentPage, setCurrentPage] = useState(1);
  const [identityCurrentPage, setIdentityCurrentPage] = useState(1);
  const [processingRefundId, setProcessingRefundId] = useState<string | null>(null);
  const [isRequeryingId, setIsRequeryingId] = useState<string | null>(null); 

  const [currentExchangeRate, setCurrentExchangeRate] = useState<string>("Loading...");
  const [newExchangeRate, setNewExchangeRate] = useState<string>("");
  const [isUpdatingRate, setIsUpdatingRate] = useState(false);

  const isMainnet = process.env.NEXT_PUBLIC_NETWORK === "celo";
  const isLive = process.env.NEXT_PUBLIC_APP_MODE === "live";
  const activeChain = isMainnet ? celo : celoSepolia; 
  const ABAPAY_CONTRACT = process.env.NEXT_PUBLIC_ABAPAY_ADDRESS as `0x${string}`;

  useEffect(() => {
    async function initAdmin() {
      if (typeof window !== "undefined" && (window as any).ethereum) {
        setIsAuthenticating(true);
        setAuthError("");
        try {
          const walletClient = createWalletClient({ chain: activeChain, transport: custom((window as any).ethereum) });
          const [account] = await walletClient.requestAddresses();
          setAddress(account);
          setClient(walletClient);

          try {
            const currentChainId = await walletClient.getChainId();
            if (currentChainId !== activeChain.id) {
              await walletClient.switchChain({ id: activeChain.id });
            }
          } catch (switchError) {
             try { await walletClient.addChain({ chain: activeChain }); } catch(e) {}
          }

          const publicClient = createPublicClient({ chain: activeChain, transport: http() });
          const contractOwner = await publicClient.readContract({
            address: ABAPAY_CONTRACT,
            abi: ABAPAY_ADMIN_ABI,
            functionName: 'owner',
          }) as string;

          if (account.toLowerCase() === contractOwner.toLowerCase()) {
            setIsOwner(true);
            refreshAllData();
          } else {
            setIsOwner(false);
            setAuthError("The connected wallet is not the owner of this contract.");
          }
        } catch (error) { 
          console.error("Admin init failed", error); 
          setIsOwner(false);
          setAuthError("Failed to read Smart Contract. Check NEXT_PUBLIC_ABAPAY_ADDRESS in your .env");
        } finally {
          setIsAuthenticating(false);
        }
      } else {
        setIsOwner(false);
        setAuthError("Web3 Wallet not detected.");
        setIsAuthenticating(false);
      }
    }
    initAdmin();
  }, [activeChain, ABAPAY_CONTRACT]);

  const refreshAllData = async () => {
    setIsFetching(true);
    await Promise.all([fetchCloudLedger(), fetchOnChainBalances(), fetchVtPassHealth(), fetchExchangeRate(), fetchIdentities()]);
    setIsFetching(false);
  };

  const fetchExchangeRate = async () => {
    const { data, error } = await supabase.from('platform_settings').select('exchange_rate').eq('id', 1).single();
    if (data) {
      setCurrentExchangeRate(data.exchange_rate.toString());
      setNewExchangeRate(data.exchange_rate.toString());
    } else if (error) {
      setCurrentExchangeRate("Error");
    }
  };

  const updateExchangeRate = async () => {
    if (!newExchangeRate || isNaN(Number(newExchangeRate))) return alert("Invalid rate");
    setIsUpdatingRate(true);
    try {
      const res = await fetch('/api/admin/rate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ newRate: newExchangeRate }) });
      const data = await res.json();
      if (data.success) {
        alert("Rate successfully updated globally!");
        setCurrentExchangeRate(newExchangeRate);
      } else {
        alert(`Failed to update rate: ${data.message}`);
      }
    } catch (e) {
      alert("Network error while updating rate.");
    } finally {
      setIsUpdatingRate(false);
    }
  };

  const fetchOnChainBalances = async () => {
    const publicClient = createPublicClient({ chain: activeChain, transport: http() });
    try {
      const usdtBal = await publicClient.readContract({ address: (isMainnet ? TOKENS["USD₮"].mainnet : TOKENS["USD₮"].sepolia) as `0x${string}`, abi: ERC20_ABI, functionName: 'balanceOf', args: [ABAPAY_CONTRACT] }) as bigint;
      setUsdtVaultBalance(formatUnits(usdtBal, TOKENS["USD₮"].decimals));

      const usdcBal = await publicClient.readContract({ address: (isMainnet ? TOKENS["USDC"].mainnet : TOKENS["USDC"].sepolia) as `0x${string}`, abi: ERC20_ABI, functionName: 'balanceOf', args: [ABAPAY_CONTRACT] }) as bigint;
      setUsdcVaultBalance(formatUnits(usdcBal, TOKENS["USDC"].decimals));

      const cusdBal = await publicClient.readContract({ address: (isMainnet ? TOKENS["cUSD"].mainnet : TOKENS["cUSD"].sepolia) as `0x${string}`, abi: ERC20_ABI, functionName: 'balanceOf', args: [ABAPAY_CONTRACT] }) as bigint;
      setCusdVaultBalance(formatUnits(cusdBal, TOKENS["cUSD"].decimals));
    } catch (error) { console.error("Failed to fetch vault balances", error); }
  };

  const fetchVtPassHealth = async () => {
    try {
      const res = await fetch('/api/admin/health');
      const data = await res.json();
      setVtBalance(data.naira);
      setSmsBalance(data.sms);
    } catch (e) { console.error("Failed to fetch VTpass health"); }
  };

  const fetchCloudLedger = async () => {
    const { data, error } = await supabase.from('transactions').select('*').order('created_at', { ascending: false });
    if (!error) setDbTransactions(data || []);
  };

  // ⚡ FETCH IDENTITY & POINTS DATA ⚡
  const fetchIdentities = async () => {
    // Get Verified Users
    const { data: usersData } = await supabase.from('abapay_users').select('*').order('total_points', { ascending: false });
    if (usersData) setDbUsers(usersData);

    // Get Unlinked Wallets
    const { data: walletsData } = await supabase.from('wallet_links').select('*').is('user_id', null).order('unclaimed_points', { ascending: false });
    if (walletsData) setDbWallets(walletsData);
  };

  const handleWithdrawal = async (tokenSymbol: 'USD₮' | 'USDC' | 'cUSD') => {
    if (!client || !address) return;
    const balanceToCheck = tokenSymbol === 'USD₮' ? usdtVaultBalance : tokenSymbol === 'USDC' ? usdcVaultBalance : cusdVaultBalance;

    if (parseFloat(balanceToCheck) <= 0) return setStatus(`The ${tokenSymbol} Vault is already empty.`);
    setStatus(`Withdrawing ${tokenSymbol}...`);

    try {
      const tokenAddr = isMainnet ? TOKENS[tokenSymbol].mainnet : TOKENS[tokenSymbol].sepolia;
      const hash = await client.writeContract({
        address: ABAPAY_CONTRACT,
        abi: ABAPAY_ADMIN_ABI,
        functionName: 'withdrawFunds',
        args: [tokenAddr], 
        account: address,
      });
      setStatus(`Success! Hash: ${hash.slice(0, 10)}`);
      setTimeout(() => refreshAllData(), 5000);
    } catch (error) { setStatus("Rejected or Insufficient Gas."); }
  };

  const handleRefund = async (tx: any) => {
    try {
      if (!client || !address) return alert("Connect your Admin Wallet first.");

      setProcessingRefundId(tx.id);

      const rawAmount = parseFloat(tx.amount_usdt);

      if (isNaN(rawAmount) || rawAmount <= 0) {
          throw new Error("Invalid crypto amount found in database.");
      }

      const tokenSymbol = tx.tokenUsed || tx.token_used || "USD₮"; 
      const tokenData = TOKENS[tokenSymbol as keyof typeof TOKENS];
      if (!tokenData) throw new Error(`Token ${tokenSymbol} is not supported.`);

      const tokenAddr = isMainnet ? tokenData.mainnet : tokenData.sepolia;
      const decimals = tokenData.decimals;

      const cleanAmountString = rawAmount.toFixed(decimals);
      const valueInWei = parseUnits(cleanAmountString, decimals);

      const refundHash = await client.writeContract({
        address: ABAPAY_CONTRACT as `0x${string}`,
        abi: ABAPAY_ADMIN_ABI,
        functionName: 'refundUser',
        args: [tokenAddr, tx.wallet_address, valueInWei],
        account: address,
      });

      const publicClient = createPublicClient({ chain: activeChain, transport: http() });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: refundHash });

      if (receipt.status !== 'success') {
          throw new Error("Transaction reverted. The Vault does not have enough balance.");
      }

      const dbRes = await fetch('/api/admin/refund', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: tx.id, refundHash })
      });

      if (dbRes.ok) {
        alert(`Refund confirmed on-chain! Hash: ${refundHash}`);
        fetchCloudLedger(); 
        fetchOnChainBalances(); 
      } else {
        alert("Crypto refunded successfully, but backend failed to update the database status.");
      }

    } catch (error: any) {
      console.error(error);
      alert(`Refund Failed: ${error.message || "Execution Reverted. Please check Vault Balance."}`);
    } finally {
      setProcessingRefundId(null);
    }
  };

  const handleRequery = async (tx: any) => {
    if (!tx.request_id) return alert("This transaction has no Provider Request ID to query.");
    setIsRequeryingId(tx.id);

    try {
      const res = await fetch('/api/requery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_id: tx.request_id, tx_hash: tx.tx_hash })
      });
      const data = await res.json();

      if (data.success) {
        if (data.status === 'SUCCESS') {
           alert("✅ Transaction was successfully delivered by the provider!");
           fetchCloudLedger(); 
        } else if (data.status === 'FAILED_VENDING') {
           alert("❌ Provider rejected the transaction. It is now marked for a refund.");
           fetchCloudLedger();
        } else {
           alert("⏳ Provider is still processing it. Check back later.");
        }
      } else {
        alert(`Error: ${data.message}`);
      }
    } catch (error) {
      alert("Network error while checking status.");
    } finally {
      setIsRequeryingId(null);
    }
  };

  const currentVaultTotal = parseFloat(usdtVaultBalance || "0") + parseFloat(usdcVaultBalance || "0") + parseFloat(cusdVaultBalance || "0");

  // ⚡ TIME FILTERING LOGIC ⚡
  const timeFilteredTransactions = useMemo(() => {
    const now = new Date();
    return dbTransactions.filter(tx => {
      const txDate = new Date(tx.created_at);
      if (timeFilter === 'TODAY') {
        return txDate.toDateString() === now.toDateString();
      }
      if (timeFilter === 'WEEK') {
        const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        return txDate >= weekAgo;
      }
      if (timeFilter === 'MONTH') {
        return txDate.getMonth() === now.getMonth() && txDate.getFullYear() === now.getFullYear();
      }
      return true; // ALL
    });
  }, [dbTransactions, timeFilter]);

  const analytics = useMemo(() => {
    const successTx = timeFilteredTransactions.filter(tx => tx.status === "SUCCESS");

    const totalDeposited = timeFilteredTransactions.reduce((acc, tx) => acc + (parseFloat(tx.amount_usdt) || 0), 0);
    const totalRefunded = timeFilteredTransactions.filter(tx => tx.status === "REFUNDED").reduce((acc, tx) => acc + (parseFloat(tx.amount_usdt) || 0), 0);

    return {
      vol: successTx.reduce((acc, tx) => acc + Number(tx.amount_naira || 0), 0),
      fees: successTx.reduce((acc, tx) => acc + Number(tx.fee_naira || 0), 0),
      count: successTx.length,
      users: new Set(successTx.map(tx => tx.wallet_address)).size,
      totalDeposited,
      totalRefunded
    };
  }, [timeFilteredTransactions]);

  const filteredTx = useMemo(() => {
    return timeFilteredTransactions.filter(tx => {
      const searchLower = searchTerm.toLowerCase();
      const matchesSearch = (tx.account_number || "").includes(searchTerm) || 
                            (tx.network || "").toLowerCase().includes(searchLower) ||
                            (tx.wallet_address || "").toLowerCase().includes(searchLower) ||
                            (tx.request_id || "").toLowerCase().includes(searchLower);
      const matchesStatus = filterStatus === "ALL" || tx.status === filterStatus;
      return matchesSearch && matchesStatus;
    });
  }, [timeFilteredTransactions, searchTerm, filterStatus]);

  // ⚡ IDENTITY FILTERING ⚡
  const filteredIdentities = useMemo(() => {
      const searchLower = identitySearchTerm.toLowerCase();
      const matchedUsers = dbUsers.filter(u => u.verified_phone.includes(searchLower));
      const matchedWallets = dbWallets.filter(w => w.wallet_address.toLowerCase().includes(searchLower));
      return { users: matchedUsers, wallets: matchedWallets };
  }, [dbUsers, dbWallets, identitySearchTerm]);

  useEffect(() => { setCurrentPage(1); }, [searchTerm, filterStatus, timeFilter]);

  const totalPages = Math.ceil(filteredTx.length / ITEMS_PER_PAGE);
  const currentTransactions = filteredTx.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE);

  const exportCSV = () => {
    const headers = "Date,Status,Network,Service,Account,Naira,Crypto,Token Used,Transaction ID,Units,Token PIN,Hash\n";
    const rows = filteredTx.map(tx => `${tx.created_at},${tx.status},${tx.network},${tx.service_category},${tx.account_number},${tx.amount_naira},${tx.amount_usdt},${tx.token_used || 'USD₮'},${tx.request_id || 'N/A'},${tx.units || 'N/A'},${tx.purchased_code || 'N/A'},${tx.tx_hash}`).join("\n");
    const blob = new Blob([headers + rows], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `AbaPay_Report_${timeFilter}.csv`; a.click();
  };

  return (
    <main className="min-h-screen bg-[#070709] text-slate-200 p-4 md:p-8">
      <div className="max-w-6xl mx-auto">

        {/* HEADER */}
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
          <div>
            <h1 className="text-2xl font-black tracking-tighter flex items-center gap-3">
              <Zap className="text-emerald-500 fill-emerald-500" size={24} />
              ABAPAY <span className="text-slate-500 font-light">OPS CENTER</span>
            </h1>
            <div className="flex gap-3 mt-2">
              <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${isLive ? 'bg-red-500/10 text-red-500 border-red-500/20' : 'bg-blue-500/10 text-blue-500 border-blue-500/20'}`}>{isLive ? 'LIVE' : 'SANDBOX'}</span>
              <span className="px-2 py-0.5 rounded text-[10px] font-bold border bg-purple-500/10 text-purple-400 border-purple-500/20">{isMainnet ? 'MAINNET' : 'SEPOLIA'}</span>
            </div>
          </div>
          
          {/* ⚡ TIME FILTER TOGGLE ⚡ */}
          {!isAuthenticating && isOwner && (
            <div className="flex items-center gap-2 bg-slate-900 border border-slate-800 p-1 rounded-xl">
               {(['TODAY', 'WEEK', 'MONTH', 'ALL'] as TimeFilter[]).map(tf => (
                 <button 
                    key={tf} 
                    onClick={() => setTimeFilter(tf)}
                    className={`px-4 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${timeFilter === tf ? 'bg-emerald-500/20 text-emerald-400' : 'text-slate-500 hover:text-slate-300'}`}
                 >
                    {tf}
                 </button>
               ))}
            </div>
          )}
        </div>

        {isAuthenticating ? (
          <div className="py-40 text-center bg-slate-900/30 border border-dashed border-slate-800 rounded-3xl flex flex-col items-center animate-in fade-in">
             <Loader2 size={48} className="text-emerald-500 mb-4 animate-spin" />
             <h2 className="text-xl font-bold text-white">Authenticating Admin...</h2>
             <p className="text-slate-500 text-sm mt-2">Connecting to the Smart Contract</p>
          </div>
        ) : !isOwner ? (
          <div className="py-40 text-center bg-slate-900/30 border border-dashed border-slate-800 rounded-3xl animate-in fade-in">
             <ShieldAlert size={48} className="mx-auto text-red-500 mb-4 animate-pulse" />
             <h2 className="text-xl font-bold text-white">Security Challenge Failed</h2>
             <p className="text-slate-500 text-sm mt-2 mb-4">Connected Wallet: {address || 'None'}</p>
             <p className="text-red-400 text-[10px] font-mono bg-red-500/10 border border-red-500/20 inline-block px-4 py-2 rounded-lg uppercase tracking-widest">{authError}</p>
          </div>
        ) : (
          <div className="space-y-6">

            {/* STATS (Filters apply to Profit & Vault values!) */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <StatBox label="VTpass Wallet" value={`₦${vtBalance}`} sub="Live Naira Float" color="text-white" icon={<Banknote size={16}/>} />
              <StatBox label={`Vaults (${timeFilter})`} value={`$${currentVaultTotal.toFixed(2)}`} sub="Total Locked Assets" color="text-emerald-500" icon={<Wallet size={16}/>} />
              <StatBox label={`Profit (${timeFilter})`} value={`₦${analytics.fees.toLocaleString()}`} sub="Service Fees Accrued" color="text-blue-400" icon={<BarChart3 size={16}/>} />
              <StatBox label="SMS Health" value={`${smsBalance} Units`} sub="Messaging Units" color="text-orange-400" icon={<Activity size={16}/>} />
            </div>

            {/* ⚡ ADDED 'IDENTITY' TO TABS ⚡ */}
            <div className="bg-[#111114] p-1.5 rounded-2xl border border-slate-800 flex justify-between items-center max-w-full">
              <div className="flex gap-1 overflow-x-auto no-scrollbar pr-4">
                  {['analytics', 'pricing', 'ledger', 'vault', 'identity'].map((t) => (
                    <button key={t} onClick={() => setActiveTab(t)} className={`px-6 py-2 rounded-xl text-xs font-black uppercase transition-all whitespace-nowrap ${activeTab === t ? 'bg-slate-800 text-emerald-400' : 'text-slate-500 hover:text-slate-300'}`}>{t}</button>
                  ))}
              </div>
              <button onClick={refreshAllData} className="hidden md:flex items-center justify-center p-2 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-500 transition-colors shrink-0" title="Force Refresh All Data">
                 <RefreshCcw size={16} className={isFetching ? 'animate-spin' : ''} />
              </button>
            </div>

            {/* ⚡ IDENTITY & POINTS TAB ⚡ */}
            {activeTab === 'identity' && (
              <div className="bg-[#111114] border border-slate-800 rounded-3xl p-6 animate-in fade-in">
                 <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 gap-4">
                    <div className="flex items-center gap-3">
                       <div className="bg-purple-500/10 p-3 rounded-full"><Star className="text-purple-400" size={24}/></div>
                       <div>
                         <h2 className="text-xl font-black text-white">Identity & Loyalty</h2>
                         <p className="text-xs font-bold text-slate-500 uppercase tracking-widest mt-1">AbaPoints Database</p>
                       </div>
                    </div>
                    <div className="relative w-full md:w-64">
                       <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-600" size={14} />
                       <input type="text" placeholder="Search phone or wallet..." className="w-full bg-slate-900 border border-slate-800 rounded-lg pl-10 pr-4 py-2 text-xs focus:border-purple-500 outline-none" value={identitySearchTerm} onChange={(e) => setIdentitySearchTerm(e.target.value)} />
                    </div>
                 </div>

                 <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {/* Verified Users Table */}
                    <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
                       <div className="bg-slate-800/50 p-4 border-b border-slate-800 flex justify-between items-center">
                          <h3 className="text-sm font-black text-slate-300 flex items-center gap-2"><Smartphone size={16} className="text-emerald-500"/> Verified Profiles</h3>
                          <span className="bg-slate-800 text-slate-400 text-[10px] font-bold px-2 py-1 rounded">{filteredIdentities.users.length} Users</span>
                       </div>
                       <div className="max-h-[500px] overflow-y-auto p-2">
                           {filteredIdentities.users.length === 0 ? (
                               <p className="text-center text-xs text-slate-500 py-10 italic">No verified users found.</p>
                           ) : (
                               <div className="divide-y divide-slate-800/50">
                                   {filteredIdentities.users.map(u => (
                                       <div key={u.id} className="p-3 flex justify-between items-center hover:bg-slate-800/30 transition-colors rounded-lg">
                                           <div>
                                               <p className="font-mono font-bold text-slate-300 text-sm">{u.verified_phone}</p>
                                               <p className="text-[9px] text-slate-500 uppercase tracking-widest mt-0.5">Joined: {new Date(u.created_at).toLocaleDateString()}</p>
                                           </div>
                                           <div className="text-right">
                                               <p className="font-black text-emerald-400 text-lg leading-none">{Number(u.total_points).toFixed(2)}</p>
                                               <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest mt-1">Total Points</p>
                                           </div>
                                       </div>
                                   ))}
                               </div>
                           )}
                       </div>
                    </div>

                    {/* Unlinked Wallets Table */}
                    <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
                       <div className="bg-slate-800/50 p-4 border-b border-slate-800 flex justify-between items-center">
                          <h3 className="text-sm font-black text-slate-300 flex items-center gap-2"><Wallet size={16} className="text-slate-500"/> Unclaimed Wallets</h3>
                          <span className="bg-slate-800 text-slate-400 text-[10px] font-bold px-2 py-1 rounded">{filteredIdentities.wallets.length} Wallets</span>
                       </div>
                       <div className="max-h-[500px] overflow-y-auto p-2">
                           {filteredIdentities.wallets.length === 0 ? (
                               <p className="text-center text-xs text-slate-500 py-10 italic">No unlinked wallets found.</p>
                           ) : (
                               <div className="divide-y divide-slate-800/50">
                                   {filteredIdentities.wallets.map(w => (
                                       <div key={w.wallet_address} className="p-3 flex justify-between items-center hover:bg-slate-800/30 transition-colors rounded-lg">
                                           <div>
                                               <p className="font-mono font-medium text-slate-400 text-xs">{w.wallet_address.slice(0, 8)}...{w.wallet_address.slice(-6)}</p>
                                               <p className="text-[9px] text-slate-500 uppercase tracking-widest mt-1">Pending Verification</p>
                                           </div>
                                           <div className="text-right">
                                               <p className="font-black text-slate-300 text-lg leading-none">{Number(w.unclaimed_points).toFixed(2)}</p>
                                               <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest mt-1">Unclaimed</p>
                                           </div>
                                       </div>
                                   ))}
                               </div>
                           )}
                       </div>
                    </div>
                 </div>
              </div>
            )}

            {/* PRICING ENGINE TAB */}
            {activeTab === 'pricing' && (
              <div className="bg-[#111114] border border-slate-800 rounded-3xl p-8 animate-in fade-in">
                 <div className="flex items-center gap-3 mb-6">
                    <div className="bg-blue-500/10 p-3 rounded-full"><Gauge className="text-blue-400" size={24}/></div>
                    <div>
                      <h2 className="text-xl font-black text-white">Dynamic Pricing Engine</h2>
                      <p className="text-xs font-bold text-slate-500 uppercase tracking-widest mt-1">Global Rate Controller</p>
                    </div>
                 </div>

                 <div className="grid grid-cols-1 md:grid-cols-2 gap-8 bg-slate-900 border border-slate-800 rounded-2xl p-6">
                    <div className="border-r border-slate-800 pr-0 md:pr-6">
                       <p className="text-slate-400 text-xs font-bold uppercase tracking-wider mb-2">Live Exchange Rate</p>
                       <p className="text-5xl font-black text-emerald-400 font-mono tracking-tighter">₦{currentExchangeRate}</p>
                       <p className="text-xs text-slate-500 mt-2">This is the exact rate currently driving both the frontend App UI and the secure Backend smart contract checks.</p>
                    </div>

                    <div>
                       <label className="text-slate-400 text-xs font-bold uppercase tracking-wider mb-2 block">Update Rate</label>
                       <div className="flex flex-col gap-3">
                          <div className="relative">
                            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 font-black">₦</span>
                            <input 
                              type="number" 
                              value={newExchangeRate} 
                              onChange={(e) => setNewExchangeRate(e.target.value)} 
                              className="w-full bg-slate-950 border border-slate-700 text-white font-black text-2xl py-4 pl-10 pr-4 rounded-xl outline-none focus:border-blue-500 transition-all"
                            />
                          </div>
                          <button 
                            onClick={updateExchangeRate}
                            disabled={isUpdatingRate || newExchangeRate === currentExchangeRate}
                            className="bg-blue-600 hover:bg-blue-500 text-white font-black py-4 rounded-xl flex items-center justify-center gap-2 transition-all disabled:opacity-50 active:scale-95"
                          >
                            {isUpdatingRate ? <Loader2 size={18} className="animate-spin"/> : <Save size={18}/>} 
                            PUBLISH NEW RATE GLOBALLY
                          </button>
                       </div>
                    </div>
                 </div>
              </div>
            )}

            {/* LEDGER TAB */}
            {activeTab === 'ledger' && (
              <div className="bg-[#111114] border border-slate-800 rounded-3xl p-6 animate-in fade-in">
                <div className="flex flex-col lg:flex-row gap-4 mb-6">
                  <div className="flex-1 relative">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-600" size={16} />
                    <input type="text" placeholder="Search by ID, Account or Wallet..." className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-12 pr-4 py-3 text-sm focus:border-emerald-500 outline-none" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
                  </div>
                  <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className="bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-300">
                    <option value="ALL">All Status</option>
                    <option value="SUCCESS">Success</option>
                    <option value="PENDING">Pending</option>
                    <option value="FAILED_VENDING">Failed</option>
                    <option value="REFUNDED">Refunded</option>
                    <option value="FAILED_FUNDS_MISMATCH">Rate Mismatch</option> 
                  </select>
                  <button onClick={exportCSV} className="flex items-center gap-2 bg-slate-800 border border-slate-700 px-6 py-3 rounded-xl text-sm font-bold hover:bg-slate-700"><Download size={16} /> Export</button>
                </div>

                <div className="overflow-x-auto min-h-[400px] flex flex-col justify-between">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="text-slate-500 border-b border-slate-800 text-[10px] uppercase">
                        <th className="pb-4 px-2">Details</th>
                        <th className="pb-4 px-2">Utility Vended</th>
                        <th className="pb-4 px-2">Provider Data</th>
                        <th className="pb-4 px-2">Financials</th>
                        <th className="pb-4 px-2">Status & Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {currentTransactions.map((tx) => (
                        <tr key={tx.id} className="hover:bg-slate-900/40">
                          <td className="py-4 px-2 min-w-[150px]">
                            <p className="text-white font-medium text-xs">{new Date(tx.created_at).toLocaleString()}</p>
                            <a href={`https://${isMainnet ? '' : 'sepolia.'}celoscan.io/tx/${tx.tx_hash}`} target="_blank" className="text-[9px] text-emerald-400 hover:underline flex items-center gap-1 mt-1 font-mono tracking-wider">{tx.tx_hash.slice(0, 14)}... <ExternalLink size={8} /></a>
                          </td>
                          <td className="py-4 px-2 min-w-[180px]">
                            <p className="text-slate-200 font-bold uppercase">{tx.network || 'N/A'}</p>
                            <p className="text-[10px] text-slate-500 uppercase tracking-wider mt-0.5">{tx.service_category} • {tx.account_number}</p>
                          </td>
                          <td className="py-4 px-2 min-w-[180px]">
                            <p className="text-slate-300 font-mono text-[10px] tracking-wider mb-0.5">ID: {tx.request_id || 'N/A'}</p>
                            {(tx.service_category === 'ELECTRICITY' || tx.service_category === 'EDUCATION') && tx.status === 'SUCCESS' ? (
                                <div className="text-[9px]">
                                    <p className="text-orange-400 font-bold tracking-widest">{tx.purchased_code ? tx.purchased_code.replace(/token\s*[:\-]*\s*/gi, '').trim() : 'N/A'}</p>
                                    <p className="text-slate-500">{tx.service_category === 'ELECTRICITY' && tx.units ? `${tx.units} kWh` : tx.service_category === 'EDUCATION' ? 'Education PIN' : 'N/A'}</p>
                                </div>
                            ) : (
                                <p className="text-[9px] text-slate-600 italic">No Token Generated</p>
                            )}
                          </td>
                          <td className="py-4 px-2 min-w-[120px]">
                            <p className="text-white font-black">₦{tx.amount_naira.toLocaleString()}</p>
                            <p className="text-[10px] text-emerald-500 font-mono">${(tx.amount_usdt || tx.amount_crypto || 0).toString()} {tx.token_used || 'USD₮'}</p>
                          </td>
                          <td className="py-4 px-2">
                            <div className="flex flex-col items-start gap-2">
                              <span className={`text-[9px] font-black px-2 py-1 rounded tracking-widest uppercase ${
                                tx.status === 'SUCCESS' ? 'bg-emerald-500/10 text-emerald-500' : 
                                tx.status === 'REFUNDED' ? 'bg-blue-500/10 text-blue-400' :
                                tx.status === 'FAILED_FUNDS_MISMATCH' ? 'bg-purple-500/10 text-purple-400' :
                                tx.status === 'PENDING' ? 'bg-orange-500/10 text-orange-400' : 
                                'bg-red-500/10 text-red-500'
                              }`}>
                                {tx.status}
                              </span>

                              {tx.status === 'PENDING' && (
                                <button 
                                  onClick={() => handleRequery(tx)}
                                  disabled={isRequeryingId === tx.id}
                                  className="bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white text-[9px] font-bold uppercase tracking-widest px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-colors disabled:opacity-50"
                                >
                                  {isRequeryingId === tx.id ? <Loader2 size={10} className="animate-spin text-orange-400" /> : <RefreshCw size={10} className="text-orange-400" />}
                                  {isRequeryingId === tx.id ? 'Checking...' : 'Check Status'}
                                </button>
                              )}

                              {(tx.status === 'FAILED_VENDING' || tx.status === 'FAILED_FUNDS_MISMATCH') && (
                                <button 
                                  onClick={() => handleRefund(tx)}
                                  disabled={processingRefundId === tx.id}
                                  className="bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white text-[9px] font-bold uppercase tracking-widest px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-colors disabled:opacity-50"
                                >
                                  {processingRefundId === tx.id ? <Loader2 size={10} className="animate-spin text-emerald-400" /> : <Zap size={10} className="text-emerald-400" />}
                                  {processingRefundId === tx.id ? 'Refunding...' : 'Refund'}
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  {totalPages > 1 && (
                    <div className="flex justify-between items-center mt-6 pt-4 border-t border-slate-800">
                      <button 
                        onClick={() => setCurrentPage(p => Math.max(1, p - 1))} 
                        disabled={currentPage === 1} 
                        className="flex items-center gap-1 px-4 py-2 text-xs font-bold uppercase text-slate-400 hover:text-emerald-400 disabled:opacity-30 transition-colors"
                      >
                        <ChevronLeft size={16} /> Prev
                      </button>
                      <span className="text-xs font-black tracking-widest text-slate-500">
                        PAGE {currentPage} OF {totalPages}
                      </span>
                      <button 
                        onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} 
                        disabled={currentPage === totalPages} 
                        className="flex items-center gap-1 px-4 py-2 text-xs font-bold uppercase text-slate-400 hover:text-emerald-400 disabled:opacity-30 transition-colors"
                      >
                        Next <ChevronRight size={16} />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* VAULT TAB */}
            {activeTab === 'vault' && (
              <div className="bg-[#111114] border border-slate-800 rounded-3xl p-8 animate-in fade-in slide-in-from-bottom-4">
                <div className="flex flex-col items-center mb-8">
                    <div className="bg-emerald-500/10 rounded-full mb-4 p-4"><Lock className="text-emerald-500" size={32} /></div>
                    <p className="text-slate-500 text-sm text-center max-w-md italic">Smart Contract Escrow Balances</p>
                    {status && <div className="mt-4 text-xs font-mono text-emerald-400 bg-emerald-500/5 py-2 px-4 rounded border border-emerald-500/10">{status}</div>}
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div className="bg-slate-900 border border-slate-800 p-6 rounded-3xl text-center">
                        <h2 className="text-4xl font-black mb-1">${usdtVaultBalance}</h2>
                        <span className="text-xs text-emerald-500 font-bold uppercase tracking-widest bg-emerald-500/10 px-3 py-1 rounded-full">USD₮ Vault</span>
                        <button onClick={() => handleWithdrawal('USD₮')} className="mt-8 w-full bg-slate-800 hover:bg-emerald-500 hover:text-slate-950 text-slate-300 font-black py-3 rounded-xl flex items-center justify-center gap-2 transition-all"><ArrowDownToLine size={16} /> Withdraw USD₮</button>
                    </div>
                    <div className="bg-slate-900 border border-slate-800 p-6 rounded-3xl text-center">
                        <h2 className="text-4xl font-black mb-1">${usdcVaultBalance}</h2>
                        <span className="text-xs text-blue-400 font-bold uppercase tracking-widest bg-blue-500/10 px-3 py-1 rounded-full">USDC Vault</span>
                        <button onClick={() => handleWithdrawal('USDC')} className="mt-8 w-full bg-slate-800 hover:bg-blue-500 hover:text-slate-950 text-slate-300 font-black py-3 rounded-xl flex items-center justify-center gap-2 transition-all"><ArrowDownToLine size={16} /> Withdraw USDC</button>
                    </div>
                    <div className="bg-slate-900 border border-slate-800 p-6 rounded-3xl text-center">
                        <h2 className="text-4xl font-black mb-1">${cusdVaultBalance}</h2>
                        <span className="text-xs text-yellow-500 font-bold uppercase tracking-widest bg-yellow-500/10 px-3 py-1 rounded-full">cUSD Vault</span>
                        <button onClick={() => handleWithdrawal('cUSD')} className="mt-8 w-full bg-slate-800 hover:bg-yellow-500 hover:text-slate-950 text-slate-300 font-black py-3 rounded-xl flex items-center justify-center gap-2 transition-all"><ArrowDownToLine size={16} /> Withdraw cUSD</button>
                    </div>
                </div>
              </div>
            )}

            {/* ANALYTICS TAB */}
            {activeTab === 'analytics' && (
               <div className="space-y-6 animate-in fade-in">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="bg-[#111114] border border-slate-800 rounded-3xl p-6">
                      <h3 className="text-xs font-black uppercase text-slate-500 mb-6 flex items-center gap-2"><Users size={14}/> User Acquisition ({timeFilter})</h3>
                      <div className="flex items-baseline gap-2">
                        <span className="text-4xl font-black">{analytics.users}</span>
                        <span className="text-emerald-500 text-xs font-bold">Total Unique Wallets</span>
                      </div>
                    </div>
                    <div className="bg-[#111114] border border-slate-800 rounded-3xl p-6">
                      <h3 className="text-xs font-black uppercase text-slate-500 mb-6 flex items-center gap-2"><Activity size={14}/> Transaction Volume ({timeFilter})</h3>
                      <div className="flex items-baseline gap-2">
                        <span className="text-4xl font-black">₦{analytics.vol.toLocaleString()}</span>
                        <span className="text-slate-500 text-xs">Gross Vended Value</span>
                      </div>
                    </div>
                  </div>

                  <div className="bg-slate-900 border border-slate-800 rounded-3xl p-8">
                     <div className="flex items-center gap-3 mb-6">
                        <div className="bg-emerald-500/10 p-3 rounded-full"><Database className="text-emerald-400" size={24}/></div>
                        <div>
                          <h2 className="text-xl font-black text-white">Smart Contract Accounting</h2>
                          <p className="text-xs font-bold text-slate-500 uppercase tracking-widest mt-1">Filtered by: {timeFilter}</p>
                        </div>
                     </div>

                     <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                        <div className="border-l-2 border-emerald-500 pl-4">
                           <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">Total Crypto Received</p>
                           <p className="text-3xl font-black text-white">${analytics.totalDeposited.toFixed(2)}</p>
                           <p className="text-[10px] text-slate-500 mt-1">Deposits for this period</p>
                        </div>
                        <div className="border-l-2 border-blue-500 pl-4">
                           <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">Total Processed Refunds</p>
                           <p className="text-3xl font-black text-white">${analytics.totalRefunded.toFixed(2)}</p>
                           <p className="text-[10px] text-slate-500 mt-1">Crypto returned for this period</p>
                        </div>
                        <div className="border-l-2 border-purple-500 pl-4 bg-purple-500/5 -ml-4 pl-8 py-2 rounded-r-xl">
                           <p className="text-[10px] font-black text-purple-400 uppercase tracking-widest mb-1">Est. Treasury Flow</p>
                           <p className="text-3xl font-black text-purple-400">${Math.max(0, analytics.totalDeposited - analytics.totalRefunded).toFixed(2)}</p>
                           <p className="text-[10px] text-purple-400 mt-1">Net deposits for this period</p>
                        </div>
                     </div>
                  </div>
               </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

function StatBox({ label, value, sub, color, icon }: any) {
  return (
    <div className="bg-[#111114] border border-slate-800 p-6 rounded-3xl hover:border-slate-700 transition-all">
      <div className="flex items-center gap-2 text-slate-500 text-[10px] font-black uppercase tracking-wider mb-3">{icon} {label}</div>
      <div className={`text-2xl font-black tracking-tight ${color}`}>{value}</div>
      <div className="text-slate-600 text-[10px] mt-1 font-medium">{sub}</div>
    </div>
  );
}
