# REST API

{% hint style="info" %}
**Plain HTTP** — Celo-only, machine-readable, no MCP or A2A client required.
{% endhint %}

The same settlement rail as x402, described as a plain OpenAPI 3.1 document for any HTTP
client that isn't speaking MCP or A2A. One endpoint, Celo-only, machine-readable.

## POST /api/pay/x402

Settles a real-world bill payment. The caller pays in a supported Celo stablecoin; on
confirmed settlement, AbaPay vends the underlying service and returns the result. Price is
dynamic — it equals the live value of the bill, so there is no fixed catalog price for this
resource.

### Request body

| Field | Type | Description |
|---|---|---|
| `serviceID` | string | VTpass service identifier, e.g. "mtn", "ikeja-electric" |
| `serviceCategory` | string | AIRTIME \| DATA \| ELECTRICITY \| CABLE \| BANK \| EDUCATION |
| `network` | string | Provider name, e.g. MTN, IKEJA-ELECTRIC, DSTV |
| `billersCode` | string | Phone number, meter number, or smartcard/IUC number |
| `nairaAmount` | number | Bill amount in NGN — the source of truth for pricing |
| `token` | string | "USDC", "USD₮", or "USA₮" — all three implement EIP-3009 on Celo; an unrecognized value falls back to USDC |
| `blockchain` | string | "CELO" — this rail is Celo-only |
| `wallet_address` | string | The paying wallet, cross-checked against the signed authorization |

### Responses

- **200 Settled** — bill vended, or queued for background processing.
- **402 Payment Required** — standard x402 challenge, see [x402](x402.md).

{% code title="200 response body" %}
```json
{
  "success": true,
  "status": "SUCCESS",
  "purchased_code": null,
  "units": null,
  "request_id": "req_...",
  "tx_hash": "0x91a3...4f2c"
}
```
{% endcode %}

### Try it

{% hint style="success" %}
A GET or probing POST with no payment attached returns a valid 402 challenge — the endpoint is always live for discovery, no credential required to see the price.
{% endhint %}

{% code title="Try it — curl" %}
```bash
curl -X POST https://agents.abapays.com/api/pay/x402 \
  -H "Content-Type: application/json" \
  -d '{"serviceID":"mtn","serviceCategory":"AIRTIME","network":"MTN","billersCode":"08012345678","nairaAmount":1000,"token":"USDC","blockchain":"CELO","wallet_address":"0xYourAgentWallet"}'
```
{% endcode %}

Full machine-readable spec: [openapi.json](https://abapays.com/openapi.json).
