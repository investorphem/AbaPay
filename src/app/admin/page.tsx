"use client";

import { useState, useEffect, useMemo } from "react";
import { createWalletClient, createPublicClient, custom, http, formatUnits, parseUnits } from "viem";
import { celo, celoSepolia, base, baseSepolia } from "viem/chains"; 
import { 
  Lock, ArrowDownToLine, Wallet, ShieldAlert, Activity, 
  Database, RefreshCcw, Globe, Zap, ExternalLink, 
  Search, Download, Users, BarChart3, Banknote,
  ChevronLeft, ChevronRight, Loader2, Save, Gauge, RefreshCw, Smartphone, Star, Edit3, Power
} from "lucide-react";
import { supabase } from "@/utils/supabase";
import { celoAttributionSuffix } from "@/lib/attribution";
import { AdminAgentPanel } from "@/components/AdminAgentPanel";
import { AdminOpsPanel } from "@/components/AdminOpsPanel";

import { TELECOM_PROVIDERS, INTERNET_PROVIDERS, CABLE_PROVIDERS_LIST, EDUCATION_PROVIDERS } from "@/constants";
import { ELECTRICITY_DISCOS } from "../discos"; 

// ⚡ V2/V3 replaced the old one-shot `withdrawFunds` with a timelocked
// queue → wait 24h → execute flow (see contracts/AbaPayV3.sol). `withdrawFunds`
// only exists on the original V1 contract, so it's kept here purely as a
// fallback for chains that haven't been upgraded yet.
const ABAPAY_ADMIN_ABI = [
  {"inputs":[],"name":"owner","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"tokenAddress","type":"address"}],"name":"withdrawFunds","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"address","name":"tokenAddress","type":"address"},{"internalType":"address","name":"recipient","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"refundUser","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"address","name":"tokenAddress","type":"address"},{"internalType":"address","name":"destination","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"queueWithdrawal","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"address","name":"tokenAddress","type":"address"}],"name":"cancelWithdrawal","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"address","name":"tokenAddress","type":"address"}],"name":"executeWithdrawal","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"address","name":"","type":"address"}],"name":"pendingWithdrawals","outputs":[{"internalType":"uint256","name":"amount","type":"uint256"},{"internalType":"uint256","name":"executableAt","type":"uint256"},{"internalType":"address","name":"destination","type":"address"}],"stateMutability":"view","type":"function"},
  // ⚡ CONTRACT CONTROLS TAB — V2/V3 only. Reads/writes revert (or are simply absent) on V1,
  // which the Contract tab's per-chain "supported: false" detection (mirroring the
  // withdrawal pattern above) already accounts for.
  {"inputs":[],"name":"relayer","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"paused","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"","type":"address"}],"name":"isSupportedToken","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"","type":"address"}],"name":"maxAgentPaymentPerTx","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"","type":"address"}],"name":"maxRefundPerTx","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"newRelayer","type":"address"}],"name":"setRelayer","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"address","name":"tokenAddress","type":"address"},{"internalType":"bool","name":"status","type":"bool"}],"name":"setTokenSupport","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"address","name":"tokenAddress","type":"address"},{"internalType":"uint256","name":"maxAmount","type":"uint256"}],"name":"setMaxAgentPayment","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"address","name":"tokenAddress","type":"address"},{"internalType":"uint256","name":"maxAmount","type":"uint256"}],"name":"setMaxRefund","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[],"name":"pause","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[],"name":"unpause","outputs":[],"stateMutability":"nonpayable","type":"function"}
];

// `supported: false` means the contract has no queueWithdrawal/pendingWithdrawals at all
// (the original V1 ABI) — those chains still use the old one-shot withdrawFunds().
type QueuedWithdrawal =
  | { supported: false }
  | { supported: true; amount: bigint; executableAt: number; destination: string };

