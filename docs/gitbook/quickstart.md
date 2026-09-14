# Quickstart

One runnable script that links a wallet, sets an on-chain allowance, and calls
`check_balance` against production. Verified live against mainnet with a throwaway wallet
before publication. Full script: [examples/agent-quickstart.mjs](https://github.com/investorphem/AbaPay/blob/main/examples/agent-quickstart.mjs).

## Run it

```bash
PRIVATE_KEY=0x... npm install viem
CHAIN=CELO TOKEN=USDT node agent-quickstart.mjs
```

Talks to production and real mainnet contracts — fund the wallet with a trivial amount
first. Full env var reference (`ALLOWANCE`, `PIN`, `PAY`, …) is in the script's own header
comment on GitHub.

## Real session output — verified live

```
AbaPay agent quickstart — 0xYourAgentWallet... on CELO, USDT

→ Step 1/3: POST /api/agent/link (wallet-signature auth)
  ✓ api_key minted: aba_mcp_...
  (shown once — save it. No recovery flow other than minting a new one)

→ Step 2/3: on-chain approve() + setSpendingAllowance() for 2 USDT
  ✓ approve() confirmed: 0x...
  ✓ setSpendingAllowance() confirmed: 0x...

→ Step 3/3: tools/call check_balance
  USDT 1.8807 — approved limit 9.9254
```

## Step 1 — link the wallet, mint an api_key

A plain `personal_sign`, verified server-side — no session, no cookie, no CAPTCHA.

```js
const timestamp = String(Date.now());
const message = `AbaPay Agent Action: POST:/api/agent/link: ${timestamp}`;
const signature = await walletClient.signMessage({ message });

const linkRes = await fetch(`${APP_URL}/api/agent/link`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-wallet-address': account.address,
    'x-wallet-signature': signature,
    'x-wallet-timestamp': timestamp,
  },
  body: JSON.stringify({
    wallet_address: account.address, channel: 'MCP', pin,
    approved_chain: 'CELO', approved_token: 'USDT',
  }),
});
const { api_key: apiKey } = await linkRes.json();
```

## Step 2 — on-chain: approve + setSpendingAllowance

Two ordinary contract calls, from the wallet itself — nothing here requires the AbaPay
frontend.

```js
const approveHash = await walletClient.writeContract({
  address: token.address,
  abi: [{ name: 'approve', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ type: 'bool' }] }],
  functionName: 'approve', args: [abapayContract, allowanceRaw],
});
await publicClient.waitForTransactionReceipt({ hash: approveHash });

const allowanceHash = await walletClient.writeContract({
  address: abapayContract,
  abi: [{ name: 'setSpendingAllowance', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'tokenAddress', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [] }],
  functionName: 'setSpendingAllowance', args: [token.address, allowanceRaw],
});
await publicClient.waitForTransactionReceipt({ hash: allowanceHash });
```

## Step 3 — call MCP tools with the api_key

No OAuth needed — the api_key from Step 1 stands alone. Same shape for `pay_bill`,
`schedule_bill`, any of the 10 tools.

```js
const balance = await fetch(`${APP_URL}/api/mcp`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'check_balance', arguments: { api_key: apiKey, chain: 'CELO' } },
  }),
}).then((r) => r.json());

console.log(balance.result?.content?.[0]?.text);
```
