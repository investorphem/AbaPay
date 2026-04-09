"use client";

import { useState, useEffect, useMemo } from "react";
import { createWalletClient, createPublicClient, custom, http, formatUnits, parseUnits, defineChain } from "viem";
import { 
  Lock, ArrowDownToLine, Wallet, ShieldAlert, Activity, 
  Database, RefreshCcw, Globe, Zap, ExternalLink, 
  Search, Download, Users, BarChart3, Banknote,
  ChevronLeft, ChevronRight, Loader2, Save, Gauge
} from "lucide-react";
import { supabase } from "@/utils/supabase";

// --- DYNAMIC NETWORK CONFIG ---
const celoMainnet = defineChain({
  id: 42220,
  name: 'Celo',
  nativeCurrency: { decimals: 18, name: 'CELO', symbol: 'CELO' },
  rpcUrls: { default: { http: ['https://forno.celo.org'] } },
});

const celoSepolia = defineChain({
  id: 11142220,
  name: 'Celo Sepolia',
  nativeCurrency: { decimals: 18, name: 'CELO', symbol: 'CELO' },
  rpcUrls: { default: { http: ['https://forno.celo-sepolia.celo-testnet.org'] } },
});

// UPGRADED: Added refundUser to the Contract ABI
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

export default function AdminDashboard() {
  const [address, setAddress] = useState<string | null>(null);
  const [client, setClient] = useState<any>(null);
  const [isOwner, setIsOwner] = useState<boolean | null>(null);

  const [usdtVaultBalance, setUsdtVaultBalance] = useState("0.00");
  const [usdcVaultBalance, setUsdcVaultBalance] = useState("0.00");
  const [cusdVaultBalance, setCusdVaultBalance] = useState("0.00");

  const [vtBalance, setVtBalance] = useState("0.00"); 
  const [smsBalance, setSmsBalance] = useState("0");    
  const [status, setStatus] = useState("");
  const [activeTab, setActiveTab] = useState("analytics");

  const [dbTransactions, setDbTransactions] = useState<any[]>([]);
  const [isFetching, setIsFetching] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterStatus, setFilterStatus] = useState("ALL");

  const [currentPage, setCurrentPage] = useState(1);
  const [processingRefundId, setProcessingRefundId] = useState<string | null>(null);

  // ⚡ NEW: PRICING ENGINE STATE ⚡
  const [currentExchangeRate, setCurrentExchangeRate] = useState<string>("Loading...");
  const [newExchangeRate, setNewExchangeRate] = useState<string>("");
  const [isUpdatingRate, setIsUpdatingRate] = useState(false);

  const isMainnet = process.env.NEXT_PUBLIC_NETWORK === "celo";
  const isLive = process.env.NEXT_PUBLIC_APP_MODE === "live";
  const activeChain = isMainnet ? celoMainnet : celoSepolia;
  const ABAPAY_CONTRACT = process.env.NEXT_PUBLIC_ABAPAY_ADDRESS as `0x${string}`;

  useEffect(() => {
    async function initAdmin() {
      if (typeof window !== "undefined" && (window as any).ethereum) {
        try {
          const walletClient = createWalletClient({ chain: activeChain, transport: custom((window as any).ethereum) });
          const [account] = await walletClient.requestAddresses();
          setAddress(account);
          setClient(walletClient);

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
          }
        } catch (error) { console.error("Admin init failed", error); }
      }
    }
    initAdmin();
  }, [activeChain]);

  const refreshAllData = async () => {
    setIsFetching(true);
    await Promise.all([fetchCloudLedger(), fetchOnChainBalances(), fetchVtPassHealth(), fetchExchangeRate()]);
    setIsFetching(false);
  };

  // ⚡ NEW: FETCH DYNAMIC RATE FROM DB ⚡
  const fetchExchangeRate = async () => {
    const { data, error } = await supabase
      .from('platform_settings')
      .select('exchange_rate')
      .eq('id', 1)
      .single();
    
    if (data) {
      setCurrentExchangeRate(data.exchange_rate.toString());
      setNewExchangeRate(data.exchange_rate.toString());
    } else if (error) {
      console.error("Error fetching rate", error);
      setCurrentExchangeRate("Error");
    }
  };

  // ⚡ NEW: UPDATE DYNAMIC RATE IN DB ⚡
  const updateExchangeRate = async () => {
    if (!newExchangeRate || isNaN(Number(newExchangeRate))) return alert("Invalid rate");
    
    setIsUpdatingRate(true);
    const { error } = await supabase
      .from('platform_settings')
      .update({ exchange_rate: Number(newExchangeRate) })
      .eq('id', 1);

    setIsUpdatingRate(false);

    if (error) {
      alert(`Failed to update rate: ${error.message}`);
    } else {
      alert("Rate successfully updated globally!");
      setCurrentExchangeRate(newExchangeRate);
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

      const rawAmount = tx.amount_usdt || tx.amount_crypto || tx.amountCrypto;
      if (!rawAmount) throw new Error("Could not locate the crypto amount for this transaction.");

      const tokenSymbol = tx.tokenUsed || tx.token_used || "USD₮"; 
      const tokenData = TOKENS[tokenSymbol as keyof typeof TOKENS];
      if (!tokenData) throw new Error(`Token ${tokenSymbol} is not supported.`);

      const tokenAddr = isMainnet ? tokenData.mainnet : tokenData.sepolia;
      const decimals = tokenData.decimals;
      const valueInWei = parseUnits(rawAmount.toString(), decimals);

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
          throw new Error("Transaction reverted. Does the Vault have enough balance?");
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
        alert("Crypto refunded successfully, but backend failed to secure the database update.");
      }

    } catch (error: any) {
      console.error(error);
      alert(`Refund rejected or failed: ${error.message}`);
    } finally {
      setProcessingRefundId(null);
    }
  };

  const analytics = useMemo(() => {
    const successTx = dbTransactions.filter(tx => tx.status === "SUCCESS");
    return {
      vol: successTx.reduce((acc, tx) => acc + Number(tx.amount_naira), 0),
      fees: successTx.reduce((acc, tx) => acc + Number(tx.fee_naira), 0),
      count: successTx.length,
      users: new Set(successTx.map(tx => tx.wallet_address)).size
    };
  }, [dbTransactions]);

  const filteredTx = useMemo(() => {
    return dbTransactions.filter(tx => {
      const searchLower = searchTerm.toLowerCase();
      const matchesSearch = (tx.account_number || "").includes(searchTerm) || 
                            (tx.network || "").toLowerCase().includes(searchLower) ||
                            (tx.wallet_address || "").toLowerCase().includes(searchLower) ||
                            (tx.request_id || "").toLowerCase().includes(searchLower); // Added search by request_id
      const matchesStatus = filterStatus === "ALL" || tx.status === filterStatus;
      return matchesSearch && matchesStatus;
    });
  }, [dbTransactions, searchTerm, filterStatus]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, filterStatus]);

  const totalPages = Math.ceil(filteredTx.length / ITEMS_PER_PAGE);
  const currentTransactions = filteredTx.slice(
    (currentPage - 1) * ITEMS_PER_PAGE,
    currentPage * ITEMS_PER_PAGE
  );

  const exportCSV = () => {
    // Upgraded CSV Export to include Units and Purchased Code
    const headers = "Date,Status,Network,Service,Account,Naira,USDT,Transaction ID,Units,Token PIN,Hash\n";
    const rows = filteredTx.map(tx => `${tx.created_at},${tx.status},${tx.network},${tx.service_category},${tx.account_number},${tx.amount_naira},${tx.amount_usdt},${tx.request_id || 'N/A'},${tx.units || 'N/A'},${tx.purchased_code || 'N/A'},${tx.tx_hash}`).join("\n");
    const blob = new Blob([headers + rows], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `AbaPay_Report.csv`; a.click();
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
          <button onClick={refreshAllData} className="flex items-center gap-2 bg-slate-900 border border-slate-800 px-5 py-2.5 rounded-xl hover:bg-slate-800 active:scale-95">
            <RefreshCcw size={18} className={isFetching ? 'animate-spin text-emerald-500' : 'text-slate-400'} />
            <span className="text-sm font-bold">Synchronize Systems</span>
          </button>
        </div>

        {!isOwner ? (
          <div className="py-40 text-center bg-slate-900/30 border border-dashed border-slate-800 rounded-3xl">
             <ShieldAlert size={48} className="mx-auto text-red-500 mb-4 animate-pulse" />
             <h2 className="text-xl font-bold">Security Challenge Failed</h2>
             <p className="text-slate-500 text-sm mt-2">Connected: {address?.slice(0,12)}...</p>
          </div>
        ) : (
          <div className="space-y-6">

            {/* STATS */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <StatBox label="VTpass Wallet" value={`₦${vtBalance}`} sub="Naira Float" color="text-white" icon={<Banknote size={16}/>} />
              <StatBox label="Blockchain Vaults" value={`$${(parseFloat(usdtVaultBalance) + parseFloat(usdcVaultBalance) + parseFloat(cusdVaultBalance)).toFixed(2)}`} sub="Total Locked Assets" color="text-emerald-500" icon={<Wallet size={16}/>} />
              <StatBox label="Admin Profit" value={`₦${analytics.fees.toLocaleString()}`} sub="Fee Accrued" color="text-blue-400" icon={<BarChart3 size={16}/>} />
              <StatBox label="SMS Health" value={`${smsBalance} Units`} sub="Messaging Units" color="text-orange-400" icon={<Activity size={16}/>} />
            </div>

            <div className="bg-[#111114] p-1.5 rounded-2xl border border-slate-800 inline-flex gap-1 overflow-x-auto max-w-full">
              {['analytics', 'pricing', 'ledger', 'vault'].map((t) => (
                <button key={t} onClick={() => setActiveTab(t)} className={`px-6 py-2 rounded-xl text-xs font-black uppercase transition-all ${activeTab === t ? 'bg-slate-800 text-emerald-400' : 'text-slate-500'}`}>{t}</button>
              ))}
            </div>

            {/* ⚡ NEW: PRICING ENGINE TAB ⚡ */}
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
                    <option value="FAILED_VENDING">Failed</option>
                    <option value="REFUNDED">Refunded</option>
                    <option value="FAILED_FUNDS_MISMATCH">Rate Mismatch</option> 
                  </select>
                  <button onClick={exportCSV} className="flex items-center gap-2 bg-slate-800 border border-slate-700 px-6 py-3 rounded-xl text-sm font-bold hover:bg-slate-700"><Download size={16} /> Export</button>
                </div>

                <div className="overflow-x-auto min-h-[400px] flex flex-col justify-between">
                  {/* ⚡ UPGRADED ADMIN TABLE FOR NEW COLUMNS ⚡ */}
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
                          {/* ⚡ NEW: PROVIDER DATA COLUMN ⚡ */}
                          <td className="py-4 px-2 min-w-[180px]">
                            <p className="text-slate-300 font-mono text-[10px] tracking-wider mb-0.5">ID: {tx.request_id || 'N/A'}</p>
                            {tx.service_category === 'ELECTRICITY' && tx.status === 'SUCCESS' ? (
                                <div className="text-[9px]">
                                    <p className="text-orange-400 font-bold tracking-widest">{tx.purchased_code ? tx.purchased_code.replace(/token\s*[:\-]*\s*/gi, '').trim() : 'N/A'}</p>
                                    <p className="text-slate-500">{tx.units || 'N/A'} kWh</p>
                                </div>
                            ) : (
                                <p className="text-[9px] text-slate-600 italic">No Token Generated</p>
                            )}
                          </td>
                          <td className="py-4 px-2 min-w-[120px]">
                            <p className="text-white font-black">₦{tx.amount_naira.toLocaleString()}</p>
                            <p className="text-[10px] text-emerald-500 font-mono">${(tx.amount_usdt || tx.amount_crypto || 0).toString()} Paid</p>
                          </td>
                          <td className="py-4 px-2">
                            <div className="flex flex-col items-start gap-2">
                              <span className={`text-[9px] font-black px-2 py-1 rounded tracking-widest uppercase ${
                                tx.status === 'SUCCESS' ? 'bg-emerald-500/10 text-emerald-500' : 
                                tx.status === 'REFUNDED' ? 'bg-blue-500/10 text-blue-400' :
                                tx.status === 'FAILED_FUNDS_MISMATCH' ? 'bg-purple-500/10 text-purple-400' :
                                'bg-red-500/10 text-red-500'
                              }`}>
                                {tx.status}
                              </span>
                              {/* ⚡ ALLOW REFUNDS FOR MISMATCHES TOO ⚡ */}
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
               <div className="grid grid-cols-1 md:grid-cols-2 gap-6 animate-in fade-in">
                  <div className="bg-[#111114] border border-slate-800 rounded-3xl p-6">
                    <h3 className="text-xs font-black uppercase text-slate-500 mb-6 flex items-center gap-2"><Users size={14}/> User Acquisition</h3>
                    <div className="flex items-baseline gap-2">
                      <span className="text-4xl font-black">{analytics.users}</span>
                      <span className="text-emerald-500 text-xs font-bold">Total Unique Wallets</span>
                    </div>
                  </div>
                  <div className="bg-[#111114] border border-slate-800 rounded-3xl p-6">
                    <h3 className="text-xs font-black uppercase text-slate-500 mb-6 flex items-center gap-2"><Activity size={14}/> Transaction Volume</h3>
                    <div className="flex items-baseline gap-2">
                      <span className="text-4xl font-black">₦{analytics.vol.toLocaleString()}</span>
                      <span className="text-slate-500 text-xs">Gross Vended Value</span>
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
