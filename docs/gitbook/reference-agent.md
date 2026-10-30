# Reference agent

{% hint style="info" %}
**[abapay-reference-agent](https://github.com/investorphem/abapay-reference-agent)**, an
open-source (MIT) agent that pays real bills from its own Celo wallet through x402. Use it as is,
or copy it as the starting point for your own.
{% endhint %}

It quotes and pays airtime, data, electricity, cable TV and exam PINs in USDC, USD₮ or USA₮ on Celo (set `TOKEN=USAT` for USA₮).
It needs no account, no API key and no CELO for gas. It is built on the
[TypeScript SDK](sdk.md)'s `payBillViaX402`.

* **Spending cap.** `MAX_USD` ($1 by default). Nothing above it is ever signed: the SDK's
  `confirm` hook sees the exact price first.
* **Asks before paying.** Each payment shows its price and waits for a yes, unless `--yes` is
  given.
* **Plain English, optional.** With an `ANTHROPIC_API_KEY`, Claude looks up the wallet, plans
  and prices, and calls `pay_bill`. The cap and the prompt still apply, and the model never
  sees the key.
* **Self Agent ID, optional.** Set `SELF_AGENT_KEY` and every request is signed with it. See
  [Self Agent ID](self-agent-id.md).

## Quickstart

You need Node.js 20.6 or newer and about $1 of USDC, USD₮ or USA₮ on Celo.

{% code title="Terminal" %}
```bash
git clone https://github.com/investorphem/abapay-reference-agent
cd abapay-reference-agent
npm install
cp .env.example .env
npm run agent -- new-wallet        # put the PRIVATE_KEY line in .env, fund the address on Celo

npm run agent -- wallet
npm run agent -- quote airtime mtn 08031234567 100   # price only
npm run agent -- pay   airtime mtn 08031234567 100   # shows the price, asks, pays
```
{% endcode %}

The result carries the Celo transaction link and AbaPay's status. More commands (plans, data,
electricity, cable) are in the
[repo's README](https://github.com/investorphem/abapay-reference-agent#commands).
