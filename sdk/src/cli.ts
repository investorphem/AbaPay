#!/usr/bin/env node
import { parseArgs } from "node:util";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { payBillViaX402 } from "./x402.js";
import { AbaPayAgent } from "./agent.js";
import { AbaPayError } from "./types.js";

// ⚡ A REAL CLI, NOT A DEMO SCRIPT — every command below calls the exact same SDK functions
// documented at agents.abapays.com/sdk; this file is a thin arg-parsing wrapper, not a second
// implementation. `node:util`'s built-in parseArgs (Node 18+, matches this package's engines
// field) is used deliberately instead of adding a CLI-argument dependency — this SDK has zero
// runtime dependencies of its own (viem is a peer), and a CLI is not a reason to change that.

function fail(message: string): never {
  process.stderr.write(`abapay: ${message}\n`);
  process.exit(1);
}

function requirePrivateKey(): Hex {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) fail("PRIVATE_KEY env var is required (a 0x-prefixed hex private key).");
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk!)) fail("PRIVATE_KEY must be a 0x-prefixed 32-byte hex string.");
  return pk as Hex;
}

const HELP = `abapay-cli — pay real-world bills from a Celo wallet, no browser required.

USAGE
  abapay pay --service <S> --provider <P> --to <account> --amount <ngn> [--token USDT|USDC]
  abapay link --pin <4-6 digits> [--chain CELO] [--token USDT|USDC] [--label <name>]
  abapay balance --api-key <aba_mcp_...> [--chain CELO]
  abapay history --api-key <aba_mcp_...> [--limit N] [--offset N]

ENV
  PRIVATE_KEY   0x-prefixed private key. Required for 'pay' (signs the x402 authorization)
                and 'link' (signs the linking message). Never sent anywhere — signing happens
                locally via viem.

EXAMPLES
  PRIVATE_KEY=0x... abapay pay --service AIRTIME --provider mtn --to 08012345678 --amount 1000
  PRIVATE_KEY=0x... abapay link --pin 1234
  abapay balance --api-key aba_mcp_xxxxx

Full reference: https://agents.abapays.com/sdk · https://agents.abapays.com/tools
`;

async function cmdPay(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      service: { type: "string" },
      provider: { type: "string" },
      to: { type: "string" },
      amount: { type: "string" },
      token: { type: "string", default: "USDT" },
      network: { type: "string" },
    },
  });
  if (!values.service || !values.to || !values.amount) {
    fail("pay requires --service, --to, and --amount (--provider recommended).");
  }
  const account = privateKeyToAccount(requirePrivateKey());
  console.log(`Paying as ${account.address} — ${values.service} ${values.amount} NGN to ${values.to}…`);
  try {
    const result = await payBillViaX402({
      signer: account,
      bill: {
        serviceID: (values.provider || values.service!).toLowerCase(),
        serviceCategory: values.service as any,
        network: values.network || values.provider?.toUpperCase() || String(values.service),
        billersCode: values.to!,
        nairaAmount: Number(values.amount),
        token: (values.token as "USDT" | "USDC") ?? "USDT",
      },
    });
    console.log(`✓ ${result.status} — tx: ${result.tx_hash ?? "(pending)"}`);
  } catch (e) {
    if (e instanceof AbaPayError) fail(`${e.message}${e.response ? `\n${JSON.stringify(e.response, null, 2)}` : ""}`);
    throw e;
  }
}

async function cmdLink(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      pin: { type: "string" },
      chain: { type: "string", default: "CELO" },
      token: { type: "string" },
      label: { type: "string" },
    },
  });
  if (!values.pin) fail("link requires --pin (4-6 digits).");
  const account = privateKeyToAccount(requirePrivateKey());
  console.log(`Linking ${account.address}…`);
  try {
    const agent = await AbaPayAgent.link({
      signer: account,
      pin: values.pin!,
      approvedChain: values.chain as "CELO" | "BASE",
      approvedToken: values.token,
      label: values.label || "abapay-cli",
    });
    console.log(`✓ Linked. api_key: ${agent.apiKey}`);
    console.log(`  This does NOT grant a spending allowance by itself — see agents.abapays.com/agents/developers/quickstart for the on-chain approve() + setSpendingAllowance() step.`);
  } catch (e) {
    if (e instanceof AbaPayError) fail(e.message);
    throw e;
  }
}

async function cmdBalance(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "api-key": { type: "string" },
      wallet: { type: "string" },
      chain: { type: "string", default: "CELO" },
    },
  });
  if (!values["api-key"]) fail("balance requires --api-key.");
  const agent = AbaPayAgent.fromApiKey(values["api-key"]!, values.wallet || "");
  try {
    console.log(await agent.checkBalance(values.chain as "CELO" | "BASE"));
  } catch (e) {
    if (e instanceof AbaPayError) fail(e.message);
    throw e;
  }
}

async function cmdHistory(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "api-key": { type: "string" },
      wallet: { type: "string" },
      limit: { type: "string" },
      offset: { type: "string" },
    },
  });
  if (!values["api-key"]) fail("history requires --api-key.");
  const agent = AbaPayAgent.fromApiKey(values["api-key"]!, values.wallet || "");
  try {
    console.log(await agent.transactionHistory({
      limit: values.limit ? Number(values.limit) : undefined,
      offset: values.offset ? Number(values.offset) : undefined,
    }));
  } catch (e) {
    if (e instanceof AbaPayError) fail(e.message);
    throw e;
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "pay": return cmdPay(rest);
    case "link": return cmdLink(rest);
    case "balance": return cmdBalance(rest);
    case "history": return cmdHistory(rest);
    case "help":
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(HELP);
      return;
    default:
      fail(`Unknown command "${cmd}". Run 'abapay help'.`);
  }
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