const ERC20_ABI = [
  {"inputs":[{"internalType":"address","name":"account","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"recipient","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"transfer","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"}
];

// ⚡ MULTI-CHAIN TOKENS CONFIG ⚡
const TOKENS = {
  "USD₮": { decimals: 6, celoMainnet: "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e", celoSepolia: "0xd077A400968890Eacc75cdc901F0356c943e4fDb", baseMainnet: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", baseSepolia: "0x1d5728a887e1fa1a191467094ac7761d019b4c2c" },
  "USDC": { decimals: 6, celoMainnet: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", celoSepolia: "0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B", baseMainnet: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", baseSepolia: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
  "USDm": { decimals: 18, celoMainnet: "0x765DE816845861e75A25fCA122bb6898B8B1282a", celoSepolia: "0xdE9e4C3ce781b4bA68120d6261cbad65ce0aB00b" } // Exclusive to Celo
};

const ITEMS_PER_PAGE = 10;
type TimeFilter = 'TODAY' | 'WEEK' | 'MONTH' | 'ALL';

export default function AdminDashboard() {
  const [address, setAddress] = useState<string | null>(null);
  const [client, setClient] = useState<any>(null);

  const [isOwner, setIsOwner] = useState<boolean | null>(null);
  const [isAuthenticating, setIsAuthenticating] = useState(true); 
  const [authError, setAuthError] = useState(""); 

  // ⚡ SPLIT VAULT BALANCES ⚡
  const [celoVaults, setCeloVaults] = useState({ usdt: "0.00", usdc: "0.00", usdm: "0.00" });
  const [baseVaults, setBaseVaults] = useState({ usdt: "0.00", usdc: "0.00" });

  // ⚡ TIMELOCKED WITHDRAWALS (V2/V3) — keyed by `${network}-${tokenSymbol}` ⚡
  const [queuedWithdrawals, setQueuedWithdrawals] = useState<Record<string, QueuedWithdrawal>>({});
  const [withdrawalBusyKey, setWithdrawalBusyKey] = useState<string | null>(null);

  // ⚡ CONTRACT CONTROLS (V2/V3 owner functions) — per-chain state, keyed by network ⚡
  const [contractControls, setContractControls] = useState<Record<'CELO' | 'BASE', {
    supported: boolean;
    relayer?: string;
    paused?: boolean;
    tokens?: Record<string, { supported: boolean; agentCap: string; refundCap: string }>;
  }>>({ CELO: { supported: false }, BASE: { supported: false } });
  const [ccBusyKey, setCcBusyKey] = useState<string | null>(null);
  const [ccInputs, setCcInputs] = useState<Record<string, string>>({});

  const [vtBalance, setVtBalance] = useState("0.00"); 
  const [smsBalance, setSmsBalance] = useState("0");    
  const [status, setStatus] = useState("");
  const [activeTab, setActiveTab] = useState("analytics");
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('ALL'); 

  const [dbTransactions, setDbTransactions] = useState<any[]>([]);
  const [dbUsers, setDbUsers] = useState<any[]>([]); 
  const [dbWallets, setDbWallets] = useState<any[]>([]); 
  const [allWalletsMap, setAllWalletsMap] = useState<any[]>([]); 

  const [isFetching, setIsFetching] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [identitySearchTerm, setIdentitySearchTerm] = useState(""); 
  const [filterStatus, setFilterStatus] = useState("ALL");

  const [currentPage, setCurrentPage] = useState(1);
  const [processingRefundId, setProcessingRefundId] = useState<string | null>(null);
  const [isRequeryingId, setIsRequeryingId] = useState<string | null>(null); 

  const [currentExchangeRate, setCurrentExchangeRate] = useState<string>("Loading...");
  const [newExchangeRate, setNewExchangeRate] = useState<string>("");
  const [isUpdatingRate, setIsUpdatingRate] = useState(false);

  const [killSwitches, setKillSwitches] = useState<Record<string, boolean>>({});
  const [isUpdatingSwitches, setIsUpdatingSwitches] = useState(false);

  // 🔐 Signed session headers proving to the backend that we are the contract owner
  const [adminHeaders, setAdminHeaders] = useState<Record<string, string>>({});

  // ⚡ SMART MAINNET & DUAL CONTRACT ROUTING ⚡
  const isMainnet = process.env.NEXT_PUBLIC_NETWORK === "mainnet" || process.env.NEXT_PUBLIC_NETWORK === "celo" || process.env.NEXT_PUBLIC_NETWORK === "base";
  const isLive = process.env.NEXT_PUBLIC_APP_MODE === "live";

  const CELO_CONTRACT = (process.env.NEXT_PUBLIC_ABAPAY_CELO_ADDRESS || process.env.NEXT_PUBLIC_ABAPAY_ADDRESS) as `0x${string}`;
  const BASE_CONTRACT = (process.env.NEXT_PUBLIC_ABAPAY_BASE_ADDRESS || process.env.NEXT_PUBLIC_ABAPAY_ADDRESS) as `0x${string}`;

  useEffect(() => {
    async function initAdmin() {
      if (typeof window !== "undefined" && (window as any).ethereum) {
        setIsAuthenticating(true);
        setAuthError("");
        try {
          // Temporarily connect to Celo just to verify ownership (assuming same owner wallet for both chains)
          const tempChain = isMainnet ? celo : celoSepolia;
          const walletClient = createWalletClient({ chain: tempChain, transport: custom((window as any).ethereum) });
          const [account] = await walletClient.requestAddresses();
          setAddress(account);
          setClient(walletClient);

          const publicClient = createPublicClient({ chain: tempChain, transport: http() });

          // Fallback bypass if CELO_CONTRACT is not set yet, but BASE_CONTRACT is
          const targetCheckContract = (CELO_CONTRACT && CELO_CONTRACT.length === 42) ? CELO_CONTRACT : BASE_CONTRACT;
          const targetCheckChain = (CELO_CONTRACT && CELO_CONTRACT.length === 42) ? tempChain : (isMainnet ? base : baseSepolia);

          const contractChecker = createPublicClient({ chain: targetCheckChain, transport: http() });

          const contractOwner = await contractChecker.readContract({
            address: targetCheckContract,
            abi: ABAPAY_ADMIN_ABI,
            functionName: 'owner',
          }) as string;

          if (account.toLowerCase() === contractOwner.toLowerCase()) {
            setIsOwner(true);
            // 🔐 Sign a one-time session message so backend admin APIs can verify us server-side
            const timestamp = Date.now().toString();
            const signature = await walletClient.signMessage({ account, message: `AbaPay Admin Login: ${timestamp}` });
            const headers = { 'x-admin-address': account, 'x-admin-signature': signature, 'x-admin-timestamp': timestamp };
            setAdminHeaders(headers);
            refreshAllData(headers);
          } else {
            setIsOwner(false);
            setAuthError("The connected wallet is not the owner of this contract.");
          }
        } catch (error) { 
          setIsOwner(false);
          setAuthError("Failed to read Smart Contract. Are you on the right network?");
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
  }, [CELO_CONTRACT, BASE_CONTRACT, isMainnet]);

  const refreshAllData = async (headersOverride?: Record<string, string>) => {
    const authHeaders = headersOverride || adminHeaders;
    setIsFetching(true);
    await fetchOnChainBalances();
    await fetchContractControls();
    await fetchVtPassHealth(authHeaders);

    try {
        const res = await fetch('/api/admin/data', { headers: authHeaders });
        const data = await res.json();
        if (data.success) {
            setDbTransactions(data.transactions);
            setDbUsers(data.users);
            setDbWallets(data.wallets);
            setAllWalletsMap(data.allWallets || []);
            if (data.settings) {
                setCurrentExchangeRate(data.settings.exchange_rate.toString());
                setNewExchangeRate(data.settings.exchange_rate.toString());
                if (data.settings.kill_switches) setKillSwitches(data.settings.kill_switches);
            }
        }
    } catch (error) {
        console.error("Failed to sync backend data.");
    }
    setIsFetching(false);
  };

  const updateExchangeRate = async () => {
    if (!newExchangeRate || isNaN(Number(newExchangeRate))) return alert("Invalid rate");
    setIsUpdatingRate(true);
    try {
      const res = await fetch('/api/admin/rate', { method: 'POST', headers: { 'Content-Type': 'application/json', ...adminHeaders }, body: JSON.stringify({ newRate: newExchangeRate }) });
      const data = await res.json();
      if (data.success) {
        alert("Rate successfully updated globally!");
        setCurrentExchangeRate(newExchangeRate);
      }
    } catch (e) {} finally { setIsUpdatingRate(false); }
  };

  const handleAdjustPoints = async (isUser: boolean, id: string, currentPoints: number) => {
      const input = prompt(`Update AbaPoints for ${isUser ? 'Phone' : 'Wallet'} ${id}:\nCurrent Points: ${currentPoints}`, currentPoints.toString());
      if (input === null) return; 

      const newPoints = parseFloat(input);
      if (isNaN(newPoints) || newPoints < 0) return alert("Invalid points value.");

      try {
          const res = await fetch('/api/admin/action', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...adminHeaders },
              body: JSON.stringify({ action: 'ADJUST_POINTS', payload: { isUser, id, newPoints } })
          });
          const data = await res.json();
          if (data.success) {
              alert("Points successfully updated!");
              refreshAllData(); 
          } else alert("Failed to update points.");
      } catch (e) { alert("Network error."); }
  };

    const toggleKillSwitch = async (serviceKey: string, newValue: boolean) => {
      setIsUpdatingSwitches(true);

      // 1. Save the old state just in case we need to revert
      const previousSwitches = { ...killSwitches };
      const newSwitches = { ...killSwitches, [serviceKey]: newValue };

      // 2. Optimistic UI update (makes the button feel instant)
      setKillSwitches(newSwitches); 

      try {
          const res = await fetch('/api/admin/action', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...adminHeaders },
              body: JSON.stringify({ action: 'UPDATE_KILL_SWITCHES', payload: { switches: newSwitches } })
          });

          const data = await res.json();

          // 3. ⚡ THE FIX: Actually check if the database saved it!
          if (!data.success) {
              alert(`Database Save Failed: ${data.message || 'Unknown error'}`);
              setKillSwitches(previousSwitches); // Revert the toggle on screen
          }
      } catch (e) { 
          alert("Network error updating switches."); 
          setKillSwitches(previousSwitches); // Revert the toggle on screen
      }
      finally { setIsUpdatingSwitches(false); }
  };

  // ⚡ MULTI-CHAIN SILENT BALANCE FETCHER ⚡
  const fetchOnChainBalances = async () => {
    const celoPublic = createPublicClient({ chain: isMainnet ? celo : celoSepolia, transport: http() });
    const basePublic = createPublicClient({ chain: isMainnet ? base : baseSepolia, transport: http() });

    try {
      const newQueued: Record<string, QueuedWithdrawal> = {};

      // Safe check: Only fetch Celo if the address is a valid 42-character hex string
      if (CELO_CONTRACT && CELO_CONTRACT.length === 42) {
          const cUsdtBal = await celoPublic.readContract({ address: (isMainnet ? TOKENS["USD₮"].celoMainnet : TOKENS["USD₮"].celoSepolia) as `0x${string}`, abi: ERC20_ABI, functionName: 'balanceOf', args: [CELO_CONTRACT] }) as bigint;
          const cUsdcBal = await celoPublic.readContract({ address: (isMainnet ? TOKENS["USDC"].celoMainnet : TOKENS["USDC"].celoSepolia) as `0x${string}`, abi: ERC20_ABI, functionName: 'balanceOf', args: [CELO_CONTRACT] }) as bigint;
          const cUsdmBal = await celoPublic.readContract({ address: (isMainnet ? TOKENS["USDm"].celoMainnet : TOKENS["USDm"].celoSepolia) as `0x${string}`, abi: ERC20_ABI, functionName: 'balanceOf', args: [CELO_CONTRACT] }) as bigint;

          setCeloVaults({
              usdt: formatUnits(cUsdtBal, TOKENS["USD₮"].decimals),
              usdc: formatUnits(cUsdcBal, TOKENS["USDC"].decimals),
              usdm: formatUnits(cUsdmBal, TOKENS["USDm"].decimals),
          });

          for (const symbol of ['USD₮', 'USDC', 'USDm'] as const) {
            const tokenAddr = (isMainnet ? (TOKENS[symbol] as any).celoMainnet : (TOKENS[symbol] as any).celoSepolia) as `0x${string}` | undefined;
            if (!tokenAddr) continue;
            newQueued[`CELO-${symbol}`] = await readPendingWithdrawal(celoPublic, CELO_CONTRACT, tokenAddr);
          }
      }

      // Safe check: Only fetch Base if the address is a valid 42-character hex string
      if (BASE_CONTRACT && BASE_CONTRACT.length === 42) {
          const bUsdtBal = await basePublic.readContract({ address: (isMainnet ? TOKENS["USD₮"].baseMainnet : TOKENS["USD₮"].baseSepolia) as `0x${string}`, abi: ERC20_ABI, functionName: 'balanceOf', args: [BASE_CONTRACT] }) as bigint;
          const bUsdcBal = await basePublic.readContract({ address: (isMainnet ? TOKENS["USDC"].baseMainnet : TOKENS["USDC"].baseSepolia) as `0x${string}`, abi: ERC20_ABI, functionName: 'balanceOf', args: [BASE_CONTRACT] }) as bigint;

          setBaseVaults({
              usdt: formatUnits(bUsdtBal, TOKENS["USD₮"].decimals),
              usdc: formatUnits(bUsdcBal, TOKENS["USDC"].decimals)
          });

          for (const symbol of ['USD₮', 'USDC'] as const) {
            const tokenAddr = (isMainnet ? (TOKENS[symbol] as any).baseMainnet : (TOKENS[symbol] as any).baseSepolia) as `0x${string}` | undefined;
            if (!tokenAddr) continue;
            newQueued[`BASE-${symbol}`] = await readPendingWithdrawal(basePublic, BASE_CONTRACT, tokenAddr);
          }
      }

      setQueuedWithdrawals(newQueued);
    } catch (error) { console.error("Failed to fetch multi-chain vault balances", error); }
  };

  // Reads pendingWithdrawals(token). Distinguishes "V1 contract, function doesn't exist"
  // (call reverts) from "V2/V3 contract, nothing queued yet" (call succeeds, executableAt=0) —
  // callers need to know which withdrawal flow (old one-shot vs new timelocked) applies.
  const readPendingWithdrawal = async (
    publicClient: any,
    contract: `0x${string}`,
    tokenAddr: `0x${string}`
  ): Promise<QueuedWithdrawal> => {
    try {
      const [amount, executableAt, destination] = await publicClient.readContract({
        address: contract,
        abi: ABAPAY_ADMIN_ABI,
        functionName: 'pendingWithdrawals',
        args: [tokenAddr],
      }) as [bigint, bigint, string];

      return { supported: true, amount, executableAt: Number(executableAt), destination };
    } catch {
      return { supported: false };
    }
  };

  // ⚡ CONTRACT CONTROLS — reads relayer/paused/token-support/caps for both chains.
  // Same "call reverts => V1, no such function" detection as readPendingWithdrawal.
  const fetchContractControls = async () => {
    const celoPublic = createPublicClient({ chain: isMainnet ? celo : celoSepolia, transport: http() });
    const basePublic = createPublicClient({ chain: isMainnet ? base : baseSepolia, transport: http() });

    const readOneChain = async (
      publicClient: any,
      contract: `0x${string}`,
      symbols: readonly string[],
      chainKey: 'celoMainnet' | 'baseMainnet',
      chainKeyTest: 'celoSepolia' | 'baseSepolia'
    ) => {
      try {
        const [relayer, paused] = await Promise.all([
          publicClient.readContract({ address: contract, abi: ABAPAY_ADMIN_ABI, functionName: 'relayer' }) as Promise<string>,
          publicClient.readContract({ address: contract, abi: ABAPAY_ADMIN_ABI, functionName: 'paused' }) as Promise<boolean>,
        ]);

        const tokens: Record<string, { supported: boolean; agentCap: string; refundCap: string }> = {};
        for (const symbol of symbols) {
          const tokenAddr = (isMainnet ? (TOKENS as any)[symbol]?.[chainKey] : (TOKENS as any)[symbol]?.[chainKeyTest]) as `0x${string}` | undefined;
          if (!tokenAddr) continue;
          const [supported, agentCap, refundCap] = await Promise.all([
            publicClient.readContract({ address: contract, abi: ABAPAY_ADMIN_ABI, functionName: 'isSupportedToken', args: [tokenAddr] }) as Promise<boolean>,
            publicClient.readContract({ address: contract, abi: ABAPAY_ADMIN_ABI, functionName: 'maxAgentPaymentPerTx', args: [tokenAddr] }) as Promise<bigint>,
            publicClient.readContract({ address: contract, abi: ABAPAY_ADMIN_ABI, functionName: 'maxRefundPerTx', args: [tokenAddr] }) as Promise<bigint>,
          ]);
          tokens[symbol] = {
            supported,
            agentCap: formatUnits(agentCap, (TOKENS as any)[symbol].decimals),
            refundCap: formatUnits(refundCap, (TOKENS as any)[symbol].decimals),
          };
        }

        return { supported: true, relayer, paused, tokens };
      } catch {
        return { supported: false };
      }
    };

    const [celoResult, baseResult] = await Promise.all([
      CELO_CONTRACT && CELO_CONTRACT.length === 42
        ? readOneChain(celoPublic, CELO_CONTRACT, ['USD₮', 'USDC', 'USDm'], 'celoMainnet', 'celoSepolia')
        : Promise.resolve({ supported: false }),
      BASE_CONTRACT && BASE_CONTRACT.length === 42
        ? readOneChain(basePublic, BASE_CONTRACT, ['USD₮', 'USDC'], 'baseMainnet', 'baseSepolia')
        : Promise.resolve({ supported: false }),
    ]);

    setContractControls({ CELO: celoResult, BASE: baseResult });
  };

  // Shared prelude for every contract-control write: resolve chain/contract, switch the
  // admin wallet onto it if needed. Mirrors the pattern already used for withdrawals/refunds.
  const prepareContractWrite = async (network: 'CELO' | 'BASE') => {
    if (!client || !address) { alert('Connect your admin wallet first.'); return null; }
    const targetChain = network === 'BASE' ? (isMainnet ? base : baseSepolia) : (isMainnet ? celo : celoSepolia);
    const targetContract = network === 'BASE' ? BASE_CONTRACT : CELO_CONTRACT;
    const currentChainId = await client.getChainId();
    if (currentChainId !== targetChain.id) await client.switchChain({ id: targetChain.id });
    return { targetChain, targetContract };
  };

  const handleSetRelayer = async (network: 'CELO' | 'BASE') => {
    const key = `${network}-relayer`;
    const newRelayer = (ccInputs[key] || '').trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(newRelayer)) return alert('Enter a valid 0x address (or the zero address to disable the agent).');
    if (!confirm(`Set the ${network} relayer to ${newRelayer}?\n\nThis changes which address is authorised to call payBillFor() on behalf of every user with an active allowance.`)) return;

    setCcBusyKey(key);
    try {
      const prep = await prepareContractWrite(network);
      if (!prep) return;
      const hash = await client.writeContract({
        chain: prep.targetChain, account: address, address: prep.targetContract,
        abi: ABAPAY_ADMIN_ABI, functionName: 'setRelayer', args: [newRelayer],
        dataSuffix: celoAttributionSuffix(prep.targetChain),
      });
      alert(`Relayer updated! Hash: ${hash.slice(0, 10)}`);
      setTimeout(() => fetchContractControls(), 3000);
    } catch (e: any) {
      alert(e?.shortMessage || 'Failed to update relayer.');
    } finally {
      setCcBusyKey(null);
    }
  };

  const handleTogglePause = async (network: 'CELO' | 'BASE', currentlyPaused: boolean) => {
    const key = `${network}-pause`;
    const action = currentlyPaused ? 'unpause' : 'pause';
    if (!confirm(currentlyPaused
      ? `Unpause the ${network} contract? Payments and agent spending resume immediately.`
      : `⚠️ PAUSE the ${network} contract?\n\nThis immediately halts ALL payments (payBill, payBillFor) and agent spending on this chain. Refunds/withdrawals stay available. Use this if you suspect a live exploit or a compromised relayer key.`
    )) return;

    setCcBusyKey(key);
    try {
      const prep = await prepareContractWrite(network);
      if (!prep) return;
      const hash = await client.writeContract({
        chain: prep.targetChain, account: address, address: prep.targetContract,
        abi: ABAPAY_ADMIN_ABI, functionName: action, args: [],
        dataSuffix: celoAttributionSuffix(prep.targetChain),
      });
      alert(`${action === 'pause' ? 'Paused' : 'Unpaused'}! Hash: ${hash.slice(0, 10)}`);
      setTimeout(() => fetchContractControls(), 3000);
    } catch (e: any) {
      alert(e?.shortMessage || `Failed to ${action}.`);
    } finally {
      setCcBusyKey(null);
    }
  };

  const handleToggleTokenSupport = async (network: 'CELO' | 'BASE', symbol: string, currentlySupported: boolean) => {
    const key = `${network}-${symbol}-support`;
    const tokenAddr = (isMainnet ? (TOKENS as any)[symbol]?.[network === 'BASE' ? 'baseMainnet' : 'celoMainnet'] : (TOKENS as any)[symbol]?.[network === 'BASE' ? 'baseSepolia' : 'celoSepolia']) as `0x${string}` | undefined;
    if (!tokenAddr) return alert(`${symbol} is not configured on ${network}.`);
    if (!confirm(currentlySupported
      ? `Stop accepting ${symbol} on ${network}? Existing balances are unaffected; payBill/payBillFor for this token will revert until re-enabled.`
      : `Start accepting ${symbol} on ${network}?`
    )) return;

    setCcBusyKey(key);
    try {
      const prep = await prepareContractWrite(network);
      if (!prep) return;
      const hash = await client.writeContract({
        chain: prep.targetChain, account: address, address: prep.targetContract,
        abi: ABAPAY_ADMIN_ABI, functionName: 'setTokenSupport', args: [tokenAddr, !currentlySupported],
        dataSuffix: celoAttributionSuffix(prep.targetChain),
      });
      alert(`${symbol} support updated! Hash: ${hash.slice(0, 10)}`);
      setTimeout(() => fetchContractControls(), 3000);
    } catch (e: any) {
      alert(e?.shortMessage || 'Failed to update token support.');
    } finally {
      setCcBusyKey(null);
    }
  };

  const handleSetCap = async (network: 'CELO' | 'BASE', symbol: string, kind: 'agent' | 'refund') => {
    const key = `${network}-${symbol}-${kind}`;
    const raw = (ccInputs[key] || '').trim();
    const decimals = (TOKENS as any)[symbol]?.decimals;
    if (decimals === undefined || isNaN(Number(raw)) || Number(raw) < 0) return alert('Enter a valid, non-negative amount.');
    const tokenAddr = (isMainnet ? (TOKENS as any)[symbol]?.[network === 'BASE' ? 'baseMainnet' : 'celoMainnet'] : (TOKENS as any)[symbol]?.[network === 'BASE' ? 'baseSepolia' : 'celoSepolia']) as `0x${string}` | undefined;
    if (!tokenAddr) return alert(`${symbol} is not configured on ${network}.`);

    const label = kind === 'agent' ? 'per-transaction agent-payment cap' : 'per-transaction refund cap';
    if (!confirm(`Set the ${symbol} ${label} on ${network} to ${raw}?`)) return;

    setCcBusyKey(key);
    try {
      const prep = await prepareContractWrite(network);
      if (!prep) return;
      const amountWei = parseUnits(raw, decimals);
      const hash = await client.writeContract({
        chain: prep.targetChain, account: address, address: prep.targetContract,
        abi: ABAPAY_ADMIN_ABI, functionName: kind === 'agent' ? 'setMaxAgentPayment' : 'setMaxRefund', args: [tokenAddr, amountWei],
        dataSuffix: celoAttributionSuffix(prep.targetChain),
      });
      alert(`Cap updated! Hash: ${hash.slice(0, 10)}`);
      setCcInputs(p => ({ ...p, [key]: '' }));
      setTimeout(() => fetchContractControls(), 3000);
    } catch (e: any) {
      alert(e?.shortMessage || 'Failed to update cap.');
    } finally {
      setCcBusyKey(null);
    }
  };

  const fetchVtPassHealth = async (headersOverride?: Record<string, string>) => {
    try {
      const res = await fetch('/api/admin/health', { headers: headersOverride || adminHeaders });
      const data = await res.json();
      setVtBalance(data.naira);
      setSmsBalance(data.sms);
    } catch (e) { console.error("Failed to fetch VTpass health"); }
  };

  // ⚡ SMART WITHDRAWAL ROUTING ⚡
  //
  // V1 contracts expose one-shot withdrawFunds(). V2/V3 replaced that with a timelocked
  // queueWithdrawal() -> wait 24h -> executeWithdrawal() flow (contracts/AbaPayV3.sol),
  // so a compromised owner key can't unilaterally drain the vault instantly. This function
  // detects which flow the target contract supports and drives it through each stage.
  const handleWithdrawal = async (tokenSymbol: 'USD₮' | 'USDC' | 'USDm', network: 'CELO' | 'BASE') => {
    if (!client || !address) return;
    const key = `${network}-${tokenSymbol}`;

    const balanceToCheck = network === 'CELO'
        ? celoVaults[tokenSymbol.toLowerCase() as keyof typeof celoVaults]
        : baseVaults[tokenSymbol.toLowerCase() as keyof typeof baseVaults];

    try {
      const targetChain = network === 'BASE' ? (isMainnet ? base : baseSepolia) : (isMainnet ? celo : celoSepolia);
      const targetContract = network === 'BASE' ? BASE_CONTRACT : CELO_CONTRACT;
      const tokenAddr = network === 'BASE'
         ? (isMainnet ? (TOKENS[tokenSymbol] as any).baseMainnet : (TOKENS[tokenSymbol] as any).baseSepolia)
         : (isMainnet ? TOKENS[tokenSymbol].celoMainnet : TOKENS[tokenSymbol].celoSepolia);

      const currentChainId = await client.getChainId();
      if (currentChainId !== targetChain.id) await client.switchChain({ id: targetChain.id });

      setWithdrawalBusyKey(key);
      const publicClient = createPublicClient({ chain: targetChain, transport: http() });
      const queued = await readPendingWithdrawal(publicClient, targetContract, tokenAddr);

      let hash: string;

      if (!queued.supported) {
        // V1 — no timelock, withdrawFunds() sends the whole vault straight to the owner.
        if (parseFloat(balanceToCheck) <= 0) return setStatus(`The ${network} ${tokenSymbol} Vault is already empty.`);
        setStatus(`Withdrawing ${tokenSymbol} from ${network}...`);
        hash = await client.writeContract({
            chain: targetChain, address: targetContract, abi: ABAPAY_ADMIN_ABI,
            functionName: 'withdrawFunds', args: [tokenAddr],
            account: address, dataSuffix: celoAttributionSuffix(targetChain),
        });
        setStatus(`Success! Hash: ${hash.slice(0, 10)}`);
      } else if (queued.executableAt === 0) {
        // Nothing queued yet — queue the full vault balance out to the admin's own wallet.
        if (parseFloat(balanceToCheck) <= 0) return setStatus(`The ${network} ${tokenSymbol} Vault is already empty.`);
        const decimals = TOKENS[tokenSymbol].decimals;
        const amountWei = parseUnits(parseFloat(balanceToCheck).toFixed(decimals), decimals);
        setStatus(`Queueing ${tokenSymbol} withdrawal on ${network} (24h timelock)...`);
        hash = await client.writeContract({
            chain: targetChain, address: targetContract, abi: ABAPAY_ADMIN_ABI,
            functionName: 'queueWithdrawal', args: [tokenAddr, address, amountWei],
            account: address, dataSuffix: celoAttributionSuffix(targetChain),
        });
        setStatus(`Queued! Executable in 24h. Hash: ${hash.slice(0, 10)}`);
      } else if (Date.now() < queued.executableAt * 1000) {
        const mins = Math.ceil((queued.executableAt * 1000 - Date.now()) / 60000);
        setStatus(`Withdrawal already queued for ${network} ${tokenSymbol} — executable in ~${mins} min.`);
        return;
      } else {
        setStatus(`Executing queued ${tokenSymbol} withdrawal on ${network}...`);
        hash = await client.writeContract({
            chain: targetChain, address: targetContract, abi: ABAPAY_ADMIN_ABI,
            functionName: 'executeWithdrawal', args: [tokenAddr],
            account: address, dataSuffix: celoAttributionSuffix(targetChain),
        });
        setStatus(`Withdrawn! Hash: ${hash.slice(0, 10)}`);
      }

      setTimeout(() => refreshAllData(), 5000);
    } catch (error) { setStatus("Rejected or Insufficient Gas."); }
    finally { setWithdrawalBusyKey(null); }
  };

  const handleCancelWithdrawal = async (tokenSymbol: 'USD₮' | 'USDC' | 'USDm', network: 'CELO' | 'BASE') => {
    if (!client || !address) return;
    const key = `${network}-${tokenSymbol}`;

    try {
      const targetChain = network === 'BASE' ? (isMainnet ? base : baseSepolia) : (isMainnet ? celo : celoSepolia);
      const targetContract = network === 'BASE' ? BASE_CONTRACT : CELO_CONTRACT;
      const tokenAddr = network === 'BASE'
         ? (isMainnet ? (TOKENS[tokenSymbol] as any).baseMainnet : (TOKENS[tokenSymbol] as any).baseSepolia)
         : (isMainnet ? TOKENS[tokenSymbol].celoMainnet : TOKENS[tokenSymbol].celoSepolia);

      const currentChainId = await client.getChainId();
      if (currentChainId !== targetChain.id) await client.switchChain({ id: targetChain.id });

      setWithdrawalBusyKey(key);
      const hash = await client.writeContract({
          chain: targetChain, address: targetContract, abi: ABAPAY_ADMIN_ABI,
          functionName: 'cancelWithdrawal', args: [tokenAddr],
          account: address, dataSuffix: celoAttributionSuffix(targetChain),
      });
      setStatus(`Withdrawal cancelled for ${network} ${tokenSymbol}. Hash: ${hash.slice(0, 10)}`);
      setTimeout(() => refreshAllData(), 5000);
    } catch (error) { setStatus("Rejected or Insufficient Gas."); }
    finally { setWithdrawalBusyKey(null); }
  };

  // ⚡ SMART REFUND ROUTING ⚡
  const handleRefund = async (tx: any) => {
    try {
      if (!client || !address) return alert("Connect your Admin Wallet first.");
      setProcessingRefundId(tx.id);

      const rawAmount = parseFloat(tx.amount_usdt || tx.amount_crypto);
      if (isNaN(rawAmount) || rawAmount <= 0) throw new Error("Invalid crypto amount found in database.");

      // Treat cUSD legacy tags as USDm
      let tokenSymbol = tx.tokenUsed || tx.token_used || "USD₮"; 
      if (tokenSymbol === 'cUSD') tokenSymbol = 'USDm';

      const tokenData = TOKENS[tokenSymbol as keyof typeof TOKENS];
      if (!tokenData) throw new Error(`Token ${tokenSymbol} is not supported.`);

      // ⚡ DB BLOCKCHAIN FIX APPLIED ⚡
      const isBaseTx = (tx.blockchain || "").toUpperCase().includes("BASE");
      const targetChain = isBaseTx ? (isMainnet ? base : baseSepolia) : (isMainnet ? celo : celoSepolia);
      const targetContract = isBaseTx ? BASE_CONTRACT : CELO_CONTRACT;

      // ⚡ TYPE FIX APPLIED ⚡
      const tokenAddr = isBaseTx ? (isMainnet ? (tokenData as any).baseMainnet : (tokenData as any).baseSepolia) : (isMainnet ? tokenData.celoMainnet : tokenData.celoSepolia);

      // Force admin wallet onto correct network
      const currentChainId = await client.getChainId();
      if (currentChainId !== targetChain.id) {
          alert(`This is a ${isBaseTx ? 'Base' : 'Celo'} transaction. Please approve the network switch in your wallet.`);
          await client.switchChain({ id: targetChain.id });
      }

      const decimals = tokenData.decimals;
      const cleanAmountString = rawAmount.toFixed(decimals);
      const valueInWei = parseUnits(cleanAmountString, decimals);

      // ⚡ ADDED 'chain: targetChain' to bypass viem strict mode error
      const refundHash = await client.writeContract({
          chain: targetChain,
          address: targetContract as `0x${string}`,
          abi: ABAPAY_ADMIN_ABI,
          functionName: 'refundUser',
          args: [tokenAddr, tx.wallet_address, valueInWei],
          account: address,
          dataSuffix: celoAttributionSuffix(targetChain), // Celo attribution only; no-op on Base
      });

      const publicClient = createPublicClient({ chain: targetChain, transport: http() });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: refundHash });
      if (receipt.status !== 'success') throw new Error("Transaction reverted. Vault does not have enough balance.");

      const dbRes = await fetch('/api/admin/refund', { method: 'POST', headers: { 'Content-Type': 'application/json', ...adminHeaders }, body: JSON.stringify({ id: tx.id, refundHash }) });
      if (dbRes.ok) { alert(`Refund confirmed on-chain! Hash: ${refundHash}`); refreshAllData(); } 
      else alert("Crypto refunded successfully, but backend failed to update the database status.");
    } catch (error: any) { alert(`Refund Failed: ${error.message || "Execution Reverted."}`); } 
    finally { setProcessingRefundId(null); }
  };

  const handleRequery = async (tx: any) => {
    if (!tx.request_id) return alert("This transaction has no Provider Request ID to query.");
    setIsRequeryingId(tx.id);
    try {
      const res = await fetch('/api/requery', { method: 'POST', headers: { 'Content-Type': 'application/json', ...adminHeaders }, body: JSON.stringify({ request_id: tx.request_id, tx_hash: tx.tx_hash }) });
      const data = await res.json();
      if (data.success) {
        if (data.status === 'SUCCESS') alert("✅ Transaction was successfully delivered by the provider!");
        else if (data.status === 'FAILED_VENDING') alert("❌ Provider rejected the transaction. It is now marked for a refund.");
        else alert("⏳ Provider is still processing it. Check back later.");
        refreshAllData(); 
      } else alert(`Error: ${data.message}`);
    } catch (error) { alert("Network error while checking status."); } 
    finally { setIsRequeryingId(null); }
  };

  const currentVaultTotal = 
    parseFloat(celoVaults.usdt) + parseFloat(celoVaults.usdc) + parseFloat(celoVaults.usdm) +
    parseFloat(baseVaults.usdt) + parseFloat(baseVaults.usdc);

  const timeFilteredTransactions = useMemo(() => {
    const now = new Date();
    return dbTransactions.filter(tx => {
      const txDate = new Date(tx.created_at);
      if (timeFilter === 'TODAY') return txDate.toDateString() === now.toDateString();
      if (timeFilter === 'WEEK') return txDate >= new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      if (timeFilter === 'MONTH') return txDate.getMonth() === now.getMonth() && txDate.getFullYear() === now.getFullYear();
      return true; 
    });
  }, [dbTransactions, timeFilter]);

  const analytics = useMemo(() => {
    const successTx = timeFilteredTransactions.filter(tx => tx.status === "SUCCESS");
    const totalDeposited = timeFilteredTransactions.reduce((acc, tx) => acc + (parseFloat(tx.amount_usdt || tx.amount_crypto) || 0), 0);
    const totalRefunded = timeFilteredTransactions.filter(tx => tx.status === "REFUNDED").reduce((acc, tx) => acc + (parseFloat(tx.amount_usdt || tx.amount_crypto) || 0), 0);

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
                            (tx.blockchain || "").toLowerCase().includes(searchLower) ||
                            (tx.wallet_address || "").toLowerCase().includes(searchLower) ||
                            (tx.request_id || "").toLowerCase().includes(searchLower);
      const matchesStatus = filterStatus === "ALL" || tx.status === filterStatus;
      return matchesSearch && matchesStatus;
    });
  }, [timeFilteredTransactions, searchTerm, filterStatus]);

  const filteredIdentities = useMemo(() => {
      const searchLower = identitySearchTerm.toLowerCase();
      const matchedUsers = dbUsers.filter(u => u.verified_phone.includes(searchLower));
      const matchedWallets = dbWallets.filter(w => w.wallet_address.toLowerCase().includes(searchLower));
      return { users: matchedUsers, wallets: matchedWallets };
  }, [dbUsers, dbWallets, identitySearchTerm]);

  useEffect(() => { setCurrentPage(1); }, [searchTerm, filterStatus, timeFilter]);

  const totalPages = Math.ceil(filteredTx.length / ITEMS_PER_PAGE);
  const currentTransactions = filteredTx.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE);

  // ⚡ EXPORT CSV WITH BLOCKCHAIN ⚡
  const exportCSV = () => {
    const headers = "Date,Status,Blockchain,Network,Service,Account,Naira,Crypto,Token Used,Transaction ID,Units,Token PIN,Hash\n";
    const rows = filteredTx.map(tx => `${tx.created_at},${tx.status},${tx.blockchain || 'CELO'},${tx.network},${tx.service_category},${tx.account_number},${tx.amount_naira},${tx.amount_usdt || tx.amount_crypto},${tx.token_used || 'USD₮'},${tx.request_id || 'N/A'},${tx.units || 'N/A'},${tx.purchased_code || 'N/A'},${tx.tx_hash}`).join("\n");
    const blob = new Blob([headers + rows], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `AbaPay_Report_${timeFilter}.csv`; a.click();
  };

  const switchGroups = [
      { title: "Airtime", master: "MASTER_AIRTIME", providers: TELECOM_PROVIDERS.map(p => ({ id: `AIRTIME_${p}`, name: p.toUpperCase() })) },
      { title: "Internet Data", master: "MASTER_INTERNET", providers: INTERNET_PROVIDERS.map(p => ({ id: `INTERNET_${p.serviceID}`, name: p.displayName })) },
      { title: "Electricity", master: "MASTER_ELECTRICITY", providers: ELECTRICITY_DISCOS.map(p => ({ id: `ELEC_${p.serviceID}`, name: p.displayName })) },
      { title: "Cable TV", master: "MASTER_CABLE", providers: CABLE_PROVIDERS_LIST.map(p => ({ id: `CABLE_${p.serviceID}`, name: p.displayName })) },
      { title: "Education", master: "MASTER_EDUCATION", providers: EDUCATION_PROVIDERS.map(p => ({ id: `EDU_${p.serviceID}`, name: p.displayName })) }
  ];


  // ⚡ Executes an on-chain refund from the ADMIN'S OWN wallet.
  //
  // refundUser() is onlyOwner by design — we deliberately do NOT give the relayer hot key
  // the power to send vault funds to arbitrary addresses. Money entering the vault is
  // capped on-chain and safe to automate; money leaving it keeps a human in the loop.
  const executeRefundOnChain = async (r: any): Promise<string | null> => {
    if (!client) { alert('Connect your admin wallet first.'); return null; }
    try {
      const isBase = String(r.blockchain).toUpperCase() === 'BASE';
      const contract = isBase ? BASE_CONTRACT : CELO_CONTRACT;
      const chain = isBase ? (isMainnet ? base : baseSepolia) : (isMainnet ? celo : celoSepolia);

      const tokenMeta = (TOKENS as any)[r.token_used];
      if (!tokenMeta) { alert(`Unknown token: ${r.token_used}`); return null; }

      const tokenAddress = isBase
        ? (isMainnet ? tokenMeta.baseMainnet : tokenMeta.baseSepolia)
        : (isMainnet ? tokenMeta.celoMainnet : tokenMeta.celoSepolia);
      if (!tokenAddress) { alert(`${r.token_used} is not available on ${r.blockchain}.`); return null; }

      const amountWei = parseUnits(Number(r.amount_crypto).toFixed(tokenMeta.decimals), tokenMeta.decimals);

      const [acct] = await client.requestAddresses();
      await client.switchChain({ id: chain.id }).catch(() => {});

      // V3 adds a `reason` argument; V2 does not. Try V3 first, fall back to V2.
      let hash: string;
      try {
        hash = await client.writeContract({
          chain, account: acct, address: contract,
          abi: [{ inputs: [
            { name: 'tokenAddress', type: 'address' },
            { name: 'recipient', type: 'address' },
            { name: 'amount', type: 'uint256' },
            { name: 'reason', type: 'string' },
          ], name: 'refundUser', outputs: [], stateMutability: 'nonpayable', type: 'function' }],
          functionName: 'refundUser',
          args: [tokenAddress, r.wallet_address, amountWei, String(r.reason || 'Failed vend').slice(0, 100)],
          dataSuffix: celoAttributionSuffix(chain), // Celo attribution only; no-op on Base
        });
      } catch {
        hash = await client.writeContract({
          chain, account: acct, address: contract,
          abi: ABAPAY_ADMIN_ABI,
          functionName: 'refundUser',
          args: [tokenAddress, r.wallet_address, amountWei],
          dataSuffix: celoAttributionSuffix(chain), // Celo attribution only; no-op on Base
        });
      }

      return hash;
    } catch (e: any) {
      console.error('Refund failed:', e);
      alert(e?.shortMessage || 'Refund transaction failed.');
      return null;
    }
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
              <span className="px-2 py-0.5 rounded text-[10px] font-bold border bg-purple-500/10 text-purple-400 border-purple-500/20">{isMainnet ? 'MAINNET' : 'TESTNET'}</span>
            </div>
          </div>

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

            {/* STATS */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <StatBox label="VTpass Wallet" value={`₦${vtBalance}`} sub="Live Naira Float" color="text-white" icon={<Banknote size={16}/>} />
              <StatBox label={`Global Vaults (${timeFilter})`} value={`$${currentVaultTotal.toFixed(2)}`} sub="Base & Celo Combined" color="text-emerald-500" icon={<Wallet size={16}/>} />
              <StatBox label={`Profit (${timeFilter})`} value={`₦${analytics.fees.toLocaleString()}`} sub="Service Fees Accrued" color="text-blue-400" icon={<BarChart3 size={16}/>} />
              <StatBox label="SMS Health" value={`${smsBalance} Units`} sub="Messaging Units" color="text-orange-400" icon={<Activity size={16}/>} />
            </div>

            <div className="bg-[#111114] p-1.5 rounded-2xl border border-slate-800 flex justify-between items-center max-w-full">
              <div className="flex gap-1 overflow-x-auto no-scrollbar pr-4">
                  {['analytics', 'system', 'agent', 'ops', 'ledger', 'vault', 'contract', 'identity'].map((t) => (
                    <button key={t} onClick={() => setActiveTab(t)} className={`px-6 py-2 rounded-xl text-xs font-black uppercase transition-all whitespace-nowrap ${activeTab === t ? 'bg-slate-800 text-emerald-400' : 'text-slate-500 hover:text-slate-300'}`}>
                        {t === 'system' ? 'Controls' : t}
                    </button>
                  ))}
              </div>
              <button onClick={() => refreshAllData()} className="hidden md:flex items-center justify-center p-2 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-500 transition-colors shrink-0" title="Force Refresh All Data">
                 <RefreshCcw size={16} className={isFetching ? 'animate-spin' : ''} />
              </button>
            </div>

            {/* IDENTITY TAB */}
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
                                       <div key={u.id} className="p-3 flex justify-between items-center hover:bg-slate-800/30 transition-colors rounded-lg group">
                                           <div>
                                               <p className="font-mono font-bold text-slate-300 text-sm">{u.verified_phone}</p>
                                               <p className="text-[9px] text-slate-500 uppercase tracking-widest mt-0.5">Joined: {new Date(u.created_at).toLocaleDateString()}</p>
                                           </div>
                                           <div className="flex items-center gap-4">
                                               <div className="text-right">
                                                   <p className="font-black text-emerald-400 text-lg leading-none">{Number(u.total_points).toFixed(2)}</p>
                                                   <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest mt-1">Total Points</p>
                                               </div>
                                               <button onClick={() => handleAdjustPoints(true, u.id, u.total_points)} className="opacity-0 group-hover:opacity-100 p-2 bg-slate-800 rounded-lg hover:bg-slate-700 text-slate-400 transition-all"><Edit3 size={14}/></button>
                                           </div>
                                       </div>
                                   ))}
                               </div>
                           )}
                       </div>
                    </div>

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
                                       <div key={w.wallet_address} className="p-3 flex justify-between items-center hover:bg-slate-800/30 transition-colors rounded-lg group">
                                           <div>
                                               <p className="font-mono font-medium text-slate-400 text-xs">{w.wallet_address.slice(0, 8)}...{w.wallet_address.slice(-6)}</p>
                                               <p className="text-[9px] text-slate-500 uppercase tracking-widest mt-1">Pending Verification</p>
                                           </div>
                                           <div className="flex items-center gap-4">
                                               <div className="text-right">
                                                   <p className="font-black text-slate-300 text-lg leading-none">{Number(w.unclaimed_points).toFixed(2)}</p>
                                                   <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest mt-1">Unclaimed</p>
                                               </div>
                                               <button onClick={() => handleAdjustPoints(false, w.wallet_address, w.unclaimed_points)} className="opacity-0 group-hover:opacity-100 p-2 bg-slate-800 rounded-lg hover:bg-slate-700 text-slate-400 transition-all"><Edit3 size={14}/></button>
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

            {/* REFUNDS & SUPPORT */}
            {activeTab === 'ops' && (
              <div className="animate-in fade-in">
                <AdminOpsPanel adminHeaders={adminHeaders} onExecuteRefund={executeRefundOnChain} />
              </div>
            )}

            {/* DeAI AGENT CONTROLS */}
            {activeTab === 'agent' && (
              <div className="animate-in fade-in">
                <AdminAgentPanel adminHeaders={adminHeaders} />
              </div>
            )}

            {/* SYSTEM CONTROLS */}
            {activeTab === 'system' && (
              <div className="bg-[#111114] border border-slate-800 rounded-3xl p-8 animate-in fade-in">

                 <div className="flex items-center gap-3 mb-6">
                    <div className="bg-blue-500/10 p-3 rounded-full"><Gauge className="text-blue-400" size={24}/></div>
                    <div>
                      <h2 className="text-xl font-black text-white">Dynamic Pricing Engine</h2>
                      <p className="text-xs font-bold text-slate-500 uppercase tracking-widest mt-1">Global Rate Controller</p>
                    </div>
                 </div>

                 <div className="grid grid-cols-1 md:grid-cols-2 gap-8 bg-slate-900 border border-slate-800 rounded-2xl p-6 mb-10">
                    <div className="border-r border-slate-800 pr-0 md:pr-6">
                       <p className="text-slate-400 text-xs font-bold uppercase tracking-wider mb-2">Live Exchange Rate</p>
                       <p className="text-5xl font-black text-emerald-400 font-mono tracking-tighter">₦{currentExchangeRate}</p>
                    </div>
                    <div>
                       <label className="text-slate-400 text-xs font-bold uppercase tracking-wider mb-2 block">Update Rate</label>
                       <div className="flex flex-col gap-3">
                          <div className="relative">
                            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 font-black">₦</span>
                            <input type="number" value={newExchangeRate} onChange={(e) => setNewExchangeRate(e.target.value)} className="w-full bg-slate-950 border border-slate-700 text-white font-black text-2xl py-4 pl-10 pr-4 rounded-xl outline-none focus:border-blue-500 transition-all"/>
                          </div>
                          <button onClick={updateExchangeRate} disabled={isUpdatingRate || newExchangeRate === currentExchangeRate} className="bg-blue-600 hover:bg-blue-500 text-white font-black py-4 rounded-xl flex items-center justify-center gap-2 transition-all disabled:opacity-50">
                            {isUpdatingRate ? <Loader2 size={18} className="animate-spin"/> : <Save size={18}/>} PUBLISH NEW RATE
                          </button>
                       </div>
                    </div>
                 </div>

                 <div className="flex items-center gap-3 mb-6">
                    <div className="bg-red-500/10 p-3 rounded-full"><Power className="text-red-400" size={24}/></div>
                    <div>
                      <h2 className="text-xl font-black text-white">Provider Kill Switches</h2>
                      <p className="text-xs font-bold text-slate-500 uppercase tracking-widest mt-1">Surgically disable failing API services</p>
                    </div>
                 </div>

                 {/* ⚡ NEW: INTERNATIONAL MASTER SWITCH ⚡ */}
                 <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden mb-6">
                     <div className="bg-slate-800/50 p-5 flex items-center justify-between border-b border-slate-800">
                         <div>
                             <h3 className="font-black text-white text-lg flex items-center gap-2"><Globe size={18} className="text-blue-400"/> International Top-ups</h3>
                             <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mt-0.5">Toggle all foreign airtime/data services globally</p>
                         </div>
                         <button 
                             onClick={() => toggleKillSwitch('MASTER_INTERNATIONAL', killSwitches['MASTER_INTERNATIONAL'] === false)}
                             disabled={isUpdatingSwitches}
                             className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors disabled:opacity-50 ${killSwitches['MASTER_INTERNATIONAL'] !== false ? 'bg-emerald-500' : 'bg-slate-700'}`}
                         >
                             <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${killSwitches['MASTER_INTERNATIONAL'] !== false ? 'translate-x-6' : 'translate-x-1'}`} />
                         </button>
                     </div>
                 </div>

                 <div className="space-y-6">
                    {switchGroups.map((group) => {
                        const isMasterOn = killSwitches[group.master] !== false;

                        return (
                            <div key={group.master} className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
                                <div className="bg-slate-800/50 p-5 flex items-center justify-between border-b border-slate-800">
                                    <h3 className="font-black text-white text-lg">{group.title}</h3>
                                    <button 
                                        onClick={() => toggleKillSwitch(group.master, !isMasterOn)}
                                        disabled={isUpdatingSwitches}
                                        className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors disabled:opacity-50 ${isMasterOn ? 'bg-emerald-500' : 'bg-slate-700'}`}
                                    >
                                        <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${isMasterOn ? 'translate-x-6' : 'translate-x-1'}`} />
                                    </button>
                                </div>

                                <div className={`grid grid-cols-2 md:grid-cols-4 gap-4 p-5 ${!isMasterOn ? 'opacity-30 pointer-events-none grayscale' : ''}`}>
                                    {group.providers.map(provider => {
                                        const isSubOn = killSwitches[provider.id] !== false;
                                        return (
                                            <div key={provider.id} className="flex items-center justify-between p-3 rounded-xl border border-slate-800 bg-slate-950">
                                                <span className="text-xs font-bold text-slate-300 truncate pr-2">{provider.name}</span>
                                                <button 
                                                    onClick={() => toggleKillSwitch(provider.id, !isSubOn)}
                                                    disabled={isUpdatingSwitches}
                                                    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${isSubOn ? 'bg-emerald-500/50' : 'bg-slate-800'}`}
                                                >
                                                    <span className={`inline-block h-3 w-3 transform rounded-full transition-transform ${isSubOn ? 'translate-x-5 bg-emerald-400' : 'translate-x-1 bg-slate-500'}`} />
                                                </button>
                                            </div>
                                        )
                                    })}
                                </div>
                            </div>
                        )
                    })}
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
                    <option value="FAILED_VENDING">Failed (Provider)</option>
                    <option value="FAILED_VTPASS_CRASH">Failed (Network Crash)</option>
                    <option value="FAILED_VERIFICATION">Failed (Verification)</option>
                    <option value="FAILED_FUNDS_MISMATCH">Failed (Rate Mismatch)</option>
                    <option value="REFUNDED">Refunded</option>
                  </select>

                  <button onClick={exportCSV} className="flex items-center gap-2 bg-slate-800 border border-slate-700 px-6 py-3 rounded-xl text-sm font-bold hover:bg-slate-700"><Download size={16} /> Export</button>
                </div>

                <div className="overflow-x-auto min-h-[400px] flex flex-col justify-between">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="text-slate-500 border-b border-slate-800 text-[10px] uppercase">
                        <th className="pb-4 px-2">Details</th>
                        <th className="pb-4 px-2">User Details</th>
                        <th className="pb-4 px-2">Utility Vended</th>
                        <th className="pb-4 px-2">Provider Data</th>
                        <th className="pb-4 px-2">Financials</th>
                        <th className="pb-4 px-2">Status & Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {currentTransactions.map((tx) => {

                        const walletInfo = allWalletsMap.find(w => w.wallet_address?.toLowerCase() === tx.wallet_address?.toLowerCase());
                        const verifiedPhone = walletInfo?.abapay_users?.verified_phone || "N/A";

                        // ⚡ DB BLOCKCHAIN UI FIX APPLIED ⚡
                        const isBaseTx = (tx.blockchain || "").toUpperCase().includes("BASE");

                        return (
                        <tr key={tx.id} className="hover:bg-slate-900/40">

                          <td className="py-4 px-2 min-w-[120px]">
                            <p className="text-white font-medium text-xs mb-1">{new Date(tx.created_at).toLocaleString()}</p>
                            <a href={`https://${isMainnet ? '' : 'sepolia.'}${isBaseTx ? 'basescan.org' : 'celoscan.io'}/tx/${tx.tx_hash}`} target="_blank" className={`text-[9px] ${isBaseTx ? 'text-blue-400' : 'text-emerald-400'} hover:underline flex items-center gap-1 mt-1 font-mono tracking-wider`}>Hash: {tx.tx_hash.slice(0, 8)}... <ExternalLink size={8} /></a>
                          </td>

                          <td className="py-4 px-2 min-w-[150px]">
                             <p className="text-[10px] text-slate-300 font-mono">Wallet: {tx.wallet_address ? `${tx.wallet_address.slice(0,6)}...${tx.wallet_address.slice(-4)}` : 'N/A'}</p>
                             <p className={`text-[10px] mt-1 font-bold ${verifiedPhone !== 'N/A' ? 'text-emerald-500' : 'text-slate-600'}`}>Phone: {verifiedPhone}</p>
                          </td>

                          <td className="py-4 px-2 min-w-[180px]">
                            <p className="text-slate-200 font-bold uppercase flex items-center gap-1">
                                {isBaseTx ? <span className="w-1.5 h-1.5 rounded-full bg-blue-500"></span> : <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>}
                                {tx.blockchain || 'CELO'} • {tx.network || 'N/A'}
                                {tx.payment_method === 'X402' && (
                                  <span className="ml-1 text-[8px] font-black px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400 tracking-widest">x402</span>
                                )}
                            </p>
                            <p className="text-[10px] text-slate-500 uppercase tracking-wider mt-0.5">{tx.service_category}</p>
                            <p className="text-[10px] text-blue-400 font-mono mt-1 font-bold">Acct/Ph: {tx.account_number}</p>
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
                            <p className="text-[10px] text-emerald-500 font-mono">${(tx.amount_usdt || tx.amount_crypto || 0).toString()} {tx.token_used === 'cUSD' ? 'USDm' : (tx.token_used || 'USD₮')}</p>
                          </td>
                          <td className="py-4 px-2">
                            <div className="flex flex-col items-start gap-2">
                                <span className={`text-[9px] font-black px-2 py-1 rounded tracking-widest uppercase ${
                                  tx.status === 'SUCCESS' ? 'bg-emerald-500/10 text-emerald-500' : 
                                  tx.status === 'REFUNDED' ? 'bg-blue-500/10 text-blue-400' :
                                  tx.status === 'PENDING' ? 'bg-orange-500/10 text-orange-400' : 
                                  'bg-red-500/10 text-red-500'
                                }`}>
                                  {tx.status}
                                </span>

                                {tx.error_code && (
                                    <span className="text-[8px] font-mono text-red-400 bg-red-500/5 border border-red-500/10 px-1.5 py-0.5 rounded">
                                        API Code: {tx.error_code}
                                    </span>
                                )}

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

                              {tx.status?.startsWith('FAILED') && (
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
                      )})}
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

            {/* VAULT TAB (NOW MULTI-CHAIN) */}
            {activeTab === 'vault' && (
              <div className="bg-[#111114] border border-slate-800 rounded-3xl p-8 animate-in fade-in slide-in-from-bottom-4">
                <div className="flex flex-col items-center mb-8">
                    <div className="bg-emerald-500/10 rounded-full mb-4 p-4"><Lock className="text-emerald-500" size={32} /></div>
                    <p className="text-slate-500 text-sm text-center max-w-md italic">Multi-Chain Smart Contract Escrow Balances</p>
                    {status && <div className="mt-4 text-xs font-mono text-emerald-400 bg-emerald-500/5 py-2 px-4 rounded border border-emerald-500/10">{status}</div>}
                </div>

                                {/* CELO VAULTS */}
                <h3 className="text-sm font-black text-emerald-500 uppercase tracking-widest mb-4 border-b border-slate-800 pb-2 flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-emerald-500"></span> Celo Network Reserves</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">
                    <div className="bg-slate-900 border border-slate-800 p-6 rounded-3xl text-center">
                        <h2 className="text-4xl font-black mb-1">${Number(parseFloat(celoVaults.usdt).toFixed(4))}</h2>
                        <span className="text-xs text-emerald-500 font-bold uppercase tracking-widest bg-emerald-500/10 px-3 py-1 rounded-full">USD₮ Vault</span>
                        <WithdrawControl tokenSymbol="USD₮" network="CELO" hoverClass="hover:bg-emerald-500" queued={queuedWithdrawals['CELO-USD₮']} busy={withdrawalBusyKey === 'CELO-USD₮'} onWithdraw={handleWithdrawal} onCancel={handleCancelWithdrawal} />
                    </div>
                    <div className="bg-slate-900 border border-slate-800 p-6 rounded-3xl text-center">
                        <h2 className="text-4xl font-black mb-1">${Number(parseFloat(celoVaults.usdc).toFixed(4))}</h2>
                        <span className="text-xs text-blue-400 font-bold uppercase tracking-widest bg-blue-500/10 px-3 py-1 rounded-full">USDC Vault</span>
                        <WithdrawControl tokenSymbol="USDC" network="CELO" hoverClass="hover:bg-blue-500" queued={queuedWithdrawals['CELO-USDC']} busy={withdrawalBusyKey === 'CELO-USDC'} onWithdraw={handleWithdrawal} onCancel={handleCancelWithdrawal} />
                    </div>
                    <div className="bg-slate-900 border border-slate-800 p-6 rounded-3xl text-center">
                        <h2 className="text-4xl font-black mb-1">${Number(parseFloat(celoVaults.usdm).toFixed(4))}</h2>
                        <span className="text-xs text-yellow-500 font-bold uppercase tracking-widest bg-yellow-500/10 px-3 py-1 rounded-full">USDm Vault</span>
                        <WithdrawControl tokenSymbol="USDm" network="CELO" hoverClass="hover:bg-yellow-500" queued={queuedWithdrawals['CELO-USDm']} busy={withdrawalBusyKey === 'CELO-USDm'} onWithdraw={handleWithdrawal} onCancel={handleCancelWithdrawal} />
                    </div>
                </div>

                {/* BASE VAULTS */}
                <h3 className="text-sm font-black text-blue-500 uppercase tracking-widest mb-4 border-b border-slate-800 pb-2 flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-blue-500"></span> Base Network Reserves</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="bg-slate-900 border border-slate-800 p-6 rounded-3xl text-center">
                        <h2 className="text-4xl font-black mb-1">${Number(parseFloat(baseVaults.usdt).toFixed(4))}</h2>
                        <span className="text-xs text-emerald-500 font-bold uppercase tracking-widest bg-emerald-500/10 px-3 py-1 rounded-full">USD₮ Vault</span>
                        <WithdrawControl tokenSymbol="USD₮" network="BASE" hoverClass="hover:bg-emerald-500" queued={queuedWithdrawals['BASE-USD₮']} busy={withdrawalBusyKey === 'BASE-USD₮'} onWithdraw={handleWithdrawal} onCancel={handleCancelWithdrawal} />
                    </div>
                    <div className="bg-slate-900 border border-slate-800 p-6 rounded-3xl text-center">
                        <h2 className="text-4xl font-black mb-1">${Number(parseFloat(baseVaults.usdc).toFixed(4))}</h2>
                        <span className="text-xs text-blue-400 font-bold uppercase tracking-widest bg-blue-500/10 px-3 py-1 rounded-full">USDC Vault</span>
                        <WithdrawControl tokenSymbol="USDC" network="BASE" hoverClass="hover:bg-blue-500" queued={queuedWithdrawals['BASE-USDC']} busy={withdrawalBusyKey === 'BASE-USDC'} onWithdraw={handleWithdrawal} onCancel={handleCancelWithdrawal} />
                    </div>
                </div>
              </div>
            )}

            {/* CONTRACT CONTROLS TAB — direct owner-function calls on AbaPayV3, per chain.
                 Only shows for chains where the deployed contract actually exposes these
                 functions (V2/V3) — a V1 contract shows a "not available" notice instead,
                 same detection pattern as the vault tab's withdrawal flow. */}
            {activeTab === 'contract' && (
              <div className="space-y-6 animate-in fade-in">
                {(['CELO', 'BASE'] as const).map((network) => {
                  const cc = contractControls[network];
                  const accentColor = network === 'CELO' ? 'emerald' : 'blue';
                  const tokenSymbols = network === 'CELO' ? ['USD₮', 'USDC', 'USDm'] as const : ['USD₮', 'USDC'] as const;

                  return (
                    <div key={network} className="bg-[#111114] border border-slate-800 rounded-3xl p-8">
                      <h3 className={`text-sm font-black text-${accentColor}-500 uppercase tracking-widest mb-6 border-b border-slate-800 pb-3 flex items-center gap-2`}>
                        <span className={`w-2 h-2 rounded-full bg-${accentColor}-500`}></span> {network} — AbaPayV3 Contract Controls
                      </h3>

                      {!cc?.supported ? (
                        <p className="text-xs text-slate-500 italic">
                          {network} contract isn&apos;t configured, or doesn&apos;t expose these functions (V1 contracts predate them).
                        </p>
                      ) : (
                        <div className="space-y-8">
                          {/* RELAYER */}
                          <div>
                            <div className="flex items-center justify-between mb-2">
                              <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Agent Relayer</label>
                              <span className="text-[10px] font-mono text-slate-500">{cc.relayer}</span>
                            </div>
                            <div className="flex gap-2">
                              <input
                                type="text"
                                placeholder="0x... new relayer address (0x0 to disable the agent)"
                                value={ccInputs[`${network}-relayer`] || ''}
                                onChange={(e) => setCcInputs(p => ({ ...p, [`${network}-relayer`]: e.target.value }))}
                                className="flex-1 bg-slate-950 border border-slate-800 text-white text-xs font-mono py-3 px-4 rounded-xl outline-none focus:border-emerald-600"
                              />
                              <button
                                onClick={() => handleSetRelayer(network)}
                                disabled={ccBusyKey === `${network}-relayer`}
                                className="bg-slate-800 hover:bg-slate-700 text-white text-[10px] font-black uppercase tracking-widest px-5 rounded-xl disabled:opacity-50 flex items-center gap-2"
                              >
                                {ccBusyKey === `${network}-relayer` ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Update
                              </button>
                            </div>
                          </div>

                          {/* PAUSE / KILL SWITCH */}
                          <div className="flex items-center justify-between bg-slate-900 border border-slate-800 rounded-2xl p-5">
                            <div>
                              <p className="font-black text-white text-sm flex items-center gap-2">
                                <Power size={16} className={cc.paused ? 'text-red-400' : 'text-emerald-400'} />
                                {cc.paused ? 'Contract Paused' : 'Contract Active'}
                              </p>
                              <p className="text-[10px] text-slate-500 mt-1">Emergency stop — halts payBill/payBillFor immediately. Refunds/withdrawals stay available.</p>
                            </div>
                            <button
                              onClick={() => handleTogglePause(network, !!cc.paused)}
                              disabled={ccBusyKey === `${network}-pause`}
                              className={`text-[10px] font-black uppercase tracking-widest px-5 py-3 rounded-xl disabled:opacity-50 ${cc.paused ? 'bg-emerald-600 hover:bg-emerald-500 text-white' : 'bg-red-600 hover:bg-red-500 text-white'}`}
                            >
                              {ccBusyKey === `${network}-pause` ? <Loader2 size={12} className="animate-spin inline" /> : (cc.paused ? 'Unpause' : 'Pause')}
                            </button>
                          </div>

                          {/* PER-TOKEN CONTROLS */}
                          <div>
                            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3 block">Token Support & Caps</label>
                            <div className="space-y-4">
                              {tokenSymbols.map((symbol) => {
                                const t = cc.tokens?.[symbol];
                                return (
                                  <div key={symbol} className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
                                    <div className="flex items-center justify-between mb-4">
                                      <span className="font-black text-white">{symbol}</span>
                                      <button
                                        onClick={() => handleToggleTokenSupport(network, symbol, !!t?.supported)}
                                        disabled={ccBusyKey === `${network}-${symbol}-support`}
                                        className={`text-[9px] font-black uppercase tracking-widest px-3 py-1.5 rounded-lg disabled:opacity-50 ${t?.supported ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}
                                      >
                                        {ccBusyKey === `${network}-${symbol}-support` ? <Loader2 size={10} className="animate-spin inline" /> : (t?.supported ? 'Supported — tap to disable' : 'Not supported — tap to enable')}
                                      </button>
                                    </div>
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                      <div>
                                        <label className="text-[9px] font-bold text-slate-500 uppercase tracking-widest mb-1 block">Max agent payment / tx (current: {t?.agentCap ?? '...'})</label>
                                        <div className="flex gap-2">
                                          <input
                                            type="number" placeholder="e.g. 10"
                                            value={ccInputs[`${network}-${symbol}-agent`] || ''}
                                            onChange={(e) => setCcInputs(p => ({ ...p, [`${network}-${symbol}-agent`]: e.target.value }))}
                                            className="flex-1 bg-slate-950 border border-slate-800 text-white text-xs py-2.5 px-3 rounded-xl outline-none focus:border-emerald-600"
                                          />
                                          <button
                                            onClick={() => handleSetCap(network, symbol, 'agent')}
                                            disabled={ccBusyKey === `${network}-${symbol}-agent`}
                                            className="bg-slate-800 hover:bg-slate-700 text-white text-[9px] font-black uppercase px-3 rounded-xl disabled:opacity-50"
                                          >
                                            {ccBusyKey === `${network}-${symbol}-agent` ? <Loader2 size={10} className="animate-spin" /> : 'Set'}
                                          </button>
                                        </div>
                                      </div>
                                      <div>
                                        <label className="text-[9px] font-bold text-slate-500 uppercase tracking-widest mb-1 block">Max refund / tx (current: {t?.refundCap ?? '...'})</label>
                                        <div className="flex gap-2">
                                          <input
                                            type="number" placeholder="e.g. 10"
                                            value={ccInputs[`${network}-${symbol}-refund`] || ''}
                                            onChange={(e) => setCcInputs(p => ({ ...p, [`${network}-${symbol}-refund`]: e.target.value }))}
                                            className="flex-1 bg-slate-950 border border-slate-800 text-white text-xs py-2.5 px-3 rounded-xl outline-none focus:border-emerald-600"
                                          />
                                          <button
                                            onClick={() => handleSetCap(network, symbol, 'refund')}
                                            disabled={ccBusyKey === `${network}-${symbol}-refund`}
                                            className="bg-slate-800 hover:bg-slate-700 text-white text-[9px] font-black uppercase px-3 rounded-xl disabled:opacity-50"
                                          >
                                            {ccBusyKey === `${network}-${symbol}-refund` ? <Loader2 size={10} className="animate-spin" /> : 'Set'}
                                          </button>
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}

                <p className="text-[10px] text-slate-600 leading-relaxed px-2">
                  These call AbaPayV3&apos;s owner-only functions directly (setRelayer, setTokenSupport, setMaxAgentPayment,
                  setMaxRefund, pause/unpause) — every action here is a real, immediate on-chain transaction signed by
                  your connected admin wallet. There is no undo; double-check values before confirming.
                </p>
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

function WithdrawControl({ tokenSymbol, network, hoverClass, queued, busy, onWithdraw, onCancel }: {
  tokenSymbol: 'USD₮' | 'USDC' | 'USDm';
  network: 'CELO' | 'BASE';
  hoverClass: string;
  queued?: QueuedWithdrawal;
  busy: boolean;
  onWithdraw: (t: 'USD₮' | 'USDC' | 'USDm', n: 'CELO' | 'BASE') => void;
  onCancel: (t: 'USD₮' | 'USDC' | 'USDm', n: 'CELO' | 'BASE') => void;
}) {
  const baseBtn = `mt-8 w-full font-black py-3 rounded-xl flex items-center justify-center gap-2 transition-all disabled:opacity-50`;

  if (queued?.supported && queued.executableAt > 0) {
    const isReady = Date.now() >= queued.executableAt * 1000;
    if (!isReady) {
      const mins = Math.ceil((queued.executableAt * 1000 - Date.now()) / 60000);
      return (
        <div className="mt-8 space-y-2">
          <button disabled className={`${baseBtn} bg-slate-800 text-slate-500`}>
            <Loader2 size={16} /> Executable in ~{mins} min
          </button>
          <button onClick={() => onCancel(tokenSymbol, network)} disabled={busy} className="w-full text-[10px] font-bold uppercase tracking-widest text-red-400 hover:text-red-300 disabled:opacity-50">
            Cancel Queued Withdrawal
          </button>
        </div>
      );
    }
    return (
      <button onClick={() => onWithdraw(tokenSymbol, network)} disabled={busy} className={`${baseBtn} bg-emerald-600 hover:bg-emerald-500 text-white`}>
        {busy ? <Loader2 size={16} className="animate-spin" /> : <ArrowDownToLine size={16} />} Execute Withdrawal
      </button>
    );
  }

  return (
    <button onClick={() => onWithdraw(tokenSymbol, network)} disabled={busy} className={`${baseBtn} bg-slate-800 ${hoverClass} hover:text-slate-950 text-slate-300`}>
      {busy ? <Loader2 size={16} className="animate-spin" /> : <ArrowDownToLine size={16} />} Withdraw {tokenSymbol}
    </button>
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
