import { Phone, Globe, Lightbulb, Tv } from "lucide-react";
import { ELECTRICITY_DISCOS } from "@/app/discos";

export const ABAPAY_ABI = [{"inputs":[{"internalType":"address","name":"tokenAddress","type":"address"},{"internalType":"string","name":"serviceType","type":"string"},{"internalType":"string","name":"accountNumber","type":"string"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"payBill","outputs":[],"stateMutability":"nonpayable","type":"function"}];
export const ERC20_ABI = [
  {"inputs":[{"internalType":"address","name":"spender","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"approve","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"address","name":"account","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"}
];

export const SERVICES = [
  { id: "AIRTIME", name: "Buy Airtime", icon: Phone, color: "text-[#34d399]", bg: "bg-emerald-500/10" },
  { id: "INTERNET", name: "Internet", icon: Globe, color: "text-[#0ea5e9]", bg: "bg-sky-500/10" },
  { id: "ELECTRICITY", name: "Electricity", icon: Lightbulb, color: "text-[#f97316]", bg: "bg-orange-500/10" },
  { id: "CABLE", name: "Cable TV", icon: Tv, color: "text-[#ec4899]", bg: "bg-pink-500/10" },
];

export const ELECTRICITY_PROVIDER_IDS = ELECTRICITY_DISCOS.map(d => d.serviceID); 

export const CABLE_PROVIDERS_LIST = [
  { serviceID: "dstv", displayName: "DSTV", logo: "/dstv.png" },
  { serviceID: "gotv", displayName: "GOTV", logo: "/gotv.png" },
  { serviceID: "startimes", displayName: "Startimes", logo: "/startimes.png" }, // ⚡ RESTORED STARTIMES
  { serviceID: "showmax", displayName: "Showmax", logo: "/showmax.png" },
];

export const TELECOM_PROVIDERS = ["mtn", "glo", "9mobile", "airtel"]; 

export const INTERNET_PROVIDERS = [
  { serviceID: "mtn-data", displayName: "MTN Data", logo: "/mtn.png" },
  { serviceID: "glo-data", displayName: "Glo Data", logo: "/glo.png" },
  { serviceID: "airtel-data", displayName: "Airtel Data", logo: "/airtel.png" },
  { serviceID: "9mobile-data", displayName: "9Mobile Data", logo: "/9mobile.png" },
  { serviceID: "smile-direct", displayName: "Smile Network", logo: "/smile.png" },
  { serviceID: "spectranet", displayName: "Spectranet", logo: "/spectranet.png" }
];

// ⚡ ADDED EDUCATION PROVIDERS ⚡
export const EDUCATION_PROVIDERS = [
  { serviceID: "waec", displayName: "WAEC Result Checker", logo: "/waec.png" },
  { serviceID: "waec-registration", displayName: "WAEC Registration", logo: "/waec.png" },
  { serviceID: "jamb", displayName: "JAMB PIN Vending", logo: "/jamb.png" }
];

export const SUPPORTED_TOKENS = [
  { symbol: "USD₮", decimals: 6, mainnet: "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e", sepolia: "0xd077A400968890Eacc75cdc901F0356c943e4fDb", logo: "/usdt.png" },
  { symbol: "USDC", decimals: 6, mainnet: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", sepolia: "0x01C5C0122039549AD1493B8220cABEdD739BC44E", logo: "/usdc.png" },
  { symbol: "cUSD", decimals: 18, mainnet: "0x765DE816845861e75A25fCA122bb6898B8B1282a", sepolia: "0xdE9e4C3ce781b4bA68120d6261cbad65ce0aB00b", logo: "/cusd.png" }, 
];

export const SUPPORTED_COUNTRIES = [
  { code: "NG", name: "Nigeria", flag: "🇳🇬", disabled: false },
  { code: "SOON", name: "Other countries coming soon", flag: "🌍", disabled: true }
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
