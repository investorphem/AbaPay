import 'server-only';
import { createWalletClient, http, publicActions, parseUnits, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { resolveChain, getPublicClient, isMainnetEnv } from '@/lib/chain';
import { resolveTokenOnChain } from '@/constants';
import { sendTelegramAlert } from '@/lib/telegram';
import { celoAttributionSuffix } from '@/lib/attribution';

// ⚡ AGENT RELAYER
//
// Executes payBillFor() on AbaPayV3 so the DeAI agent can pay a user's bill from their
// pre-authorised on-chain allowance — without AbaPay ever holding the user's keys.
//
// ⚠️ THIS MODULE HOLDS A HOT KEY (RELAYER_PRIVATE_KEY). Understand the blast radius:
//   • It can spend AT MOST each user's remaining on-chain allowance, and ONLY via payBillFor.
//   • It CANNOT drain a user's wallet, raise anyone's allowance, or withdraw the vault.
//     Those bounds are enforced by the CONTRACT, not by this code.
//   • If it leaks: the owner calls setRelayer(address(0)) and it is instantly dead.
//
// Keep RELAYER_PRIVATE_KEY funded with only enough gas to operate. It should never hold
// meaningful token balances.

const ABAPAY_V3_ABI = [
  {
    inputs: [
      { internalType: 'address', name: 'user', type: 'address' },
      { internalType: 'address', name: 'tokenAddress', type: 'address' },
      { internalType: 'string', name: 'serviceType', type: 'string' },
      { internalType: 'string', name: 'accountNumber', type: 'string' },
      { internalType: 'uint256', name: 'amount', type: 'uint256' },
    ],
    name: 'payBillFor',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'user', type: 'address' },
      { internalType: 'address', name: 'tokenAddress', type: 'address' },
    ],
    name: 'remainingAllowance',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

function contractAddressFor(blockchain: string): `0x${string}` | null {
  const addr =
    blockchain.toUpperCase() === 'BASE'
      ? process.env.NEXT_PUBLIC_ABAPAY_BASE_ADDRESS
      : process.env.NEXT_PUBLIC_ABAPAY_CELO_ADDRESS;
  return (addr as `0x${string}`) || null;
}

export interface AllowanceInfo {
  ok: boolean;
  remaining: number;       // human units
  remainingRaw: bigint;
  message?: string;
}

/**
 * Read a user's remaining on-chain allowance. The agent checks this BEFORE promising a
 * payment, so we fail conversationally rather than with an on-chain revert.
 */
export async function getRemainingAllowance(
  userWallet: string,
  tokenSymbol: string,
  blockchain = 'CELO'
): Promise<AllowanceInfo> {
  try {
    const contract = contractAddressFor(blockchain);
    const token = resolveTokenOnChain(tokenSymbol, blockchain, isMainnetEnv());
    if (!contract || !token) {
      return { ok: false, remaining: 0, remainingRaw: BigInt(0), message: 'Unsupported token or chain.' };
    }

    const client = getPublicClient(blockchain);
    const raw = (await client.readContract({
      address: contract,
      abi: ABAPAY_V3_ABI,
      functionName: 'remainingAllowance',
      args: [userWallet as `0x${string}`, token.address as `0x${string}`],
    })) as bigint;

    return {
      ok: true,
      remaining: Number(formatUnits(raw, token.decimals)),
      remainingRaw: raw,
    };
  } catch (err) {
    console.error('[Relayer] allowance read failed:', err);
    return { ok: false, remaining: 0, remainingRaw: BigInt(0), message: 'Could not read your allowance on-chain.' };
  }
}

export interface RelayResult {
  success: boolean;
  txHash?: string;
  message?: string;
  // Set when the transaction was BROADCAST but we couldn't confirm the outcome (RPC hiccup,
  // timeout) — as opposed to a definite revert. The caller must treat this as "still in
  // flight," never as "safe to retry" — the transaction may yet succeed, and retrying
  // (e.g. handing the user a payment link) risks a double payment if it does.
  pending?: boolean;
}

/**
 * Execute an agent-initiated bill payment from the user's on-chain allowance.
 */
export async function relayPayBillFor(params: {
  userWallet: string;
  tokenSymbol: string;
  serviceType: string;   // vtpass serviceID
  accountNumber: string;
  amountCrypto: string;  // human units, e.g. "1.2903"
  blockchain?: string;
  /** WHERE this came from — surfaced in operator alerts. */
  sourceChannel?: string; // TELEGRAM | WHATSAPP | X | SCHEDULE
  amountNgn?: number;
}): Promise<RelayResult> {
  const { userWallet, tokenSymbol, serviceType, accountNumber, amountCrypto } = params;
  const blockchain = params.blockchain || 'CELO';
  const sourceChannel = params.sourceChannel || 'AGENT';

  const pk = process.env.RELAYER_PRIVATE_KEY;
  if (!pk) {
    console.error('[Relayer] RELAYER_PRIVATE_KEY not configured.');
    return { success: false, message: 'Agent payments are not enabled on this deployment.' };
  }

  try {
    const contract = contractAddressFor(blockchain);
    const token = resolveTokenOnChain(tokenSymbol, blockchain, isMainnetEnv());
    if (!contract || !token) {
      return { success: false, message: 'Unsupported token or chain.' };
    }

    const amountWei = parseUnits(Number(amountCrypto).toFixed(token.decimals), token.decimals);

    // Pre-flight the allowance so we can fail with a helpful message rather than a revert.
    const allowance = await getRemainingAllowance(userWallet, tokenSymbol, blockchain);
    if (!allowance.ok) return { success: false, message: allowance.message };
    if (allowance.remainingRaw < amountWei) {
      return {
        success: false,
        message: `Your approved agent spend limit is too low. Remaining: ${allowance.remaining.toFixed(2)} ${tokenSymbol}. Raise it in the app to continue.`,
      };
    }

    const { chain } = resolveChain(blockchain);
    const account = privateKeyToAccount(pk as `0x${string}`);

    const wallet = createWalletClient({
      account,
      chain,
      transport: http(),
    }).extend(publicActions);

    const hash = await wallet.writeContract({
      address: contract,
      abi: ABAPAY_V3_ABI,
      functionName: 'payBillFor',
      args: [
        userWallet as `0x${string}`,
        token.address as `0x${string}`,
        serviceType,
        accountNumber,
        amountWei,
      ],
      chain,
      account,
      // Celo Builders attribution — appended only on Celo, undefined (no-op) on Base.
      dataSuffix: celoAttributionSuffix(chain),
    });

    // ⚡ CONFIRM ON-CHAIN — writeContract only means the tx was SUBMITTED, not that it
    // succeeded. Without this wait, a revert (e.g. a race against another spend that just
    // exhausted the allowance) would still be reported back to the caller as success.
    //
    // If THIS specific call throws (RPC timeout, dropped connection, etc.), that is NOT the
    // same as a revert — the transaction was already broadcast and may still confirm. Report
    // it as `pending`, not `success: false`, so the caller never treats it as safe to retry
    // (e.g. by handing the user a fresh payment link) while it might still land for real.
    let receipt;
    try {
      receipt = await wallet.waitForTransactionReceipt({ hash, confirmations: 1 });
    } catch (waitErr: any) {
      console.error('[Relayer] Could not confirm payBillFor receipt (tx may still be in flight):', hash, waitErr?.message);
      return {
        success: false,
        pending: true,
        txHash: hash,
        message: 'Your payment is broadcasting — confirming now, this can take a minute.',
      };
    }

    if (receipt.status !== 'success') {
      console.error('[Relayer] payBillFor reverted on-chain:', hash);
      return { success: false, message: 'Payment reverted on-chain. Please try again or pay in the app.' };
    }

    // ⚡ OPERATOR ALERT — an agent just spent real user funds. The operator must be able
    // to see AT A GLANCE which channel it came from: a PIN in a Telegram chat and an
    // unattended scheduled execution have very different risk profiles.
    try {
      const icon = sourceChannel === 'SCHEDULE' ? '🤖' : '💬';
      const via = sourceChannel === 'SCHEDULE' ? 'AUTONOMOUS SCHEDULE' : `${sourceChannel} AGENT`;
      await sendTelegramAlert(
        `${icon} *AGENT PAYMENT — via ${via}*\n\n` +
        `Service: \`${serviceType}\`\n` +
        `Account: \`${accountNumber}\`\n` +
        `Amount: ${params.amountNgn ? `₦${params.amountNgn.toLocaleString()} · ` : ''}${amountCrypto} ${tokenSymbol}\n` +
        `Wallet: \`${userWallet.slice(0, 6)}...${userWallet.slice(-4)}\`\n` +
        `Chain: ${blockchain}\n` +
        `Hash: \`${hash}\``
      );
    } catch { /* alerting must never block a successful payment */ }

    return { success: true, txHash: hash };
  } catch (err: any) {
    const msg: string = err?.shortMessage || err?.message || 'Agent payment failed.';
    console.error('[Relayer] payBillFor failed:', msg);

    // Translate the contract's custom errors into something a user can act on.
    if (msg.includes('ExceedsSpendingAllowance')) {
      return { success: false, message: 'That exceeds the spend limit you approved for the agent. Raise it in the app.' };
    }
    if (msg.includes('ExceedsMaxAgentPayment')) {
      return { success: false, message: 'That amount is above the per-transaction limit for agent payments.' };
    }
    if (msg.includes('RelayerDisabled') || msg.includes('NotRelayer')) {
      return { success: false, message: 'Agent payments are currently disabled.' };
    }
    if (msg.includes('EnforcedPause')) {
      return { success: false, message: 'Payments are temporarily paused. Please try again shortly.' };
    }
    if (msg.toLowerCase().includes('transfer') || msg.includes('allowance')) {
      return { success: false, message: 'Payment failed — check that you still hold enough tokens and that your token approval is active.' };
    }

    return { success: false, message: 'Agent payment failed. Please try again or pay in the app.' };
  }
}
