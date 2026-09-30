import { decodeFunctionData, parseAbi, toFunctionSelector } from 'viem';

// ⚡ PAYMASTER SPONSORSHIP POLICY — what /api/paymaster will ask CDP to pay gas for.
//
// 🔴 THE HOLE: /api/paymaster forwarded any ERC-7677 request to the CDP paymaster, so anyone
// could point their own smart wallet at it and have AbaPay's CDP account pay the gas for any
// transaction at all. The route can't require an AbaPay login — the WALLET calls this URL
// itself (EIP-5792 paymasterService), with no way to add our headers — so the check has to be
// on what the UserOperation does.
//
// A sponsored UserOperation must be a Coinbase Smart Wallet `execute` / `executeBatch` whose
// every call is one of exactly what the app sends (src/app/page.tsx, sponsored path):
//   • token.approve(vault, amount)   — a supported stablecoin on this chain, spender = the vault
//   • vault.payBill(...)             — the payment itself (calldata may carry a builder-code suffix)
//   • vault.setSpendingAllowance(...) — the agent limit, set or revoked from the Agent tab
// with no native value attached. Anything else is refused.
//
// Defence in depth: the CDP dashboard's own paymaster policy should allowlist the same
// contracts and functions.

const WALLET_ABI = parseAbi([
  'function execute(address target, uint256 value, bytes data)',
  'function executeBatch((address target, uint256 value, bytes data)[] calls)',
]);
const TOKEN_ABI = parseAbi(['function approve(address spender, uint256 amount)']);

const SEL = {
  payBill: toFunctionSelector('function payBill(address tokenAddress, string serviceType, string accountNumber, uint256 amount)'),
  setSpendingAllowance: toFunctionSelector('function setSpendingAllowance(address tokenAddress, uint256 amount)'),
};

export interface SponsorScope {
  vault: string;     // lowercase
  tokens: string[];  // lowercase supported token addresses on this chain
}

export type PolicyResult = { ok: true } | { ok: false; reason: string };

function checkCall(target: string, value: bigint, data: string, scope: SponsorScope): PolicyResult {
  const to = String(target).toLowerCase();
  if (value !== BigInt(0)) return { ok: false, reason: 'native value transfers are not sponsored' };
  const selector = String(data).slice(0, 10).toLowerCase();

  if (to === scope.vault) {
    if (selector === SEL.payBill || selector === SEL.setSpendingAllowance) return { ok: true };
    return { ok: false, reason: `vault function ${selector} is not sponsored` };
  }
  if (scope.tokens.includes(to)) {
    try {
      const { functionName, args } = decodeFunctionData({ abi: TOKEN_ABI, data: data as `0x${string}` });
      if (functionName === 'approve' && String(args[0]).toLowerCase() === scope.vault) return { ok: true };
    } catch { /* not an approve */ }
    return { ok: false, reason: 'only approve(vault, amount) is sponsored on a token' };
  }
  return { ok: false, reason: `target ${to} is not an AbaPay contract` };
}

/** Is this UserOperation's callData something AbaPay sponsors? */
export function checkUserOperation(userOp: any, scope: SponsorScope): PolicyResult {
  const callData = userOp?.callData;
  if (typeof callData !== 'string' || !/^0x[0-9a-fA-F]*$/.test(callData) || callData.length < 10) {
    return { ok: false, reason: 'missing or malformed callData' };
  }
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: WALLET_ABI, data: callData as `0x${string}` });
  } catch {
    return { ok: false, reason: 'callData is not a smart-wallet execute/executeBatch' };
  }
  const calls = decoded.functionName === 'execute'
    ? [{ target: decoded.args[0], value: decoded.args[1], data: decoded.args[2] }]
    : (decoded.args[0] as readonly { target: string; value: bigint; data: string }[]);
  if (calls.length === 0 || calls.length > 4) return { ok: false, reason: 'unexpected number of calls' };
  for (const c of calls) {
    const r = checkCall(c.target, c.value, c.data, scope);
    if (!r.ok) return r;
  }
  return { ok: true };
}
