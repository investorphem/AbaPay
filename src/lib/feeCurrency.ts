// ⛽ CELO FEE ABSTRACTION — the network fee is paid in the stablecoin the customer is paying with.
//
// Celo lets a transaction name a `feeCurrency` from the FeeCurrencyDirectory
// (0x15F344b9E6c3Cb6F0376A36A64928b13F62C6276 on mainnet) and pay gas in it instead of CELO.
// Mento stablecoins (USDm) are listed as themselves. 6-decimal tokens are listed through an
// 18-decimal ADAPTER, and the transaction must name the adapter, not the token: naming the
// token's own address is refused. Read from the directory on 2026-11-20:
//
//   USDC  0xcebA9300…118C → adapter 0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B
//   USD₮  0x48065fbB…3D5e → adapter 0x0E2A3e05bc9A16F5292A6170456A710cb89C6f72
//   USA₮  0xD2ab3C9A…F771 → adapter 0x0357EE22278c922e1D36cFe6b899269b161880C4
//   USDm  0x765DE816…282a → itself
//
// Before this, every MiniPay payment named USDm as the fee currency whatever the customer paid
// with, so a customer holding only USDC or USD₮ was asked for gas in a token they didn't have.

const MAINNET: Record<string, `0x${string}`> = {
  USDm: '0x765DE816845861e75A25fCA122bb6898B8B1282a',
  USDC: '0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B',
  'USD₮': '0x0E2A3e05bc9A16F5292A6170456A710cb89C6f72',
  'USA₮': '0x0357EE22278c922e1D36cFe6b899269b161880C4',
};

// Celo Sepolia: only the testnet USDm is used for gas; testnet adapters are not relied on.
const TESTNET_USDM = '0xdE9e4C3ce781b4bA68120d6261cbad65ce0aB00b' as const;

/** The fee currency to name for a Celo payment in `tokenSymbol`. Undefined: pay gas in CELO. */
export function feeCurrencyFor(tokenSymbol: string, mainnet: boolean): `0x${string}` | undefined {
  if (!mainnet) return TESTNET_USDM;
  return MAINNET[tokenSymbol];
}
