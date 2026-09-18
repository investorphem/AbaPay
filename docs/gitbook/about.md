# About

Who operates AbaPay's Celo agent rails, what's actually missing in agent-payment
infrastructure today, and current status — not a wishlist.

## What's actually missing in agent payments

Agent-payment infrastructure has converged on three shapes, and each stops short of the same
thing: an agent that can settle a payment but can't **complete an outcome**.

- **Crypto-native rails that stop at settlement.** x402, A2A, and similar protocols move a
  stablecoin from one wallet to another correctly — and then the transaction is the whole
  story. Nothing on the other end turns that transfer into a phone with airtime on it, or a
  meter that isn't about to cut power.
- **Real-world commerce APIs built for a human in the loop.** Card-based checkout, KYC gates,
  session cookies, a card-entry form — every one of these assumes a person is present to
  click through it. An autonomous agent, running unattended at 3am, cannot.
- **Custody as the price of automation.** The systems that do let an agent transact
  repeatedly and unattended mostly do it by holding the user's funds or a stored payment
  credential on their behalf — trading away non-custodial guarantees for convenience, rather
  than keeping both.

AbaPay is built at the seam those three leave open: a real x402, MCP, or A2A payment that
actually completes — airtime credited, a bill paid, a real result — with the wallet still
governed by an on-chain allowance the owner set and can revoke themselves, never a deposit or
a stored card. The agent gets a finished outcome; the human never has to trade custody for it.

## Masonode Technologies Limited

The registered legal entity behind AbaPay — RC 9524980. Handles compliance, banking rails,
and legal terms.

## Where to reach us

- Support: [support@abapays.com](mailto:support@abapays.com)
- Legal: [Terms](https://abapays.com/terms) · [Privacy](https://abapays.com/privacy)
- Source: [github.com/investorphem/AbaPay](https://github.com/investorphem/AbaPay) (MIT)

## Status

{% hint style="success" %}
**Python SDK — shipped.** `python-sdk/` mirrors the TypeScript SDK field-for-field — same two functions, a real CLI, tests that recover the signer's address from the signed EIP-712 data and assert it matches. Live on PyPI: `pip install abapay-sdk`, published via a Trusted Publisher (no token secret) off a `py-sdk-v*` tag.
{% endhint %}

{% hint style="warning" %}
**Wider agent-registry discovery — in review.** Already listed on the official MCP Registry, on-chain via ERC-8004, approved on Glama's server and connector directories, and live on MCP Playground's server registry. A PR is still open against `awesome-mcp-servers` (95k+ stars), ready to merge and waiting on that repo's own maintainer.
{% endhint %}
