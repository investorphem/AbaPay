import { Phone, Globe, Lightbulb, Tv } from "lucide-react";

export const ABAPAY_ABI = [{"inputs":[{"internalType":"address","name":"tokenAddress","type":"address"},{"internalType":"string","name":"serviceType","type":"string"},{"internalType":"string","name":"accountNumber","type":"string"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"payBill","outputs":[],"stateMutability":"nonpayable","type":"function"}];

// ⚡ Event-only ABI fragment used server-side (webhook) to verify the AbaPay contract
// genuinely emitted PaymentReceived inside a transaction's logs — this works whether the
// transaction was submitted directly by the user's EOA, OR wrapped inside an ERC-4337
// UserOperation routed through a bundler/paymaster (Base gas sponsorship), since the log
// is emitted by our contract regardless of how deeply nested the call was.
export const ABAPAY_CONTRACT_ABI_EVENTS = [
  {"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"user","type":"address"},{"indexed":true,"internalType":"address","name":"token","type":"address"},{"indexed":false,"internalType":"string","name":"serviceType","type":"string"},{"indexed":false,"internalType":"string","name":"accountNumber","type":"string"},{"indexed":false,"internalType":"uint256","name":"amount","type":"uint256"}],"name":"PaymentReceived","type":"event"}
];

// ⚡ UPDATED: Added the 'allowance' function so Viem can check permissions
export const ERC20_ABI = [
  {"inputs":[{"internalType":"address","name":"spender","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"approve","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"address","name":"account","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"owner","type":"address"},{"internalType":"address","name":"spender","type":"address"}],"name":"allowance","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"}
];

export const SERVICES = [
  { id: "AIRTIME", name: "Buy Airtime", icon: Phone, color: "text-[#34d399]", bg: "bg-emerald-500/10" },
  { id: "INTERNET", name: "Internet", icon: Globe, color: "text-[#0ea5e9]", bg: "bg-sky-500/10" },
  { id: "ELECTRICITY", name: "Electricity", icon: Lightbulb, color: "text-[#f97316]", bg: "bg-orange-500/10" },
  { id: "CABLE", name: "Cable TV", icon: Tv, color: "text-[#ec4899]", bg: "bg-pink-500/10" },
];

// ⚡ ELECTRICITY_PROVIDER_IDS / CABLE_PROVIDERS_LIST / TELECOM_PROVIDERS / INTERNET_PROVIDERS /
// EDUCATION_PROVIDERS USED TO LIVE HERE. Every one of them is now sourced LIVE from VTpass's
// /services?identifier=… catalogue:
//
//   • web app  -> src/lib/useProviders.ts  -> GET /api/providers?category=…
//   • chat/MCP -> src/lib/deai/selection.ts -> getCatalog() in-process
//   • both land on the same 1h TTL cache in src/lib/vtpassCatalog.ts
//
// The only remaining hardcoded copy is src/lib/providerFallback.ts, which exists purely so a
// cold start during a VTpass outage degrades to a usable picker instead of an empty one.
//
// 🔴 These lists were not merely stale, they were WRONG in both directions: they advertised
// `showmax`, `spectranet` and `jamb` (VTpass: "Service is Not Valid" on this merchant account —
// a user could pick one, pay on-chain, and only then have the vend fail) while omitting
// `glo-sme-data` and `9mobile-sme-data`, which are live and were unreachable from the app.

export const SUPPORTED_TOKENS = [
  {
    symbol: "USDm", 
    logo: "/cusd.png",
    decimals: 18,
    mainnet: "0x765DE816845861e75A25fCA122bb6898B8B1282a", // Celo Mainnet
    sepolia: "0x874069Fa1Eb16D44d622F2e0Ca25eeA172369bC1", // Celo Alfajores
    supportedNetworks: ["celo"] 
  },
  {
    symbol: "USDC",
    logo: "/usdc.png", 
    decimals: 6,
    mainnet: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base Mainnet 
    sepolia: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia
    celoMainnet: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", // Celo Mainnet USDC
    celoSepolia: "0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B", // Celo Alfajores USDC
    supportedNetworks: ["base", "celo"] 
  },
  {
    symbol: "USD₮",
    logo: "/usdt.png",
    decimals: 6,
    mainnet: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", // ⚡ Base Mainnet 
    sepolia: "0x1d5728a887e1fa1a191467094ac7761d019b4c2c", // ⚡ Base Sepolia
    celoMainnet: "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e", // ⚡ Celo Mainnet
    celoSepolia: "0x1E05bc8B6DEE14B44B3654fD4eb59fF0E9a6D2c7", // ⚡ Celo Sepolia
    supportedNetworks: ["celo", "base"] 
  }
];

// ⚡ Server-side helper: resolve a stored token symbol to its on-chain address + decimals
// for a given blockchain ('CELO' | 'BASE') and network mode (mainnet vs testnet).
// Used by the webhook to cross-check the PaymentReceived event's token & amount against
// the pending record, so a manually-sent transfer of a DIFFERENT token/amount can't be
// matched to an unrelated pending intent.
export function resolveTokenOnChain(symbol: string, blockchain: string, isMainnet: boolean): { address: string; decimals: number } | null {
  const token = SUPPORTED_TOKENS.find(t => t.symbol === symbol) as any;
  if (!token) return null;
  const isBase = (blockchain || '').toUpperCase() === 'BASE';
  let address: string | undefined;
  if (isBase) {
    address = isMainnet ? token.mainnet : token.sepolia;
  } else {
    // Celo: prefer explicit celo-keyed addresses, fall back to mainnet/sepolia for cUSD/USDm
    address = isMainnet ? (token.celoMainnet || token.mainnet) : (token.celoSepolia || token.sepolia);
  }
  if (!address) return null;
  return { address: address.toLowerCase(), decimals: token.decimals };
}

// ⚡ THE HOME COUNTRY ONLY — not the supported-country list.
//
// The real list is fetched live from VTpass (/api/intl?action=countries -> 100+ countries with
// their own flag URLs and currencies) and merged in front of this entry; see page.tsx's
// intlCountries effect. Nigeria stays hardcoded because it is the DOMESTIC side of the app, not
// an entry in VTpass's international-airtime catalogue — it has no VTpass country record to
// source from, and `activeCountry.code !== "NG"` is what switches the whole form into
// international mode.
//
// 🔴 REMOVED: a second entry, `{ code: "SOON", name: "Other countries coming soon",
// disabled: true }`. It was dead weight that actively misled anyone reading this file into
// thinking international was unbuilt — every consumer already filtered it out
// (`SUPPORTED_COUNTRIES.filter(c => !c.disabled)`), so it was unreachable in the running app
// while the live list it claimed was "coming soon" had been shipping the whole time.
export const SUPPORTED_COUNTRIES = [
  { code: "NG", name: "Nigeria", flag: "🇳🇬", disabled: false }
];

export const PRE_SELECT_AMOUNTS = ["100", "200", "500", "1000", "2000"];
export const ELEC_PRE_SELECT_AMOUNTS = ["1000", "2000", "5000", "10000", "20000"];
export const DATA_CATEGORIES = ["Daily", "Weekly", "Monthly", "Social", "Mega", "Broadband"];
export const ITEMS_PER_PAGE = 5;

export const extractVtpassArray = (data: any): any[] => {
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