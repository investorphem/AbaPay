# abapay-sdk (Python)

Pay real-world bills — airtime, mobile data, electricity, cable TV — from an agent's own Celo
wallet. Mirrors [abapay-sdk (npm)](https://www.npmjs.com/package/abapay-sdk) field-for-field.
Two ways in, matching [agents.abapays.com](https://agents.abapays.com):

- **`pay_bill_via_x402`** — zero setup. No account, no API key, no PIN, no visit to
  abapays.com. Your agent's wallet signs one EIP-3009 authorization and the bill is paid.
- **`AbaPayAgent`** — a linked-wallet client for the fuller MCP tool catalog (balances,
  history, schedules). One on-chain signature to link, then an API key + PIN per payment.

Full protocol details: [docs.abapays.com](https://docs.abapays.com). Celo mainnet only.

## Install

```bash
pip install abapay-sdk
```

`eth-account` is the only runtime dependency — used for EIP-712/personal_sign signing, the
Python-ecosystem equivalent of what viem does for the TypeScript SDK.

## Zero setup: pay a bill via x402

```python
from eth_account import Account
from abapay import pay_bill_via_x402, BillDetails

account = Account.from_key("0x...")  # PRIVATE_KEY env var, not committed

result = pay_bill_via_x402(
    account,
    BillDetails(
        serviceID="mtn", serviceCategory="AIRTIME", network="MTN",
        billersCode="08012345678", nairaAmount=1000, token="USDT",
    ),
)
print(result.status, result.tx_hash)
```

That's the whole integration. `account` never touches abapays.com beyond this one HTTP call —
no account creation, no API key, no PIN. Full wire format:
[agents.abapays.com/x402](https://agents.abapays.com/x402) — nothing here is hidden, read
`src/abapay/x402.py` to see or port it to another language yourself.

## Linked wallet: the fuller tool catalog

```python
from eth_account import Account
from abapay import AbaPayAgent, LinkParams

account = Account.from_key("0x...")

# One-time: prove wallet ownership, mint an Agent Hub api_key. Save agent.api_key somewhere —
# there is no recovery flow other than linking again.
agent = AbaPayAgent.link(LinkParams(signer=account, pin="1234"))

# Elsewhere, an on-chain approve() + setSpendingAllowance() grants AbaPay a bounded, revocable
# allowance — see examples/agent-quickstart.mjs in the main repo for the two calls. Nothing in
# this SDK can raise that allowance on your behalf; only your own wallet can.

print(agent.check_balance())

agent.pay_bill(pin="1234", service="AIRTIME", provider="mtn", account_number="08012345678", amount_ngn=1000)
```

Reattach to a previously-minted key without signing again:

```python
agent = AbaPayAgent.from_api_key(saved_api_key, wallet_address)
```

## CLI

```bash
pip install abapay-sdk

PRIVATE_KEY=0x... abapay pay --service AIRTIME --provider mtn --to 08012345678 --amount 1000
PRIVATE_KEY=0x... abapay link --pin 1234
abapay balance --api-key aba_mcp_xxxxx
abapay history --api-key aba_mcp_xxxxx --limit 5
```

## Errors

Every failure throws `AbaPayError` (`.message`, and `.response` carrying whatever AbaPay's API
returned, when there was one). Full error code reference:
[agents.abapays.com/errors](https://agents.abapays.com/errors).

## Development

```bash
pip install -e ".[dev]"
pytest
```

Tests run against a real local HTTP server (`pytest-httpserver`), not a patched `urlopen` —
`test_x402.py` specifically recovers the signer's address from the signed EIP-712 typed data
and asserts it matches, the same correctness guarantee the TypeScript SDK's own test suite
makes.

## License

MIT
