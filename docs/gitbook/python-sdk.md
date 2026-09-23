# Python SDK

{% hint style="info" %}
**`abapay-sdk`** on PyPI — mirrors the [TypeScript SDK](sdk.md) field-for-field, same two
functions, same two protocol-driven paths in this handbook.
{% endhint %}

Signs with `eth-account` — the Python-ecosystem equivalent of what viem does for the TypeScript
SDK. Nothing hidden: the wire format is the same one documented in [x402](x402.md) and
[MCP](mcp.md).

{% hint style="success" %}
**Live on PyPI** — `pip install abapay-sdk`
{% endhint %}

## Zero setup: pay_bill_via_x402

Fetches the 402 challenge, signs it, retries, returns the settlement.

{% code title="pay_via_x402.py" %}
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
{% endcode %}

## Linked wallet: AbaPayAgent

Links once, sets the PIN in that same call, then reuses the `api_key` for the full tool
catalog.

{% code title="linked_agent.py" %}
```python
from eth_account import Account
from abapay import AbaPayAgent, LinkParams

account = Account.from_key("0x...")

# One-time -- no browser, PIN chosen right here.
agent = AbaPayAgent.link(LinkParams(signer=account, pin="1234"))

print(agent.check_balance())
agent.pay_bill(pin="1234", service="AIRTIME", provider="mtn", account_number="08012345678", amount_ngn=1000)
```
{% endcode %}

Reattach to a previously-minted key without signing again:

```python
agent = AbaPayAgent.from_api_key(saved_api_key, wallet_address)
```

## CLI

{% code title="Installed alongside the package" %}
```bash
PRIVATE_KEY=0x... abapay pay --service AIRTIME --provider mtn --to 08012345678 --amount 1000
PRIVATE_KEY=0x... abapay link --pin 1234
abapay balance --api-key aba_mcp_xxxxx
abapay history --api-key aba_mcp_xxxxx --limit 5
```
{% endcode %}

## Correctness, not just types

`test_x402.py` recovers the signer's address from the signed EIP-712 typed data and asserts it
matches a real 402 challenge byte-for-byte — the same correctness guarantee the TypeScript
SDK's test suite makes, run against a real local HTTP server (`pytest-httpserver`), not a
patched `urlopen`.

[Source, tests, and the full README →](https://github.com/investorphem/AbaPay/tree/main/python-sdk)
