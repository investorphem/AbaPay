"use client";

import { useState, useEffect, useMemo } from "react";
import { createWalletClient, createPublicClient, custom, http, formatUnits, defineChain } from "viem";
import { 
  Lock, ArrowDownToLine, Wallet, ShieldAlert, Activity, 
  Database, RefreshCcw, Globe, Zap, ExternalLink, 
  Search, Download, Users, BarChart3, Banknote,
  ChevronLeft, ChevronRight
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

const ABAPAY_ADMIN_ABI = [
  {"inputs":[],"name":"owner","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"tokenAddress","type":"address"}],"name":"withdrawFunds","outputs":[],"stateMutability":"nonpayable","type":"function"}
];

const ERC20_ABI = [
  {"inputs":[{"internalType":"address","name":"account","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"}
];

// UPGRADED: Added cUSD and exact USD₮ symbol
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
    await Promise.all([fetchCloudLedger(), fetchOnChainBalances(), fetchVtPassHealth()]);
    setIsFetching(false);
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
                            (tx.wallet_address || "").toLowerCase().includes(searchLower);
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
    const headers = "Date,Status,Network,Service,Account,Naira,USDT,Hash\n";
    const rows = filteredTx.map(tx => `${tx.created_at},${tx.status},${tx.network},${tx.service_category},${tx.account_number},${tx.amount_naira},${tx.amount_usdt},${tx.tx_hash}`).join("\n");
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

            <div className="bg-[#111114] p-1.5 rounded-2xl border border-slate-800 inline-flex gap-1">
              {['analytics', 'ledger', 'vault'].map((t) => (
                <button key={t} onClick={() => setActiveTab(t)} className={`px-6 py-2 rounded-xl text-xs font-black uppercase transition-all ${activeTab === t ? 'bg-slate-800 text-emerald-400' : 'text-slate-500'}`}>{t}</button>
              ))}
            </div>

            {/* LEDGER TAB */}
            {activeTab === 'ledger' && (
              <div className="bg-[#111114] border border-slate-800 rounded-3xl p-6 animate-in fade-in">
                <div className="flex flex-col lg:flex-row gap-4 mb-6">
                  <div className="flex-1 relative">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-600" size={16} />
                    <input type="text" placeholder="Search by Network, Account or Wallet..." className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-12 pr-4 py-3 text-sm focus:border-emerald-500 outline-none" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
                  </div>
                  <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className="bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-300">
                    <option value="ALL">All Status</option>
                    <option value="SUCCESS">Success</option>
                    <option value="FAILED_VENDING">Failed</option>
                  </select>
                  <button onClick={exportCSV} className="flex items-center gap-2 bg-slate-800 border border-slate-700 px-6 py-3 rounded-xl text-sm font-bold hover:bg-slate-700"><Download size={16} /> Export</button>
                </div>

                <div className="overflow-x-auto min-h-[400px] flex flex-col justify-between">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="text-slate-500 border-b border-slate-800 text-[10px] uppercase">
                        <th className="pb-4 px-2">Timestamp</th>
                        <th className="pb-4 px-2">Product & Service</th>
                        <th className="pb-4 px-2">Financials</th>
                        <th className="pb-4 px-2">Status</th>
                        <th className="pb-4 px-2 text-right">On-Chain</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {currentTransactions.map((tx) => (
                        <tr key={tx.id} className="hover:bg-slate-900/40">
                          <td className="py-4 px-2">
                            <p className="text-white font-medium">{new Date(tx.created_at).toLocaleTimeString()}</p>
                            <p className="text-[10px] text-slate-600">{new Date(tx.created_at).toLocaleDateString()}</p>
                          </td>
                          <td className="py-4 px-2">
                            <p className="text-slate-200 font-bold uppercase">{tx.network || 'N/A'}</p>
                            <p className="text-[10px] text-slate-500 uppercase tracking-wider">{tx.service_category} • {tx.account_number}</p>
                          </td>
                          <td className="py-4 px-2">
                            <p className="text-white font-black">₦{tx.amount_naira.toLocaleString()}</p>
                            <p className="text-[10px] text-emerald-500">${tx.amount_usdt} Paid</p>
                          </td>
                          <td className="py-4 px-2">
                            <span className={`text-[10px] font-black px-2 py-1 rounded ${tx.status === 'SUCCESS' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-red-500/10 text-red-500'}`}>{tx.status}</span>
                          </td>
                          <td className="py-4 px-2 text-right">
                             <a href={`https://${isMainnet ? '' : 'sepolia.'}celoscan.io/tx/${tx.tx_hash}`} target="_blank" className="text-slate-600 hover:text-emerald-400"><ExternalLink size={14} className="ml-auto" /></a>
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

            {/* VAULT TAB (Now 3 Columns for 3 Tokens) */}
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
