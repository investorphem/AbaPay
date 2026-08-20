# ⚡ AbaPay Protocol

AbaPay is a decentralized, Web3-native utility payment platform built on **Base** (the default chain) and **Celo**. It lets users pay for real-world bills — Airtime, Mobile Data, Electricity, Cable TV, Bank Transfers, Education PINs, and International Airtime/Data — using on-chain stablecoins (**USDT**, **USDC**, **cUSD/USDm**), with instant fiat settlement handled server-side via the VTpass API. Payments can be made directly in the web app, or hands-free through a conversational, autonomous AI agent ("DeAI") on Telegram, WhatsApp, and X — a real on-chain identity under [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004), discoverable on [8004scan.io](https://8004scan.io) — that can pay bills unattended, run recurring/scheduled autopay, and settle multi-recipient batch payments, all spending from a bounded, user-revocable on-chain allowance — no custody, no server-side keys.

Designed for low fees, cross-border utility vending (Nigeria + every country VTpass's live international catalogue returns), and mobile-first accessibility — MiniPay, Valora, Farcaster Mini Apps, Coinbase Smart Wallet / Base Account, MetaMask, and any other WalletConnect-compatible wallet (see [Supported Wallets & Environments](#-supported-wallets--environments)).

**Operator:** Masonode Technologies Limited (RC 9524980), Nigeria.

---

## 🌟 Key Features

* **Multi-Chain Payments:** Pay bills directly with USDT, USDC, or cUSD on Base (Mainnet/Sepolia) or Celo (Mainnet/Alfajores). **Base is the default chain**; Celo remains fully supported and switchable. The app auto-detects the connected chain and filters/reorders available stablecoins accordingly — **USDC leads on Base, USD₮ leads on Celo**, and cUSD/USDm is Celo-exclusive.
* **Live VTpass Catalogue — nothing about a provider is hardcoded any more:** every provider name, logo, and amount limit for airtime, data, electricity, cable and education is fetched live from VTpass (`src/lib/vtpassCatalog.ts`, served to the browser by `/api/providers`) rather than from four separate hardcoded lists. The app, chat, MCP and the admin dashboard all read the same in-process cache, so there is exactly one source of truth. See [Live provider catalogue](#live-provider-catalogue-vtpass-sourced) below.
* **Per-Provider Amount Limits, Enforced Live:** the ceiling is VTpass's real published `minimium_amount`/`maximum_amount` *per provider*, not one flat number per service — airtime alone ranges MTN ₦200,000 / Glo ₦100,000 / Airtel ₦50,000 / 9mobile ₦50,000, and electricity minimums range ₦100 (Ikeja, Aba) to ₦2,000 (Ibadan). A flat cap either wrongly refused a valid MTN top-up or wrongly accepted an Airtel one that VTpass rejects *after* the user has already paid on-chain.
* **International Bill Pay:** Users can select a country and pay for foreign airtime/data in that country's own currency and rate — transaction history and receipts reflect the *local* currency, not just Naira. The country list is fetched live from VTpass (`/get-international-airtime-countries`) on every channel, so the app, chat and MCP can never disagree about which countries are covered.
* **Instant Vending:** Automated API integration with VTpass for instant token generation, airtime top-ups, and data bundle delivery.
* **Education PINs in every channel:** WAEC result-checker and WAEC registration PINs are buyable from the app, from chat (Telegram/WhatsApp/X/in-app), and over MCP — not app-only. ⚠️ **JAMB is a deliberate honesty caveat:** the code path exists end-to-end (intent parsing, profile-ID verification, `variation_code` handling), but `jamb` is not enabled on the current VTpass merchant account — VTpass answers `{"code":"011","content":{"errors":"Service is Not Valid"}}` — so it does not appear in the live catalogue and cannot currently be sold. If the account is enabled for it, it appears automatically with no code change.
* **Smart Merchant Verification:** Validates electricity meters, smartcard/IUC numbers, and account details *before* accepting crypto payments, eliminating user errors and failed vends.
* **AbaPoints Loyalty System:** Users earn points pegged 1:1 to stablecoin value spent, trackable via the in-app points badge and a dedicated API endpoint.
* **Automatic Refund Safety Net:** Failed vends after confirmed on-chain payment are automatically flagged, verified, and refunded on-chain to the user's wallet.
* **DND-Fallback SMS:** Automated SMS delivery of electricity tokens/PINs, bypassing the Nigerian Do-Not-Disturb (DND) registry for critical transaction alerts.
* **Multi-Channel Support & Notifications:** Built-in support ticketing, plus webhook integrations for Telegram, WhatsApp, and X (Twitter) so users and admins can transact/get notified from their preferred channel.
* **Conversational AI Agent ("DeAI"):** A natural-language assistant (`/api/deai`) that lets users check balances and pay bills via chat-style commands, backed by Claude (Anthropic). Reachable via Telegram, WhatsApp, X, and an in-app chat widget (`src/components/AIChat.tsx`) on the storefront itself. Understands intent, not just menu numbers — replying "Celo" or "usdt" works exactly like replying "1" or "2" — and shows the live balance and approved agent limit for every token at the moment you're asked to pick one, so you're never choosing blind. If a session goes cold (network drop, abandoned mid-flow) it's recognised and cleaned up automatically rather than left dangling; and if a network hiccup happens right after you enter your PIN, the payment is never silently lost or double-spent — it's tracked through to a confirmed on-chain outcome before the agent reports back.
* **Agent-Initiated Payments (AbaPayV3):** Users can grant the DeAI agent a bounded, on-chain, revocable spending allowance (`setSpendingAllowance`) — chosen independently per chain and per stablecoin from the Agent Hub tab — so it can pay bills on their behalf from Telegram/WhatsApp/X with no wallet signature needed at payment time and no custody of user funds. If no allowance is approved for the chain/token a chat payment needs, the agent detects that up front and offers a straight choice: approve it now, or complete this one payment via a signed deep link instead. See [AbaPayV3 — agent allowances](#abapayv3sol--agent-initiated-payments-️-not-audited) below.
* **Autonomous Scheduling & Autopay Agent:** Beyond one-off chat payments, users can ask the DeAI agent to set up recurring bills (monthly/weekly/daily), a one-time future payment ("pay this in 10 minutes"), or a single request covering **multiple recipients/accounts at once** — the agent groups them by chain/token and settles each leg through the same allowance-bounded relayer, unattended, on schedule, with zero further interaction required from the user.
* **On-Chain Attribution:** Celo transactions carry an ERC-8021 attribution tag (`src/lib/attribution.ts`) crediting the Celo Builders program; a no-op on Base.
* **On-Chain Agent Identity (ERC-8004):** AbaPay's DeAI agent is registered as a real on-chain identity on **both Celo and Base** via the ERC-8004 "Trustless Agents" registry, so it's discoverable on 8004scan.io / AgentScan — independent of, and unrelated to, how it moves money. See [ERC-8004 agent identity](#erc-8004-agent-identity) below.
* **MCP Server (AI Agent Payments):** AbaPay is reachable by any MCP-speaking AI client (Claude, or any other agent that supports the Model Context Protocol) as a real tool server — `describe_capabilities`, `check_balance`, `list_plans`, and `pay_bill` — over Streamable HTTP JSON-RPC at `/api/mcp`. This is a fourth channel alongside Telegram/WhatsApp/X, not a new trust boundary: it runs through the exact same allowance-bounded, kill-switch-gated, discount-aware execution pipeline as the chat channels, on **either Celo or Base** depending on what the linking wallet approved. See [MCP Server](#mcp-server-ai-agent-payments) below.
* **MCP OAuth 2.1 (authorize once, not once per conversation):** the connector supports a full OAuth 2.1 authorization-code + PKCE (S256) flow with Dynamic Client Registration (`/api/oauth/register`, `/api/oauth/authorize`, `/api/oauth/token`, discovery under `/.well-known/`). A user authorizes once in a browser — proving their API key **and** PIN on AbaPay's own hand-rendered consent page — and every future conversation reconnects with a Bearer token instead of retyping an API key. **OAuth never authorizes a spend:** the PIN is still required on every single `pay_bill` call, and a Bearer token alone can only read a balance. The `api_key` tool argument remains the fallback for clients that can't do OAuth.
* **`list_plans` — real VTpass plan codes and prices, never guessed:** `variation_code` used to be something an agent had to invent for DATA/CABLE/EDUCATION. `list_plans` returns the currently purchasable plans with their exact codes and live VTpass prices, and both the tool description and the server instructions tell the client to call it before `pay_bill` rather than guessing.
* **x402 Settlement (main app, both chains):** Payments made directly in the web app settle via the [x402](https://x402.org) HTTP-payment protocol — Celo's own facilitator for **USDC/USD₮ on Celo**, the Coinbase CDP facilitator for **USDC on Base** — so they're genuinely indexed on x402scan, not relabeled contract calls. Everything else (cUSD/USDm) uses the on-chain `payBill` flow, including Base's sponsored-gas path. ⚠️ x402 needs an EIP-3009 `transferWithAuthorization` signature, which is structurally what a drainer asks for, so some wallet scanners flag it as risky — a known, deliberate trade for x402scan visibility; `NEXT_PUBLIC_X402_ENABLED=false` opts out. The signature-free agent-initiated flow is untouched either way. See [x402 settlement](#x402-settlement-main-app-only) below.
* **Dynamic Exchange Engine:** Live market rate conversions with admin-configurable exchange rate and automated profit spread calculation, verified server-side to prevent underpayment exploits.
* **Executive Admin Dashboard:** Real-time monitoring of VTpass fiat balance, on-chain vault balances per token/chain, transaction analytics, manual refund tools, and CSV export — protected behind admin auth.
* **Kill Switches That Actually Stop Every Channel:** the dashboard's "pause a service" toggles are a **two-level** model — a per-service master (`MASTER_AIRTIME`, `MASTER_INTERNET`, `MASTER_ELECTRICITY`, `MASTER_CABLE`, `MASTER_EDUCATION`, `MASTER_INTERNATIONAL`) plus a per-provider switch keyed by VTpass serviceID (`AIRTIME_mtn`, `INTERNET_airtel-data`, `ELEC_ikeja-electric`, `CABLE_dstv`, `EDU_waec`). A payment is refused when **either** level is off. `src/lib/serviceRules.ts`'s `killSwitchKeysFor()` maps an agent intent (+ provider, normalised through `resolveServiceId` so `ELEC_ikeja` can't miss `ELEC_ikeja-electric`) onto exactly those keys, so chat, MCP and the autonomous scheduler now honour the same switches the web app does. See [Kill switches](#kill-switches-two-level-master--per-provider) below.
* **Sponsored Gas on Base:** Coinbase Smart Wallet / Base Account users can pay with zero gas fees — the app detects paymaster support via EIP-5792 and batches approval + payment into a single sponsored transaction. Wallets without this capability (MetaMask, WalletConnect, Valora, etc.) transparently fall back to the normal self-paid flow.
* **Shareable & Downloadable Receipts:** Every receipt can be shared as an image straight to WhatsApp/Telegram/etc. via the device's native share sheet, or saved directly as a PNG or PDF.
* **Farcaster Mini App Ready:** Ships with Farcaster frame metadata so AbaPay can be launched directly inside Farcaster clients.

---

## 🛠️ Tech Stack

* **Frontend:** Next.js 16 (App Router, React 19), Tailwind CSS 4, Lucide Icons, next-themes (dark mode)
* **Web3 / Wallets:** Wagmi, Viem (incl. EIP-5792 `sendCalls` for sponsored transactions), WalletConnect Modal, Base Account SDK, Solidity smart contract (Hardhat)
* **Backend:** Next.js Route Handlers (serverless functions)
* **Receipts:** html2canvas (image capture), jsPDF (PDF export)
* **AI:** Claude (Anthropic API) for the DeAI conversational agent and in-app chat widget
* **Agent Identity & Payments:** ERC-8004 (on-chain agent identity, Celo + Base) and x402 (signed in-house with the connected wallet — `src/lib/x402Pay.ts`) for HTTP-native, facilitator-settled payments in the main app
* **Agent Tool Access:** MCP (Model Context Protocol) — Streamable HTTP/JSON-RPC server at `/api/mcp` exposing balance-check and bill-pay tools to any MCP client — and A2A (Agent2Agent) at `/api/a2a`, card at `/.well-known/agent-card.json`, exposing the same tools to peer agents
* **Utility Provider:** VTpass API (bills, airtime, data, education, international airtime)
* **Bank Transfer Provider:** Monnify API (Moniepoint Inc.) — account auto-detect, Name Enquiry verification, and the real NUBAN payout, debited from a Moniepoint Microfinance Bank business account
* **Database / Ledger:** Supabase (PostgreSQL) — transactions, platform settings, points, refunds
* **Email:** Resend (transactional receipt emails)
* **Notifications & Bots:** Telegram Bot API, WhatsApp Cloud API, X (Twitter) API, VTpass Messaging API (SMS)

---

## 👛 Supported Wallets & Environments

AbaPay runs in three distinct runtime environments, detected at load in `src/app/page.tsx`
(`environment` = `MINIPAY` | `FARCASTER` | `WEB`, with `LOADING` as the pre-detection state and a
2-second timeout that falls back to `WEB`). Wallet connectivity for the `WEB` case comes from
`src/config/wagmi.ts`, which registers exactly three connectors: `injected()`, `baseAccount()`,
and `walletConnect()`.

| Wallet / environment | How it connects | Notes |
|---|---|---|
| **MiniPay** (Opera Mini's built-in Celo wallet) | Detected directly via `window.ethereum.isMiniPay`; the app builds its own viem wallet client and locks to Celo | Gas is paid in a stablecoin (`txConfig.feeCurrency`), so users need no CELO. Network switching is intentionally disabled here. |
| **Farcaster Mini App** | Detected via `@farcaster/miniapp-sdk`'s `sdk.context`; uses `sdk.wallet.ethProvider`, locked to Base | Addresses are read with a *silent* `getAddresses()` so opening the app never forces a wallet popup. Frame metadata ships in `public/.well-known/farcaster.json`. |
| **Valora** | **WalletConnect only** — the injected path is deliberately skipped inside Valora's in-app browser (`isValoraBrowser()`) | Pinned to the top of the WalletConnect modal's recommended list via `explorerRecommendedWalletIds`. Celo-only, which the app follows automatically (`walletApprovedChainIds()`). See "Valora is WalletConnect-only" below for why the injected path is off. |
| **MetaMask** and other injected browser wallets | Whichever **EIP-6963-discovered** connector the wallet announced, falling back to the generic `injected()` one | wagmi discovers one connector per installed wallet (`multiInjectedProviderDiscovery`, on by default). See "How the Connect button chooses" below — reading `window.ethereum` instead of these is what used to send web3-browser users to a QR code. |
| **Coinbase Smart Wallet / Base Account** | `baseAccount()` connector | The only wallets that get **sponsored gas** — the app probes EIP-5792 paymaster capability and batches approve + pay into one sponsored call. Everything else falls back to the normal self-paid flow. |
| **Any other WalletConnect v2 wallet** (Trust, Rainbow, Ledger Live, …) | `walletConnect()` connector with the QR modal | Nothing wallet-specific in the code — if it speaks WalletConnect and supports Celo or Base, it works. |

#### How the Connect button chooses

An injected wallet is always preferred: it touches no third-party host, which is why it keeps
working on networks that filter the WalletConnect relay. WalletConnect is the fallback for a
browser that has **no** wallet in it — a plain desktop browser, or a phone browser pairing with
a wallet app.

Which wallets exist is established by **asking**, never by reading `window.ethereum`:
`probeInjectedConnectors()` (`src/lib/walletEnv.ts`) takes wagmi's discovered connectors, gets
each one's own provider, and sends it a timed-out `eth_accounts` — a call that never prompts, so
it is safe on every page load. Each wallet comes back `authorized` (already approved this site),
`available` (real, not yet approved) or `none` (absent, or a stub that never answered).

- **Any wallet `authorized`** → nothing happens on its own. `authorized` decides which wallets the
  chooser can offer *without* a permission popup, not whether to connect. See "Auto-connect is an
  allowlist" below.
- **One or more usable wallets** → a chooser lists them **plus WalletConnect**; cancelling ends
  the attempt rather than falling through to a QR code. One extension that is both
  EIP-6963-announced and parked on `window.ethereum` is de-duplicated, so it can't appear twice.
- **None** → straight to WalletConnect, no pointless one-item modal.

🔴 **WalletConnect is always an option, never only a fallback.** The chooser used to require
*two or more* injected wallets before it appeared, so the very common "one extension installed"
browser connected to that extension silently and was never offered WalletConnect at all — there
was no route to pairing a phone wallet short of uninstalling the extension. The option list is
now built first and the chooser decided from *its* length, which is what turns the single-wallet
case into a real choice.

🔴 **Why not `window.ethereum`:** under EIP-6963 a wallet announces itself over an event rather
than claiming that global — which is how several extensions coexist without fighting over one
slot. So a browser with a perfectly good wallet can have `window.ethereum` undefined, or pointing
at a different wallet than the user means. Probing only the global reported "no wallet", skipped
the injected path entirely, and showed a QR code for a wallet sitting in the same browser.

Prompts also say **where** to approve. Over WalletConnect the request lands in a separate app
that nothing brings to the foreground, so the copy says to open it (`walletApprovalPrompt`).

#### Valora is WalletConnect-only

🔴 **The "first prompt works, the second never comes" hang.** Inside Valora's in-app browser the
page can see something that answers `eth_accounts` — real enough for the probe above to report a
wallet, real enough for auto-connect to fire, real enough for the entire UI to look connected.
Not real enough to pay with. The first request raises a prompt; the user taps **Allow**; Valora
toasts *"Connection to AbaPay was successful!"* — it has taken a payment authorization for a
connection handshake, consumed it, and returned nothing to the page. Nothing rejected, so there
is nothing to catch. The spinner runs forever.

Valora's supported rail is WalletConnect, and over WalletConnect it behaves normally: a real
session request with a real response. So the injected path is skipped inside Valora —
`isValoraBrowser()` suppresses auto-connect and empties the Connect button's injected candidate
list, dropping the click through to WalletConnect.

🔴 **But the page's own globals are not enough to spot Valora.** `isValoraBrowser()` looks for an
`isValora` flag or the name in the user agent, and in Valora's in-app browser **neither is
present**: it injects no provider and its webview reports a stock Android Chrome user agent. The
only thing that names the wallet is the session — WalletConnect exchanges peer metadata on
connect, and `session.peer.metadata.name` is the wallet's own name for itself.

So `connectedWalletIsValora()` reads that instead, and a **restored** Valora session is dropped on
mount so the user pairs fresh. That is deliberately narrow, because the friction only buys
something in one place:

- **Valora only** — every other wallet keeps its restored session.
- **Restored sessions only** — a connection the user just asked for is never yanked away
  (`userInitiatedConnect`).
- **Once per mount**, so it can't fight a connect that's mid-flight.

The trade-off is that peer metadata only exists *after* connecting, so this shapes what happens
next rather than pre-empting the connection. Both detectors are word-bounded — a false positive
would drop a working session (or strip a real in-browser wallet off the rail it should use), which
is the more expensive mistake. Covered in `tests/walletEnv.test.ts`.

#### Cancelling in a wallet is not always an answer

Every cancellation path assumes the wallet reports the rejection — EIP-1193 says it should, and
injected wallets do. **Valora over WalletConnect does not**: dismissing its sheet sends nothing
back over the relay, so there is no rejection to catch, no error and no event. The request stays
open and the page waits on a decision that was already made — *"I cancelled the pop up and it kept
loading for life"*.

`withWalletTimeout` does fire, but 90s of frozen spinner after you've tapped cancel reads as
broken — and that budget has to stay 90s, because it is also how long someone gets to read a
prompt before approving. So after 15s of processing the status banner grows a **STOP WAITING**
control. It cannot abort the in-flight request (nothing on this side can) and deliberately does
**not** claim the payment was cancelled: if the user approves a moment later it still settles, and
saying otherwise is how someone pays twice.

#### Auto-connect is an allowlist: MiniPay, Base App, Farcaster — and nothing else

On the web, **the Connect button is the only way in.** No wallet is connected until the user asks
for it, even one whose extension approved this site months ago.

🔴 **The auto-connect nobody could find was in `WagmiProvider` itself.** wagmi persists the
connector and, with the default `reconnectOnMount`, silently re-establishes it on *every page
load* — inside the provider, before any effect in `page.tsx` runs and regardless of what those
effects decide. So the app came up connected on its own no matter how carefully the rules
downstream were written, and every attempt to fix it by editing those rules was editing the wrong
thing. `Providers.tsx` now passes `reconnectOnMount={false}`.

The rule downstream was also the wrong shape: it auto-connected **any** `authorized` wallet and
carved out Valora by name. That made silent connect the default and removed wallets only after
someone complained, which is how *"it connects by itself and there's no Connect button"* kept
coming back wearing a different wallet's name. It is an allowlist now (`AUTO_CONNECT_SURFACES`).

Those three are different in kind, not degree: the app is running **inside** the wallet, so there
is exactly one account it could mean, the user chose it by opening AbaPay there, and no chooser is
being suppressed because there is nothing to choose between. MiniPay and Farcaster are connected
by their own SDKs and never touch wagmi; Base App arrives through wagmi and is matched by
`looksLikeBaseApp()` — which deliberately refuses the Coinbase **desktop extension**, since that
sets the same `isCoinbaseWallet` flag while being an ordinary injected wallet on an ordinary page.

⚠️ **The trade:** a refresh ends a web session and the user presses **Connect** again. Being asked
is the point, but it is a real cost on a page people reload.

#### A connection the page did not establish is not a connection

`reconnectOnMount={false}` stops wagmi **re-establishing** the connector. It does not stop it
**rehydrating**: the config persists to `cookieStorage` with `ssr: true`, so on load wagmi
restores `connections`/`current` from the cookie and `useAccount()` reports `isConnected` with an
address — while no provider has been set up and no relay socket exists.

🔴 That is one bug wearing two faces, and both were reported: *"Valora still auto connects"*, and
then *"your wallet connection has dropped — tap Connect"* when paying a wallet that looks
perfectly connected. Nothing had dropped. There was never a live session, only a cookie
describing one. A connection this page did not itself establish is now dropped on mount
(`userInitiatedConnect` is what separates the two). Base App is unaffected — its silent connect
calls `connect()` explicitly.

#### Proving the wallet is yours, once per session

🔴 **A filter written by the client is not a permission.** History used to be read straight from
the browser with the anon key, scoped only by `.ilike('wallet_address', address)`. Swap the
address and PostgREST returns someone else's rows — phone numbers, meter numbers, amounts. A
provider that merely *claimed* an address it did not hold was enough, because a wallet address is
public information.

After connecting, the wallet signs a plainly-worded ownership message (`src/lib/walletSession.ts`
— shared by browser and server, because two copies of that string means one stray character
failing every signature as "invalid signature"). `GET /api/history` derives the address **from
that signature** and queries with the service-role client, so no parameter remains that could
point at another person's records.

- `verifySignatureAcrossChains` already covers EOAs *and* ERC-1271/6492 smart accounts, so Base
  Account and Safe are not locked out by the signature being a shape we could not check.
- A **rejection** disconnects — the user declined to prove the address is theirs.
- Any **other** failure leaves them connected but unproven: they can still pay, because paying is
  authorised by the payment signature itself, and only history is withheld. Locking someone out
  of paying for owning an unusual wallet would be worse than the bug being closed.
- Read-only, and for a session rather than five minutes, because a wallet popup on every History
  refresh trains people to sign whatever they are shown. It is a bearer credential for that
  window; mutations keep their own fresh, per-action signatures (`verifyWalletOwnership`).

#### A restored WalletConnect session is not a live one

🔴 **The "auto-connects, then hangs forever" failure.** wagmi persists the WalletConnect session
(`cookieStorage`) and restores it on load — that is the *"it auto-connects after a while"* users
describe. Restoring produces an address, and an address is all the UI needs to look connected:
balances render (they come from a public RPC and never touch the wallet), the pay button enables,
everything reads as normal.

But a WalletConnect request only reaches the phone if the **relay socket is open**. Restored over
a dead socket, `eth_sendTransaction` is written to a closed pipe: no prompt appears in the wallet,
nothing comes back, and **there is no error to catch, because nothing rejected** — the request
simply went nowhere. From the page it is indistinguishable from a user who hasn't looked at their
wallet yet, which is why it presented as an eternal spinner.

`walletConnectSessionLive()` (`src/lib/walletEnv.ts`) checks the relay before any wallet
interaction; a dead session is reported in one sentence and disconnected so **Connect** pairs
fresh instead of restoring the same corpse. A missing socket internal is treated as *live* —
a false negative would disconnect working wallets on every payment. Injected wallets return
`null`: they are in-process and have no socket to lose.

Every wallet call also has a timeout now, including the chain-switch handshake and the Base
`sendTransaction`, which had none. On a wallet app, a timeout is reported as "your wallet never
received the request" with a reconnect, since that is what it almost always means.

`walletApprovedChainIds()` is a related guard: a WalletConnect wallet silently drops requests for
a chain outside its approved session, so if the connected wallet never approved the active chain
the app follows it to one it did.

#### The default chain is Base

`DEFAULT_CHAIN` in `src/constants/index.ts` is **`BASE`**, and everything forward-looking reads
from it: the chain a freshly connected wallet lands on, the token picker's seed before a wallet
is connected, and the chain an agent link approves when the caller doesn't name one. Celo is
fully supported and switchable — nothing was dropped, it just isn't where you start.

Chains registered in `wagmi.ts`, in order: **Base, Base Sepolia, Celo, Celo Alfajores**. wagmi
treats `chains[0]` as the default and offers the rest as *optional* WalletConnect namespaces, so
a Celo-only wallet still connects fine (see the Valora row above). Note the app's own non-wagmi
paths (`src/lib/chain.ts`, `page.tsx`) use viem's **`celoSepolia`** as the Celo testnet, while
`wagmi.ts` still lists `celoAlfajores`; mainnet is unaffected, but they should be reconciled if
testnet WalletConnect flows are exercised.

`LEGACY_RECORD_CHAIN` is the deliberate counterpart, and it stays **`CELO`**. It is how a
*stored* row with an empty `blockchain` column is read — such rows predate the column being
written and were all on Celo. It must not follow `DEFAULT_CHAIN`: reading an old Celo payment as
Base would send the webhook hunting for a receipt on the wrong chain and strand a real payment
as unvended.

Stablecoins: **USD₮** and **USDC** on both chains, plus **cUSD/USDm** on Celo only. Which token
a chain *leads* with, and in what order the rest follow, is `TOKEN_ORDER_BY_CHAIN` in
`src/constants/index.ts` — **Base: USDC then USD₮; Celo: USD₮, USDC, USDm**. One
`tokensForChain()` serves the Pay tab, the Agent Hub, the chat agent and the MCP tools, which
each used to filter `SUPPORTED_TOKENS` themselves and could therefore disagree.

---

## 📁 Project Structure

```
src/
├── app/
│   ├── page.tsx              # Main storefront (pay flow, wallet connect, history, env detection)
│   ├── admin/page.tsx         # Admin ops dashboard (incl. the kill-switch toggles)
│   ├── docs/page.tsx          # Docs & FAQ page
│   ├── terms/, privacy/       # Legal pages (standalone routes; the in-app modals live in components/Modals.tsx)
│   ├── .well-known/           # OAuth discovery metadata, incl. the RFC path-insertion variants
│   │   ├── oauth-authorization-server/{route.ts, api/mcp/route.ts}
│   │   └── oauth-protected-resource/{route.ts, api/mcp/route.ts}
│   └── api/
│       ├── pay/                # Core payment + vending endpoint (pay/x402/ is the x402 rail)
│       ├── paymaster/           # Server-side proxy for Base gas-sponsorship (keeps the CDP paymaster key off the client)
│       ├── providers/           # Live VTpass provider catalogue for the browser's pickers
│       ├── requery/             # Delayed/timeout transaction requery
│       ├── rate/, admin/rate/   # Exchange rate endpoints
│       ├── variations/          # VTpass service variation lookups
│       ├── intl/, foreign/      # International bill pay (countries/products/operators/rates)
│       ├── verify/              # Meter/account/customer verification
│       ├── admin/                # Admin data, actions, refunds, health
│       ├── discounts/            # Discount campaign lookup
│       ├── schedules/            # Recurring + one-off scheduled bill execution
│       ├── user/points/          # AbaPoints balance
│       ├── agent/                # Agent link/allowance management (Agent Hub)
│       ├── deai/                 # Conversational AI agent
│       ├── mcp/                  # MCP server (describe_capabilities, check_balance, list_plans, pay_bill)
│       ├── oauth/{register,authorize,token}/  # OAuth 2.1 (DCR, consent page, token endpoint) for MCP
│       ├── cleanup/              # Stale pre-flight intent sweeper
│       ├── webhook/, webhook/vtpass/  # VTpass + on-chain webhooks
│       ├── monnify/              # Moniepoint bank list, account resolve/verify, transfer webhook
│       ├── telegram/webhook/, whatsapp/webhook/, x/webhook/  # Bot channel webhooks
│       └── support/              # Support ticket submission
├── components/                 # Shared UI (AppFooter, Modals — Terms/Privacy/FAQ/Receipt —, tabs, AIChat, AgentHub, Admin panels)
├── config/wagmi.ts             # Wallet/chain configuration (injected, Base Account, WalletConnect)
├── constants/                  # Supported tokens, services, initial country list
├── lib/
│   ├── vtpassCatalog.ts         # ⭐ Live VTpass provider catalogue + per-provider amount limits
│   ├── providerFallback.ts      # Offline seed used only when VTpass is unreachable
│   ├── monnify.ts               # Moniepoint (Monnify) API client — banks, verify, transfer
│   ├── monnifyVend.ts           # Bank transfer vend + finalize (success/failure/refund)
│   ├── serviceRules.ts          # Kill switches, operator agent caps, min/max amounts
│   ├── refunds.ts               # Refund queue (enqueue on vend failure + user notification)
│   ├── vend.ts                  # Shared vend execution for the contract and x402 rails
│   ├── attribution.ts           # Celo Builders on-chain attribution tag (ERC-8021 dataSuffix)
│   ├── parity.ts                # Shared validation so chat/MCP match the web form
│   ├── deai/                    # Intent parsing, capabilities, selection, relayer (payBillFor),
│   │                            #   mcpAuth.ts (API key), mcpOAuth.ts (OAuth token lifecycle)
│   └── ...                      # VTpass, Telegram, WhatsApp, scheduler, discount helpers
└── utils/                      # Supabase client, admin auth, PIN hashing
contracts/
├── AbaPay.sol                   # V1 — original escrow/vault smart contract
├── AbaPayV2.sol                 # V2 — hardened (see below)
└── AbaPayV3.sol                 # V3 — adds agent-initiated payments (⚠️ NOT AUDITED)
scripts/
├── deploy.ts                     # Deploy V1
├── deployV2.ts                   # Deploy V2
└── deployV3.ts                   # Deploy V3 (whitelists tokens, sets relayer + per-tx caps)
```

---

## ⚙️ Environment Variables

Create a `.env.local` file in the project root. **Never commit this file to GitHub.**

### App / Network Config
```
NEXT_PUBLIC_APP_MODE=sandbox                     # sandbox | production
NEXT_PUBLIC_NETWORK=celo-sepolia                 # celo-sepolia | celo | base | base-sepolia
NEXT_PUBLIC_FIXED_RATE=1550.00                    # Fallback NGN exchange rate
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=your_walletconnect_project_id
NEXT_PUBLIC_WC_RELAY_URL=                         # Optional. Override the WalletConnect relay — see "Blocked networks" below
```

#### Blocked networks

Connecting an external wallet depends on third-party hosts that some networks filter —
chiefly `relay.walletconnect.org` (the WalletConnect relay) and `api.web3modal.org` (the
wallet chooser). Because the relay is a WebSocket, a block produces **silence** rather than
an error, which reads to the user as "the Connect button is broken".

This is confirmed on at least one carrier — the connect flow works over a VPN and hangs
without one — but we have no data on how many networks or regions are affected. **No
user-facing copy names a carrier or country**, deliberately: telling someone their problem is
carrier X when they are not on carrier X just makes them distrust the message. `/network-check`
reports what is actually blocked for the user in front of it.

Two things address this:

- **`/network-check`** — a page any user can open that probes each dependency from their own
  connection and names the ones that fail. It is linked from the connect-failure banner and
  from the FAQ, and doubles as the evidence to quote in a complaint to whichever carrier or
  regulator turns out to be involved.
- **`NEXT_PUBLIC_WC_RELAY_URL`** — point this at a WebSocket reverse proxy on a domain of
  yours that isn't filtered (e.g. `wss://relay.abapays.com` forwarding to
  `wss://relay.walletconnect.org`) and WalletConnect wallets start working on those networks.
  Relay traffic is end-to-end encrypted, so the proxy is a pipe, not a man-in-the-middle.
  Note that **Vercel functions cannot proxy long-lived WebSockets** — host it on Cloudflare
  Workers, Fly.io, or a VPS running nginx with `proxy_pass` and the `Upgrade` headers.

**MiniPay, Base App and Farcaster need none of these hosts** — the first two inject a provider
straight into the page and Farcaster supplies its own wallet through the Mini App SDK. They
stay reliable on a filtered network, and are what the app recommends when a connect fails
(`RELAY_FREE_SURFACES` in `src/lib/walletEnv.ts`).

### Smart Contracts (per chain)
```
NEXT_PUBLIC_ABAPAY_ADDRESS=0xYourDefaultContractAddress
NEXT_PUBLIC_ABAPAY_CELO_ADDRESS=0xYourCeloContractAddress
NEXT_PUBLIC_ABAPAY_BASE_ADDRESS=0xYourBaseContractAddress
ADMIN_WALLET_ADDRESS=0xYourAdminWalletAddress
CELO_PRIVATE_KEY=your_deployer_private_key         # Used only by Hardhat for deployment — never expose client-side
```

### Paymaster (Base Gas Sponsorship)
```
PAYMASTER_URL=https://api.developer.coinbase.com/rpc/v1/base/your_cdp_api_key   # Server-only — never NEXT_PUBLIC. The app proxies wallet paymaster requests through /api/paymaster so this key never reaches the browser.
```
⚠️ Two things this env var alone won't cover, both configured in external dashboards:
- **Coinbase Developer Platform:** create a Paymaster Policy allowlisting your `NEXT_PUBLIC_ABAPAY_BASE_ADDRESS` contract (and ideally the specific `payBill`/`approve` selectors), with a funded/budgeted balance to sponsor from.
- **Alchemy webhook config:** make sure the **"Token"** activity category is enabled on your Base webhook (not just "External"). Under gas sponsorship, the top-level transaction's `to` is the bundler/EntryPoint contract, not your AbaPay contract directly — only Token-category (ERC-20 Transfer log) monitoring reliably fires regardless of call depth.

### VTpass (Bill Payment Provider)
```
VTPASS_API_KEY=your_api_key
VTPASS_PUBLIC_KEY=PK_your_public_key
VTPASS_SECRET_KEY=SK_your_secret_key
VTPASS_MSG_TOKEN=VT_PK_your_token
VTPASS_MSG_SECRET=VT_SK_your_secret
```

### Monnify (Moniepoint's API — Bank Transfer Provider)
```
MONNIFY_API_KEY=MK_your_api_key
MONNIFY_SECRET_KEY=your_secret_key
MONNIFY_CONTRACT_CODE=your_contract_code
MONNIFY_SOURCE_ACCOUNT_NUMBER=your_wallet_account_number
```
See `ENV_SETUP.md` §9b for where to find these and the MFA/webhook setup steps.

### Supabase (Database)
```
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key    # Server-side only — full DB access
```

### Email (Resend)
```
RESEND_API_KEY=re_your_resend_key
```

### AI Agent (DeAI)
```
ANTHROPIC_API_KEY=sk-ant-...                  # Claude powers the DeAI intent engine (replaced Gemini).
DEAI_INTERNAL_SECRET=any_long_random_string   # Optional. Signs internal calls to the DeAI brain so /api/deai/* can't be hit directly from the internet, AND signs the agent's payment deep links. Falls back to SUPABASE_SERVICE_ROLE_KEY if unset.
```

**How DeAI actually pays (non-custodial):** there is no server-side key for the user (there
must never be one; that would make AbaPay a custodian), so the agent does everything *except*
hold keys. Two paths exist:

1. **Deep link (V1/V2 contracts, or a user without an allowance):** the agent parses the
   request with Claude, verifies the meter/account against real VTpass, confirms details in
   chat, then returns a **signed, 15-minute deep link** that opens the app pre-filled. The user
   taps, their own wallet signs, and the payment runs through the same verified pipeline as the
   web app.
2. **Delegated allowance (AbaPayV3, `src/lib/deai/relayer.ts`):** if the user has granted an
   on-chain `spendingAllowance` (see [AbaPayV3](#abapayv3sol--agent-initiated-payments-️-not-audited)
   below), the relayer calls `payBillFor()` directly — no deep link, no signature at payment
   time — bounded entirely by the allowance the user set and revocable by them at any moment.
   Before broadcasting, a `preflight_<wallet>_<timestamp>` transaction row is written (the same
   pattern the web app uses ahead of a signature), then renamed to the real tx hash once
   confirmed — so the payment is vended through the exact same verified pipeline as every other
   rail, and a stale/abandoned attempt is swept automatically rather than left dangling. If the
   RPC can't confirm the receipt in time (a network hiccup right after broadcast — including
   right after the user enters their PIN), the agent reports it as *pending*, not failed, and
   will never hand out a duplicate payment link for that same intent — avoiding both a lost
   payment and a double-charge. If no allowance is approved for the chain/token a payment needs,
   the agent detects that before ever attempting the relay and offers a choice: approve it now
   in the Agent Hub, or complete just this one payment via a signed deep link.

### Telegram
```
TELEGRAM_BOT_TOKEN=your_admin_bot_token
TELEGRAM_ADMIN_CHAT_ID=your_admin_chat_id
TELEGRAM_CHAT_ID=your_default_chat_id
TELEGRAM_WEBHOOK_SECRET=your_webhook_secret
SUPPORT_TELEGRAM_BOT_TOKEN=your_support_bot_token
DEAI_TELEGRAM_BOT_TOKEN=your_deai_bot_token
```

### WhatsApp Cloud API
```
WHATSAPP_ACCESS_TOKEN=your_whatsapp_access_token
WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id
WHATSAPP_VERIFY_TOKEN=your_verify_token
WHATSAPP_APP_SECRET=your_meta_app_secret   # ⚠️ REQUIRED. Verifies the X-Hub-Signature-256 on inbound webhooks so senders can't be spoofed.
WHATSAPP_SCHEDULE_TEMPLATE_NAME=schedule_update   # Approved utility template used when the 24h window has closed. Unset = scheduled payments go unreported on WhatsApp.
WHATSAPP_SCHEDULE_TEMPLATE_LANG=en                # Must match the template's language exactly ('en' and 'en_US' are different templates).
```

#### The 24-hour window, and why the scheduler needs a template

🔴 WhatsApp lets a business send **free-form text** only within **24 hours of the user's last
message**. Outside that window Meta rejects the send with error **131047** and the *only* thing
that gets through is a pre-approved template.

**Business Verification does not lift this.** Verification governs how *many* unique people you
may message outside a window (250 → 1,000 → higher); it has no bearing on *what* you may send
them. The two are independent, and conflating them is why this looked like it should already work.

`src/lib/scheduler.ts` is the caller this bites: a payment scheduled for tomorrow reports back
long after the chat that created it went quiet, so "your electricity bill was paid" was rejected
every time — and swallowed, so the only symptom was a user who never heard back and had to find
the receipt in History themselves.

`sendWhatsAppMessage()` now sends text first (free, and correct while the window is open) and
retries through the template **only** on 131047. Any other failure — expired token, blocked
recipient — is not retried, since re-sending costs quality rating for nothing.

**To make it work, create the template** in WhatsApp Manager → Templates, category **Utility**,
with exactly one body variable:

```
AbaPay scheduled payment update:

{{1}}

Open AbaPay to see the full receipt in your History.
```

Then set `WHATSAPP_SCHEDULE_TEMPLATE_NAME` to its name. Utility templates sent *inside* an open
window are free, so the fallback costs nothing in the common case.

⚠️ **Template body parameters may not contain newlines, tabs, or 4+ consecutive spaces** — Meta
rejects the whole send. Every scheduler message is multi-line, so `toTemplateParameter()`
flattens them (paragraph breaks become `—`) and truncates at Meta's 1024-character cap. Covered
in `tests/whatsapp.test.ts`.

⚠️ **`WHATSAPP_APP_SECRET` is required, not optional.** The webhook **fails closed**: with it
unset, `POST /api/whatsapp/webhook` returns **503 `Webhook not configured`** and every delivery
from Meta is rejected — the bot goes completely silent with no other symptom. That is deliberate
(an unset secret used to skip verification entirely, leaving anyone able to impersonate any
sender), but it means *forgetting to set it looks exactly like the bot being broken*.

To check a live deployment, POST an unsigned body at the webhook and read the status:
`503` = the secret is missing; `401 Invalid signature` = the secret is set and the gate is
working. Find the value in Meta App Dashboard → **App Settings → Basic → App Secret**. The same
fail-closed rule applies to `TELEGRAM_WEBHOOK_SECRET` and `X_CONSUMER_SECRET`.

### X (Twitter)
```
X_BEARER_TOKEN=your_bearer_token
X_CONSUMER_SECRET=your_consumer_secret   # ⚠️ REQUIRED — the webhook returns 503 without it (same fail-closed rule as WhatsApp).
X_BOT_ACCOUNT_ID=your_bot_account_id
```

### On-Chain Webhooks (Alchemy)
```
ALCHEMY_WEBHOOK_SECRET=your_alchemy_base_webhook_secret
ALCHEMY_CELO_WEBHOOK_SECRET=your_alchemy_celo_webhook_secret
```

### Contract Verification
```
ETHERSCAN_API_KEY=your_etherscan_or_celoscan_api_key
```

### Agent Relayer (AbaPayV3 — autonomous bill payments)
```
RELAYER_PRIVATE_KEY=0x...        # ⚠️ HOT KEY. Only needed if you deploy AbaPayV3 and enable agent payments.
NEXT_PUBLIC_APP_URL=https://abapays.com   # Used to build agent payment deep links.
```
⚠️ **Understand the blast radius before enabling this.** The relayer key can spend **at most each user's remaining on-chain allowance**, and only via `payBillFor`. It **cannot** drain a user's wallet, raise anyone's allowance, or withdraw the vault — those bounds are enforced by the *contract*, not the backend. If the key leaks, the owner calls `setRelayer(address(0))` and it is instantly dead. Fund it with gas only; it should never hold token balances.

### Agent Identity (ERC-8004) — one-time registration only
```
ERC8004_AGENT_URI=https://abapays.com/.well-known/agent.json   # Used only by scripts/register8004.ts
ERC8004_REGISTRY_CELO_MAINNET=0x8004A169FB4a3325136EB29fA0ceB6D2e539a432   # Optional override
ERC8004_REGISTRY_CELO_SEPOLIA=0x8004A818BFB912233c491871b3d84c89A494BD9e  # Optional override
ERC8004_REGISTRY_BASE_MAINNET=0x8004A169FB4a3325136EB29fA0ceB6D2e539a432  # Optional override — same address as Celo mainnet, confirmed byte-identical via eth_getCode
NEXT_PUBLIC_ERC8004_AGENT_ID=                                  # Optional. Set after registering, for UI display.
```
Uses the same `CELO_PRIVATE_KEY` Hardhat already has configured — this is identity registration only, it never touches payments.

**How to register:** identity is **per-chain** — there's no cross-chain agent record, so this is run once per chain, and both registrations point at the *same* `agent.json` URL.
1. Deploy `public/.well-known/agent.json` (edit its `wallet.address` to your real `RELAYER_ADDRESS` first) so it's reachable at `https://<your-domain>/.well-known/agent.json`.
2. Set `ERC8004_AGENT_URI` above to that URL.
3. `npx hardhat run scripts/register8004.ts --network sepolia` first — confirm the tx on [Celo Sepolia Celoscan](https://sepolia.celoscan.io) and check the `Registered` event for the correct URI and agent ID.
4. Only after that passes: `npx hardhat run scripts/register8004.ts --network celo` — spends real gas, mints the Celo identity permanently (AbaPay's live Celo agent ID: **9687**).
5. Separately, `npx hardhat run scripts/register8004.ts --network base` — mints the *Base* identity (AbaPay's live Base agent ID: **59561**). Same URI, different registry/chain, different agent ID.
6. Set `NEXT_PUBLIC_ERC8004_AGENT_ID` to the agent ID the script prints. Look up either identity at [8004scan.io](https://8004scan.io).

Both registrations only ever store the **URL**, not the card's contents, so editing `agent.json` (e.g. to add a new declared service) changes what the URL *returns* with no new transaction. But that alone is not enough for a scanner like 8004scan to notice: indexers appear to snapshot the card at registration time rather than polling the URL on a schedule, so there's no on-chain signal telling them anything changed. `scripts/update8004uri.ts` closes that gap — it calls the registry's `setAgentURI(agentId, sameURI)`, re-emitting a fresh `URIUpdated` event (without changing the URI itself) purely to give an indexer something new to react to:
```
ERC8004_AGENT_ID=9687  ERC8004_AGENT_URI=https://abapays.com/.well-known/agent.json npx hardhat run scripts/update8004uri.ts --network celo
ERC8004_AGENT_ID=59561 ERC8004_AGENT_URI=https://abapays.com/.well-known/agent.json npx hardhat run scripts/update8004uri.ts --network base
```
Run this any time `agent.json`'s contents change (like the `mcp` service entry above) and you want an already-registered identity to be re-read.

### x402 Settlement (main app, Celo + USDC/USD₮)
```
CELO_X402_API_KEY=your_x402_celo_org_api_key   # Server-side: settles via api.x402.celo.org
```
No client-side SDK key is needed: the payer's EIP-3009 authorization is signed by the wallet
the user already connected (`src/lib/x402Pay.ts`), not by a second wallet SDK.
```env
NEXT_PUBLIC_X402_ENABLED=                      # Default ON. Set to "false" to use the contract call instead
```

**x402 is the default settlement rail on both chains** — **USDC or USD₮ on Celo** (each settling
against its own EIP-712 domain) and **USDC on Base** — so payments are genuinely indexed on
x402scan rather than being relabeled contract calls. Everything else (cUSD/USDm) uses the normal
contract call. It never touches the agent-initiated flow, since x402 needs a fresh signature per
payment. Distinct infra from `RELAYER_PRIVATE_KEY` above.

⚠️ **Expect some wallets to warn about the signature, and know why.** x402 settles via an
EIP-3009 `transferWithAuthorization` — a signature permitting a third party to move the tokens.
That is structurally the same request a token-drainer makes, so some wallet security scanners
flag it: **Zerion has shown AbaPay's own request as "Malicious Request — Approving this may risk
total asset loss."** on a routine bill payment, while the same payment via the contract call
reads as an ordinary Send with *"No Risks Found"*. This is inherent to how x402 works — the very
property that makes a payment provable on x402scan is what the scanners object to — not a fault
in the request. It is a deliberate trade.

Escape hatches, per chain: `NEXT_PUBLIC_X402_ENABLED=false` moves everything to the contract-call
rail; `NEXT_PUBLIC_BASE_X402_ENABLED=false` moves only Base. Both default to on.

x402 runs on **every wallet, every environment and both chains**. An earlier version restricted it
to in-browser wallets, on the theory that Valora's *"Verify wallet"* prompt swallowing the x402
signature was why it hung; testing disproved that — routed to the contract call, Valora hung at
exactly the same point on a plain `eth_sendTransaction` with no signature involved. The settlement
rail was never the problem, so making every other environment pay for it bought nothing.

🔴 **The one remaining limit is the TOKEN, not the chain and not the wallet.** x402 settles on an
EIP-3009 `transferWithAuthorization` signature, so it only works on tokens that implement one.
Celo's USDC and USD₮ both do; on Base, USDC does and **Tether's USD₮ does not** — there is no such
function on that contract to sign against.

That is why the chain's *lead* stablecoin matters so much. Base leads with USDC
(`TOKEN_ORDER_BY_CHAIN`), so the default path on Base **is** x402. The token-reset effect used to
fire only when the selected token didn't exist on the new chain — and USD₮ exists on *both*, so
arriving on Base from Celo silently kept USD₮ selected and quietly demoted every Base user to the
contract call. It is now keyed on the chain ID, so switching chain resets to that chain's lead
stablecoin while never fighting a user who deliberately picks the other token in place.

Settlement runs through **Celo's own x402 facilitator** (`api.x402.celo.org` mainnet /
`api.x402.sepolia.celo.org` testnet — built by Celo Core Co.), not thirdweb. thirdweb is
still used client-side only, for `useFetchWithPayment`'s wallet-signing plumbing (protocol-
generic — it reads the payment challenge from the response body, which works against any
compliant facilitator, not just thirdweb's own). Chosen over thirdweb's own facilitator
because: flat **$0.001/settlement** via prepaid credits vs. thirdweb's ~0.3% cut, **no
billing plan required** to settle on mainnet (thirdweb requires one or every mainnet
settlement fails with `DELEGATION_CHECK_FAILED`), and genuinely non-custodial — the signed
payment authorization pays the vault directly, with no intermediate hop through the
facilitator's own wallet.

**How to get the API key:**
1. Go to [x402.celo.org](https://x402.celo.org) → **Connect wallet** (any wallet works — this is just to sign a free, gasless message, not a transaction).
2. You're issued an API key instantly, plus free credits (500 mainnet, 1000 testnet at time of writing) — **the full key is shown only once**, copy it immediately.
3. Set `CELO_X402_API_KEY` to that key — the same key works for both the mainnet and testnet endpoints, which are tracked as separate credit pools.
4. Top up credits (USDC deposit, $1 ≈ 1,000 credits) from the same dashboard before you run out — `/settle` starts returning 402 at 0 credits, and the app sends a Telegram alert when that happens (see `src/app/api/pay/x402/route.ts`).
5. Nothing else to sign up for — the client side needs no SDK account. The payment authorization is signed by the wallet the user already connected, through the app's own viem wallet client (`src/lib/x402Pay.ts`).
6. Add the var to `.env.local` **and** your hosting provider's production environment variables, then redeploy — `NEXT_PUBLIC_*` vars are baked in at build time, so existing deployments won't pick up a change without a rebuild.

### Cron / Maintenance
```
CRON_SECRET=any_long_random_string   # Optional. Protects /api/cleanup and both /api/schedules/run* endpoints.
```
Stale abandoned pre-flight intents are swept automatically and opportunistically from inside the webhook (throttled, non-blocking) — this needs **no Vercel cron and works on the free/Hobby plan**. `/api/cleanup` remains available for manual runs or an external free scheduler (cron-job.org, GitHub Actions) if you want a guaranteed cadence during quiet periods.

**Scheduled Bills / Autopay Agent — these two DO need an external cron to actually run:**
unlike the webhook-driven cleanup above, nothing calls these on its own.
- `/api/schedules/run` — recurring bills (monthly/weekly/daily). Register once or twice a
  day at [cron-job.org](https://cron-job.org) (free) hitting `POST https://<your-domain>/api/schedules/run`
  with header `Authorization: Bearer <CRON_SECRET>` (or `x-cron-secret: <CRON_SECRET>`).
- `/api/schedules/run-instant` — one-off future payments from the DeAI chat ("buy me MTN
  airtime in the next 10 minutes"). Needs a much tighter cadence to actually land close to
  the requested time — register a **separate** free cron-job.org job hitting
  `POST https://<your-domain>/api/schedules/run-instant` every **1–5 minutes**. It's cheap
  even at that frequency: the query is scoped to `frequency = 'once'` rows only, so most
  ticks find nothing due and return immediately.

Without registering these, users can still create schedules (recurring or one-off) from the
chat, but nothing will ever execute them — they'll sit `is_active` forever with no cron to
pick them up.

**Dune dashboards — refreshed daily, automatically:**
```
DUNE_API_KEY=your_dune_api_key        # Required by /api/cron/dune-refresh
```
There are **two** public dashboards on the `abapay` Dune team, and `/api/cron/dune-refresh`
re-runs both:

| `?dashboard=` | What it covers | Queries |
|---|---|---|
| `main` (default) | The original combined dashboard — Celo **and** Base, split by chain | 7 |
| `base` | **Base mainnet only**, both AbaPay deployments and both settlement rails (contract calls **and x402**) — [dune.com/abapay/abapay-on-base](https://dune.com/abapay/abapay-on-base) | 9 |

The Base-only dashboard exists because on the combined one every Base figure is a *slice* of a
Celo+Base total, so per-chain user counts, DAU and new-vs-returning are all mixed. The Base
dashboard is scoped to Base at the source, and it tracks **both** Base contracts —
`0xC0A4dAA04DEd9c54D1239507B5A5E645761ef488` (AbaPayV4, current) and
`0xF3AeFF0c326B1277A2D8623b7694aEB5E6A565e5` (the original AbaPay V1) — so the history doesn't
restart at the redeploy. Its SQL is version-controlled in [`dune/base-chain/`](dune/base-chain/)
and deployed with `node scripts/dune-base-setup.mjs`; see that directory's README.

**Automatic daily refresh — two mechanisms, both required:**

| Layer | What keeps it fresh | When |
|---|---|---|
| **Data** — one materialized view per dashboard (`dune.abapay.result_abapay_unified_payments`, `dune.abapay.result_abapay_base_events`) | Dune's own matview cron | 02:00 UTC daily |
| **Panels** — the 10 queries that have charts (5 per dashboard) | [`.github/workflows/dune-refresh.yml`](.github/workflows/dune-refresh.yml) → `/api/cron/dune-refresh` | 03:15 UTC daily |

The workflow needs two repository secrets, `APP_URL` and `CRON_SECRET`.

⚠️ **Something outside this repo also calls `?dashboard=main`.** On 2026-08-15 the only workflow
run started 03:51 UTC, yet the five `main` panel queries were executed again at 05:15:03–05:15:10
— 1.5s apart, which is this route's own `SPACING_MS`, so it is this endpoint being called by
another scheduler (a Vercel dashboard cron or an external cron service predating the workflow).
It is not harmful, but it **masks failures**: `main` gets a second attempt each day and therefore
always looks healthy, while `base` — which nothing else covers — stays stale whenever the
workflow run fails. Worth finding and removing so both dashboards have the same single owner.

**A refresh is only "done" when the execution COMPLETES.** `/execute` returning an
`execution_id` means Dune accepted the job, not that the query ran: an accepted execution can
still end `QUERY_STATE_FAILED`, leaving the panel on yesterday's result while the cron reports a
clean 200. The route therefore polls every execution to a terminal state and makes one spaced
retry pass over whatever genuinely didn't refresh, and the two dashboards are separated by 60s
so the second one doesn't start into a rate limiter the first one just saturated. `base` is
always the second call, which is why it was always the casualty.

A dashboard panel renders the **last execution** of the query behind it, and refreshing a matview
does *not* count as an execution of that query. So the matview cron alone never moves a panel —
the combined dashboard sat six days stale while its matviews were refreshing every six hours —
and executing the queries alone would only re-aggregate a stale table. Both halves, every day.

**Why not use Dune's own scheduler?** Its built-in **query** scheduler runs only on the medium
and large engines, and the `community_fluid_engine_v2` plan has neither — requesting `medium`
returns *"Performance medium is not supported for this dataset"*, so the in-app schedule never
fires however it is configured. Matview crons are the one piece of Dune-native scheduling that
*does* work on this plan, which is why the data layer uses them and the panel layer uses the API.

Each dashboard has a **root query** that feeds the matview the rest aggregate. The cron
deliberately does **not** execute the roots: neither has a chart of its own, so running one costs
credits to update nothing. Every query the cron does execute reads a matview rather than raw
chain tables — well under **1 credit for all ten**, against a 2,500/month quota. A few queries
are deployed but kept off the dashboards; the cron deliberately skips those, because executing
a query with no panel spends credits updating something nobody can see.

---

## 🚀 Installation & Setup

1. **Clone the repository**
   ```
   git clone https://github.com/investorphem/abapay.git
   cd abapay
   ```

2. **Install dependencies**
   ```
   npm install
   ```

3. **Set up environment variables** — copy the variables above into `.env.local`.

4. **Run the development server**
   ```
   npm run dev
   ```

5. **Access the application**
   * User Storefront: http://localhost:3000
   * Docs & FAQ: http://localhost:3000/docs
   * Admin Ops Center: http://localhost:3000/admin

### Smart Contract Development (Hardhat)

```
npx hardhat compile          # Compile contracts
npm run test:contracts       # Run the Solidity test suite
npx hardhat run scripts/deployV2.ts --network <network>   # Deploy the hardened V2
npx hardhat run scripts/deployV3.ts --network <network>     # Deploy V3 (agent-initiated payments)
npx hardhat run scripts/register8004.ts --network <network> # Register the agent identity (ERC-8004)
npx hardhat run scripts/update8004uri.ts --network <network> # Re-push the agent URI so an indexer (8004scan) re-reads it
```

#### `AbaPayV2.sol` — hardened contract (⚠️ NOT YET AUDITED)

`contracts/AbaPayV2.sol` is a security-hardened successor to the original `AbaPay.sol`,
addressing the findings in `AUDIT_REPORT.md`. **`payBill`'s signature and the
`PaymentReceived` event are byte-for-byte identical to V1**, so the frontend, the `/api/pay`
calldata decoder, and the webhook's event cross-validation all work with no backend changes.

| Hardening | Why |
|---|---|
| `SafeERC20` | Non-compliant tokens (e.g. some USDT deployments) don't return a bool; raw `require(transfer(...))` breaks on them. |
| `ReentrancyGuard` | `setTokenSupport` can whitelist *any* token; a hook-bearing token would otherwise make `payBill` reentrant. |
| `Pausable` | V1 had no kill switch — a post-deploy vulnerability could not be stopped. Refunds stay live while paused so users can be made whole. |
| `Ownable2Step` | Prevents permanently bricking the contract by transferring ownership to a typo'd address. |
| **Timelocked withdrawals** | **The biggest V1 risk:** a single compromised owner key could drain the entire pooled vault instantly. Withdrawals must now be queued, then executed after a delay — alert on `WithdrawalQueued` and cancel if it wasn't you. Fixed at 24h in V2/V3; **owner-adjustable in V4** (see below). |
| **Capped refunds** | V1's `refundUser` was an unrestricted "send any amount anywhere" path that bypassed any withdrawal control. Now bounded per-token (and fails closed until a cap is set). |
| Balance-delta accounting | Emits the amount *actually received*, so fee-on-transfer tokens can't cause the backend to over-vend. |

**Before mainnet:**
1. **Get a professional audit.** This contract holds pooled customer funds; a static review is not sufficient.
2. **Set `ABAPAY_OWNER` to a multisig (Safe), not an EOA.** The timelock buys detection time — it only *stops* an attacker if a stolen key can't unilaterally cancel and re-queue, and it buys nothing at all if the delay has been set to 0 (see V4 below).
3. Deploy to testnet and run the full payment flow end-to-end first.
4. Call `setMaxRefund` for each token — **refunds revert until a cap is configured.**

> `payBill` still uses `transferFrom(msg.sender, …)`, so the payer must be the signer. Delegated
> spending (the DeAI "pay from social media" feature) needs an additional on-chain allowance
> mechanism and is deliberately **out of scope** for this hardening pass — it should be designed
> and audited as its own change.

#### `AbaPayV3.sol` — agent-initiated payments (⚠️ NOT AUDITED)

`contracts/AbaPayV3.sol` builds on V2 to solve the problem above: on Telegram/WhatsApp there is
no wallet to sign with, so the agent could previously only hand the user a deep link to sign in
the app. V3 adds a **session-key / delegated-spend** pattern instead:

1. The user, from their own wallet, does two things once: a standard ERC-20 `approve(AbaPayV3, X)`,
   and `setSpendingAllowance(token, X)` — an on-chain cap **they** control.
2. After that, the authorised **relayer** (a backend hot key, `RELAYER_PRIVATE_KEY`) may call
   `payBillFor()` on their behalf — but the *contract itself* checks and decrements the remaining
   allowance on every call, so the cap is enforced on-chain, not by the backend.

| Bound | Enforced by |
|---|---|
| Per-user total exposure | `spendingAllowance[user][token]` — settable only by the user, revocable instantly to 0 |
| Per-transaction ceiling | `maxAgentPaymentPerTx[token]` — owner-set, a second bound on top of the user's own allowance |
| Blast radius of a stolen relayer key | Can spend **at most** a user's remaining allowance, only via `payBillFor` — cannot drain a wallet, raise anyone's allowance, or withdraw the vault |
| Kill switch | Owner calls `setRelayer(address(0))` to instantly disable the agent, or `pause()` to halt all payments |

**⚠️ Not audited.** The contract itself carries this warning in its header. Deploy to testnet for
demos; on mainnet, keep `maxAgentPaymentPerTx` and `maxRefundPerTx` small (`scripts/deployV3.ts`
defaults to a $10-equivalent per token) until a professional audit is done, then raise them via
`setMaxAgentPayment` / `setMaxRefund`.

`payBillFor` emits the same `PaymentReceived` event as V1/V2 (so the webhook needs no changes),
plus an additional `AgentPayment` event so the backend/any observer can distinguish "the user
signed" from "the agent spent an allowance."

#### `AbaPayV4.sol` — adjustable withdrawal delay

V4 is V3 plus one change: the withdrawal timelock is no longer a hardcoded 24 hours. It is a
variable, `withdrawalDelay`, that the owner can raise, lower, or set to **0** via
`setWithdrawalDelay(n)`. It still defaults to 24h, so nothing changes unless the owner
deliberately changes it. V4 is what is deployed on **both mainnets**:

| Chain | AbaPayV4 |
|---|---|
| Base | `0xC0A4dAA04DEd9c54D1239507B5A5E645761ef488` |
| Celo | `0x5df8aE2B963165b735B18Ca86B1ea448d2AA032C` |

⚠️ The **previous Celo contract `0x42Fa4637…` is a V3** — it has no `setWithdrawalDelay`, so its
24h timelock is fixed and it can never be made instant. That is why Celo was redeployed rather
than reconfigured.

The queue itself is not removable — it is compiled into the bytecode and there is no direct
`withdraw()`. At delay 0 a withdrawal is `queueWithdrawal` then `executeWithdrawal` back to
back: two transactions, no waiting.

⚠️ **Changing the delay is not retroactive.** A withdrawal's `executableAt` is stamped when it is
queued, so lowering the delay does not free one that is already sitting in the queue — you have
to `cancelWithdrawal` and re-queue it under the new delay. Cancelling moves no money; the tokens
never leave the vault.

⚠️ **A delay of 0 removes the protection the timelock exists for.** It is the reason a stolen
owner key cannot drain the vault before anyone notices. At 0, whoever holds the key can queue and
execute in the same minute. Treat it as an emergency setting and raise it back afterwards.

```bash
# --chain defaults to base; pass --chain celo for the Celo vault
node scripts/instant-withdrawals.mjs --chain celo                    # show live state, change nothing
node scripts/instant-withdrawals.mjs --chain celo --apply            # delay -> 0, clear a stuck queue entry
node scripts/instant-withdrawals.mjs --apply --withdraw              # …and push the queued one through
node scripts/instant-withdrawals.mjs --chain celo --restore-delay 86400   # put the 24h timelock back
```

#### ERC-8004 Agent Identity

`scripts/register8004.ts` registers AbaPay's DeAI agent as a real on-chain identity on Celo via
the [ERC-8004 "Trustless Agents"](https://eips.ethereum.org/EIPS/eip-8004) registry
(`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` on mainnet), so it's discoverable and browsable on
8004scan.io / AgentScan the same way any on-chain identity is. Registration mints an ERC-721
whose tokenId is the agent's ID, pointing at a public agent card (`public/.well-known/agent.json`)
that names the operational relayer wallet as the agent's on-chain address.

**This is identity only — it does not touch payments.** The relayer's signature-free
`payBillFor` flow above is completely unaffected; registering (or not) has zero effect on how
bills get paid. Before running on mainnet, verify the `register(string)` selector against the
registry's verified source on Celoscan — see the script's header comment.

#### MCP Server (AI Agent Payments)

`src/app/api/mcp/route.ts` implements a real [MCP](https://modelcontextprotocol.io) (Model
Context Protocol) server — the same open standard Claude and other AI agents use to call
tools — over **Streamable HTTP** (JSON-RPC 2.0: `initialize`, `tools/list`, `tools/call`), no
extra dependency required. It's a **fourth channel into the same execution engine** that
already backs Telegram/WhatsApp/X, not a parallel system with its own rules:

| Tool | What it does | Needs |
|---|---|---|
| `describe_capabilities` | Human-readable menu of what AbaPay can pay and what's currently paused | Nothing — public |
| `list_plans` | The **real, currently purchasable** plans for DATA / CABLE / EDUCATION, with exact `variation_code`s and live VTpass prices | Nothing — public |
| `list_international_options` | Browses the live international catalogue (170+ countries) one level at a time — country → product type → operator → priced plan | Nothing — public |
| `check_balance` | Reads the linked wallet's live balance + approved agent limit, **per token**, on a chain | OAuth Bearer token *or* `api_key` |
| `transaction_history` | Lists recent real transactions for the linked wallet — same data as the app's History tab | OAuth Bearer token *or* `api_key` |
| `pay_bill` | Pays a real bill (airtime, data, electricity, cable TV, **education PIN**, or **international airtime/data**) end-to-end, on-chain | (OAuth Bearer token *or* `api_key`) **+ `pin`, always** |

`list_plans` exists because `variation_code` was previously something the agent had to invent.
Its description, and the server-level `instructions`, both tell the client to call it before
`pay_bill` for those three services and to pass back a returned code verbatim — never to guess a
plan, a code, or a price. If it returns nothing usable (which genuinely happens — JAMB is not
enabled on this merchant account), the correct behaviour is to say so, not to fabricate a code.

`pay_bill` covers **EDUCATION** as well as airtime/data/electricity/cable, because MCP is meant
to be the same trust boundary as chat, not a narrower one. Every rule it needs is shared and
already existed: `requiresVariation()` forces a `variation_code`, `checkAccountNumber()` enforces
JAMB's ≥10-character profile ID, and `requiresVerifiedName()` decides that only JAMB
merchant-verifies (WAEC has no account to verify). It also validates the provider against the
**live** VTpass catalogue up front, so an agent can no longer pass a provider VTpass cannot sell
and discover it only after the money has moved.

**`service: "INTERNATIONAL"` completes the purchase, unlike chat.** Chat's INTERNATIONAL handling
(`src/app/api/deai/core/route.ts`) only validates a request and then tells the user to finish it
in the app — it has never actually vended one. MCP's `pay_bill` does: `list_international_options`
walks VTpass's country → product type → operator → variation chain, and `pay_bill` re-fetches the
chosen variation itself to derive the NGN-equivalent price from its own `variation_rate`/
`charged_amount` — never trusting a client-supplied amount, since that number is what prices the
on-chain charge. Only **fixed-price** plans are payable this way for now; flexible-amount plans
still redirect to the app.

**Every successful `pay_bill` now returns a premium receipt, not just a text line.** Alongside the
confirmation text, the response includes a branded receipt card (rendered server-side with
`next/og`'s `ImageResponse` — no extra dependency — see `src/lib/deai/receiptCard.tsx`) and a link
to a shareable, public receipt page at `/receipt/[request_id]` (`src/app/receipt/`). The link is
keyed by `request_id`, not `tx_hash`: a transaction hash is visible to anyone watching the vault
address on-chain, and the receipt page — being public and shareable by design — must not let a
blockchain observer correlate a payment to the customer's verified name/address, so it never shows
the purchased code/PIN either. `transaction_history` gets the same rich treatment — a statement
card image alongside the plain-text list — for browsing past activity without opening the app.

Both accept optional `chain`/`token` overrides — they default to whatever was approved when the
API key was created, but a caller isn't stuck with that default if it comes up short. `check_balance`
returns balance + approved limit for **every** stablecoin on the chain (not just the default one),
so an agent can see upfront whether an alternative is even viable. If `pay_bill` is attempted with
the default and it's short on balance or on-chain allowance, the error itself checks whether
another token on that same chain already has enough of both and says so by name — e.g. *"USD₮ is
short, but USDC already has enough balance and an approved limit — retry with token: 'USDC'"* —
rather than a dead-end message naming only the token that failed.

**Why this exists:** third-party agent scanners like [8004scan.io](https://8004scan.io) only run
a health check against a declared `a2a` or `mcp` service (AbaPay's ERC-8004 card previously only
declared `web` and `x402`, neither of which they probe) — see `public/.well-known/agent.json`'s
`services` array. Building a real, working MCP server was the actual fix, not a stub added just
to satisfy the scanner.

**Same trust model as chat, not a new one.** `pay_bill` doesn't reimplement any security logic —
it calls straight into the functions already backing Telegram/WhatsApp/X and the multi-recipient
batch flow: `checkPinAllowed`/`verifyPin`/`recordPinFailure` (same escalating lockout),
`checkServiceAllowed` (kill switches), `checkAccountNumber`/`checkAmount` (parity validation),
`checkAgentSpendAllowed` (operator per-tx/daily caps), `checkAutonomousCapacity` +
`executeAgentPayment` (on-chain allowance check, the shared discount engine, and vend), and
`notifySpendOutOfBand` (email + every other linked channel is told the instant money moves, so a
leaked API key is caught exactly like a stolen chat session would be).

**Chain-agnostic — Celo or Base, whichever the linking wallet approved.** An MCP key inherits the
`approved_chain`/`approved_token` recorded when it was created (same fields Telegram/WhatsApp/X
already use), and `check_balance` accepts an explicit `chain` override. There is nothing
Celo-specific or Base-specific in the MCP layer itself — it's the same multi-chain relayer
(`src/lib/deai/relayer.ts`) and balance reader (`src/lib/deai/services.ts`) every other channel
shares.

**OAuth 2.1 — authorize once, in a browser, and never retype an API key again.**
The `api_key`/`pin` tool *arguments* work, but a brand-new Claude conversation remembers
nothing, so the human had to paste their API key every single time. The server now implements a
full OAuth 2.1 authorization-code flow with **PKCE (S256 only)** and **Dynamic Client
Registration**:

| Endpoint | Purpose |
|---|---|
| `/.well-known/oauth-protected-resource` (+ `/.well-known/oauth-protected-resource/api/mcp`) | Tells the client this resource is OAuth-protected and where its authorization server is |
| `/.well-known/oauth-authorization-server` (+ `/.well-known/oauth-authorization-server/api/mcp`) | Authorization-server metadata |
| `/api/oauth/register` | Dynamic Client Registration (RFC 7591) — no manual client setup |
| `/api/oauth/authorize` | The consent page — the only page a human ever sees |
| `/api/oauth/token` | Code exchange + refresh, with refresh-token rotation |

Both discovery documents are served at the plain `/.well-known/…` path **and** at the RFC
path-insertion variant with `/api/mcp` appended, because different clients probe different ones.

Things worth knowing about this implementation:
- **The consent page proves *both* the API key and the PIN** before an authorization code is
  ever issued. A stolen API key alone is not enough to authorize a connector.
- **OAuth never authorizes a spend.** The PIN is still required on *every* `pay_bill` call,
  exactly as on Telegram/WhatsApp. A Bearer token on its own can read a balance and nothing more.
- **Exactly one condition returns a real HTTP 401** (with `WWW-Authenticate` +
  `resource_metadata`): *no credential supplied at all*. That 401 is the only signal an MCP
  client uses to discover "this server supports OAuth" and show a connect button. A **wrong**
  API key, a bad PIN, or a malformed argument stay in-band tool errors — turning those into 401s
  would make the client re-run the whole browser flow over a typo.
- **`redirect_uri` is validated against the registered list *before* anything renders**, and a
  failure renders a plain error page rather than redirecting — redirecting to an unvalidated URI
  is precisely the open-redirect vulnerability that would leak the authorization code.
- The consent page is a hand-rendered, fully self-contained HTML string (inline `<style>`, no
  scripts, no fonts, no third-party assets) so it satisfies the app's CSP without exception and
  can't be broken by anything else in the app. It uses AbaPay's own emerald wordmark styling —
  it previously ran an unrelated blue theme.
- Refresh tokens **rotate** on every use (OAuth 2.1's requirement for public clients), so a
  stolen refresh token stops working as soon as the legitimate client refreshes — and the theft
  becomes detectable instead of silent.

**Linking (no new env vars, no new table):** `agent_links.channel` gained an `'MCP'` value
(`supabase/migrations/019_mcp_channel.sql`) alongside `TELEGRAM`/`WHATSAPP`/`X`. Unlike those,
there's no bot to "claim" a link code with — from the app's **Agent Hub** tab, pick the **MCP (AI
Agents)** tile, set a PIN, and it mints a 256-bit API key shown **exactly once** (only its
SHA-256 hash is ever stored). A wallet can hold several MCP keys at once — one per agent/tool —
each with its own label.

**Connecting an AI agent (end users):**
1. In the AbaPay app, approve an on-chain spend limit for whichever chain/token you want the
   agent to use (Agent Hub → step 1) — this is the real ceiling; nothing below can exceed it.
2. Still in Agent Hub, pick **MCP (AI Agents)**, optionally label the key (e.g. "Claude"), set a
   PIN, and save the API key it shows you — it will not be shown again.
3. Point your MCP client at `https://www.abapays.com/api/mcp` as a remote (Streamable HTTP)
   server:
   - **Easiest — claude.ai (web), no file editing:** Settings → Connectors ("Integrations" on
     some accounts) → **Add custom connector** → paste `https://www.abapays.com/api/mcp` → Save.
     It's now available as a tool source in any new chat.
   - **Claude Desktop (local config file)** — merge this into
     `%APPDATA%\Claude\claude_desktop_config.json` (don't overwrite the whole file if you already
     have other servers configured there):
     ```json
     {
       "mcpServers": {
         "abapay": { "url": "https://www.abapays.com/api/mcp" }
       }
     }
     ```
   - **Any other MCP client:** the same URL, Streamable HTTP transport — no API key or auth
     header at the connection level; see step 4.
4. **Authorize.** If your client supports OAuth (claude.ai and Claude Desktop do), it will offer
   a **Connect** button — click it, and AbaPay's own consent page asks for your API key and PIN
   once, in the browser. Every future conversation reconnects automatically. If your client
   can't do OAuth, pass the API key as the `api_key` tool argument instead — it's a tool
   argument, not an HTTP header, so there's no separate app-level auth step.
5. **Your PIN is asked for on every payment either way.** Authorizing the connector does not
   authorize spending. If an agent claims it can pay without your PIN, something is wrong.

Every tool declares `annotations` (`title`, `readOnlyHint`/`destructiveHint`, `idempotentHint`,
`openWorldHint`) — `pay_bill` is correctly flagged destructive/non-idempotent (it moves real
money and calling it twice pays twice), while `describe_capabilities`/`check_balance` are
read-only — so a client can warn a user appropriately before letting an agent invoke it.

**Getting listed in claude.ai's Connectors Directory** (so users can find AbaPay by browsing/
searching instead of pasting the URL) is a separate step from what's built here — it's an
organizational submission through Anthropic, not a code change:
- Requires a Team or Enterprise claude.ai organization (submission happens in
  **admin settings → Directory → New submission**); only Owners (or a delegated role on
  Enterprise) can submit.
- Requirements confirmed against Anthropic's own submission docs: tool `title` +
  `readOnlyHint`/`destructiveHint` annotations (✅ done above), a public documentation URL
  (`https://abapays.com/docs` — live), a privacy policy URL (`https://abapays.com/privacy` —
  live), an icon, and reviewer test-account credentials.
- **OAuth 2.0 — no longer a gap.** The directory requires OAuth for authenticated connectors,
  and that is now built (see the OAuth section above): authorization code + PKCE, Dynamic Client
  Registration, discovery metadata, and a real 401 so clients can discover it. What remains for
  a directory listing is the *organizational* submission itself (a Team/Enterprise org, an icon,
  and reviewer test-account credentials) — not code.
- Until submitted/approved, "Add custom connector" with the URL (above) is a fully working,
  unrestricted way to use it today — the directory only adds discoverability, not capability.

<a id="a2a"></a>

#### A2A Server (Agent2Agent)

The same tools, reachable by *other agents* over [A2A](https://a2a-protocol.org) instead of MCP.
Two files, no new capability:

| Surface | Path |
|---|---|
| Agent Card (discovery) | `/.well-known/agent-card.json` — `src/app/.well-known/agent-card.json/route.ts` |
| JSON-RPC endpoint | `/api/a2a` — `src/app/api/a2a/route.ts` |

**One implementation, two protocols.** The tool definitions and their implementations were moved
out of `src/app/api/mcp/route.ts` into **`src/lib/deai/mcpTools.ts`**, which both routes import.
`/api/mcp` and `/api/a2a` are now transport shims over one `callTool()`. That is deliberate:
A2A has no private path to money — the PIN gate, escalating lockout, on-chain allowance ceiling,
kill switches and operator spend caps all live *below* both routes, so a new protocol changes how
an agent asks, never what it may do. (The move was mechanical; tool logic is byte-identical.)

**⚠️ `/.well-known/agent-card.json` is not `/.well-known/agent.json`.** The latter is AbaPay's
**ERC-8004 registration card** — the on-chain identity 8004scan and Aigora read. The two specs
collided on the `agent.json` filename historically, which is exactly why A2A moved its card to
`agent-card.json`. Different documents, different consumers; overwriting one with the other
silently breaks the agent's on-chain listing.

**No LLM in the invocation path.** Chat channels route free text through `parseIntent()` because a
human typed it. A2A is machine-to-machine, so invocation is a structured `DataPart` carrying
`{ skill, args }`, validated against the same `TOOLS` schema MCP publishes. A text part gets the
skill catalogue back rather than a guess — re-interpreting "send 5000" with a language model in an
agent-to-agent *payment* path adds a failure mode with no upside.

**Synchronous by design.** Every skill completes inside the request, so `message/send` returns a
final `Message` (spec-legal) and no `Task` is created. The card therefore declares
`streaming: false` and `pushNotifications: false`, and `tasks/*` + `message/stream` return
`-32004 UnsupportedOperation` rather than being half-implemented — there is no task store to
query, and declaring capabilities we don't have would strand a peer waiting on updates that never
arrive.

**Auth.** `Authorization: Bearer …` accepts either credential MCP accepts, by prefix: an
`aba_mcp_…` Agent Hub key, or an OAuth 2.1 access token. A2A has no per-call `api_key` argument,
so the header is the only place a credential can arrive. A *missing* credential and a *wrong* one
stay distinct conditions, same rule as MCP. `pay_bill` still requires the PIN on every call.

**Operator control.** `CHANNEL_A2A` in `platform_settings.kill_switches` — separate from
`CHANNEL_MCP` so pausing one surface doesn't pause the other. No migration needed; the column is
free-form JSONB and a missing key reads as enabled.

Call it:

```bash
curl -X POST https://www.abapays.com/api/a2a \
  -H "Authorization: Bearer aba_mcp_…" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{
        "kind":"message","role":"user","messageId":"1",
        "parts":[{"kind":"data","data":{"skill":"check_balance","args":{}}}]}}}'
```

#### x402 Settlement (main app only)

⚠️ On by default; `NEXT_PUBLIC_X402_ENABLED=false` falls back to the contract call. Note the
wallet-warning trade-off documented in the env section above — the EIP-3009 signature x402
requires is structurally what a drainer asks for, so some scanners flag it.

The web app's payment flow settles via [x402](https://x402.org) — through **Celo's own
facilitator** (`api.x402.celo.org`, built by Celo Core Co. — see
`src/app/api/pay/x402/route.ts`), not thirdweb — whenever the user is paying with **USDC or
USD₮ on Celo**. Each token settles against its own EIP-712 domain (`X402_TOKEN_EIP712` in that
route) since Circle's USDC and Tether's USD₮ deployments don't share one. The same "Confirm &
Pay" button routes through x402 for either token on Celo and through the normal `payBill`
contract call for everything else (cUSD/USDm, Base when `NEXT_PUBLIC_BASE_X402_ENABLED=false`,
or x402 unconfigured). This makes the payment genuinely visible on x402scan — not a
relabeled transaction — because x402 settlement requires an EIP-3009
(`transferWithAuthorization`) signature from the payer for that specific payment. That
requirement is also precisely why the scanners object.

The **402 challenge itself is built in-house** (a plain x402 v1, body-based response) rather
than relying on any SDK's default — that's a deliberate choice, since thirdweb's own
`settlePayment()` always delivers a fresh challenge via a base64 header with an empty JSON
body, which generic x402 scanners (x402scan's discovery crawler included) don't parse,
causing registration to silently fail with a correct-looking 402 status but no usable
challenge.

Client-side, the challenge is read, signed and retried by `src/lib/x402Pay.ts` using the same
viem wallet client every contract call uses. It previously went through `thirdweb`'s
`useFetchWithPayment`, which meant a second wallet connection alongside the wagmi one — over
WalletConnect that second stack announced itself as an extra connection prompt in the middle of
a payment, so one bill could cost four approvals. Signing in-house also lets the page read the
server's actual answer: a settlement failure that carries a `tx_hash` means the money already
moved, and the app must never "retry" it on the contract-call rail.

#### A refused settlement is retried before the rail is abandoned

🔴 **The bug: "it fails, I cancel and retry the same x402, and then it goes through."** Reported
on Base, with the facilitator answering `unable to estimate gas` / `invalid_payload` — a
`transferWithAuthorization` simulation that reverted, carrying no transaction, so nothing moved.
The app's answer was to declare the rail dead and fall back, which costs **two** more prompts
(approve + payBill) for a bill the fast rail settles on a second attempt costing **one**. Users
were doing that second attempt by hand; now it happens on its own, at three levels:

1. **Before the facilitator is called at all.** `src/lib/x402Settle.ts` decides the EIP-3009
   revert conditions that are visible in the payload — an expired validity window, a
   clock-skewed `validAfter`, a wrong recipient, an amount that disagrees with what the server
   is about to declare as required — so a payload that *cannot* settle is answered with a fresh
   challenge instead of an opaque revert. The signed `value`, not the recomputed price, is what
   `paymentRequirements` declares and what the DB row and any refund record: the two can differ
   by an exchange-rate tick, and a facilitator handed a mismatched pair refuses.
2. **Server-side, once, on the same authorization.** Safe by construction — an EIP-3009 nonce is
   single-use, so the token accepts it at most once however many times it is submitted. A retry
   can duplicate a request but never a transfer.
3. **Client-side, once, on a fresh signature** — only when the server marked the refusal
   `retryable`, and never when it carries a `tx_hash`. The second prompt is announced, because an
   unexplained one reads as an app that ignored the first.

🔴 **No retry is offered until the CHAIN says the money did not move.** This is the important
one, and it was learned the expensive way — from on-chain receipts, not from reasoning:

```
09:21:31   1.4925 USDC   payer -> vault   0xe1f5043a…   ← paid
09:23:51   1.4925 USDC   payer -> vault   0x19aec564…   ← paid AGAIN, 140s later, same bill
```

Both are real `transferWithAuthorization` calls that succeeded. The facilitator's answer for the
second attempt was the same `unable to estimate gas` / `invalid_payload` as ever — because
EIP-3009 nonces are single-use, so **re-simulating an authorization that already succeeded
necessarily reverts**, and a revert during estimation is reported exactly that way. The sentence
is therefore ambiguous *by construction*: a facilitator says it both when nothing has happened
yet and when everything has already happened. Read as the former, it asked the payer to sign a
fresh nonce, which the token correctly accepted — a second real payment for one bill.

No amount of message-matching separates those two cases, so the code stops trying. Every
EIP-3009 token exposes `authorizationState(authorizer, nonce) -> bool`, the chain's own record
of whether that exact authorization was consumed, and it is asked before any retry is offered
(`buildAuthorizationStateCall`, and `authorizationWasConsumed` in the settle route). Spent means
the payment is reported as **settled with no transaction hash** — the client stops, the
contract-call fallback is suppressed, and an operator alert carries the payer and nonce for
manual reconciliation. An unreadable answer is treated the same as spent: a needless fallback
costs two prompts, a wrongly-offered retry costs the payer real money.

Wording is still used as a *cheap first filter* — `FiatTokenV2: authorization is used or
canceled` is refused outright, while `nonce too low` and `replacement transaction underpriced`
(the *facilitator's own* EOA racing itself, a different nonce entirely) stay retryable — but the
chain, not the filter, is what actually authorises a retry.

**Which rail a payment takes also depends on the wallet, not just the token.** x402 settles on
an `eth_signTypedData_v4` signature that has to come *back* to the page, and a WalletConnect
session that never negotiated that method drops the request on the floor — no prompt, no error,
nothing back. Only that is checked, from the session itself: see `walletCanSignTypedData` in
`src/lib/walletEnv.ts`.

🔴 **It no longer routes by wallet NAME.** An earlier version answered `false` for Valora
outright, on the strength of Valora rendering the request as "Verify wallet" and reporting a
successful *connection* without returning a signature. Naming one wallet turned a *maybe* into a
permanent *no*: Valora lost the x402 rail on **both** Celo and Base and could never earn it back,
because a wallet routed off a rail can never demonstrate it works on one. Every wallet is now
asked, and its own answer decides. When the answer never comes, the signature times out, nothing
has been sent to settle (`src/lib/x402Pay.ts` posts the settle request itself, on the line after
the signature is awaited, so unwinding it means a late signature reaches nobody) and the page
falls back to the contract call on its own. That fallback is what made it safe to stop guessing.

That signature requirement is exactly why this is **scoped to the main app only**: the
agent-initiated flow above depends on paying with *zero* signature at payment time (the whole
point of `setSpendingAllowance`), which is fundamentally incompatible with x402's
per-payment-signature model. Telegram/WhatsApp/X and the autonomous scheduler never use x402 and
are unaffected — those payments already execute from `RELAYER_ADDRESS`, the same wallet
registered under the ERC-8004 identity below, so they're already attributable to the agent
without needing x402.

- **Scope: Celo + USDC/USD₮, confirmed live** — not just a caution. Native Celo USDC (Circle's
  FiatTokenV2) and native Celo USD₮ (Tether's deployment) both implement EIP-3009
  `transferWithAuthorization`; cUSD/USDm doesn't, so there's no signature scheme to settle it
  with. Not a self-imposed limit — if support is added for another token later, no code change
  is needed beyond adding its EIP-712 domain, since the token/decimals are already resolved
  generically via `resolveTokenOnChain`.
- **Prepaid credits, not a billing subscription.** Celo's facilitator charges a flat
  $0.001/settlement from a prepaid USDC credit balance (`CELO_X402_API_KEY`) — top up at
  x402.celo.org. At 0 credits, `/settle` starts returning 402 and the app sends a Telegram
  alert (this is an operator problem, not a payer one — retrying won't help until topped up).
- **No automatic fallback to the contract-call flow on x402 failure.** If x402 errors after
  reaching the server, retrying via the contract-call path could double-charge the user if the
  facilitator's settlement actually landed but the response was lost in transit — the same class
  of risk `processBlockchainPayment`'s own paymaster-fallback logic is careful about. The user
  sees a clear error and can retry manually instead.
- **Funds land in the same vault.** `payTo` is set to the existing `AbaPayV3` contract address —
  the same one the admin dashboard already reads balances from and manages refunds/withdrawals
  for. The vault's `balanceOf` doesn't care how tokens arrived, so x402-settled funds are
  indistinguishable from contract-call funds to all existing admin tooling. No contract changes.
- **Vend/refund logic is shared, not duplicated.** Both the on-chain path (`/api/pay`) and the
  x402 path (`/api/pay/x402`) call the same `executeVend()` (`src/lib/vend.ts`) once payment is
  verified — so the automatic refund safety net applies identically to both rails.
- `transactions.payment_method` (`010_x402_payment_method.sql`) distinguishes `CONTRACT` from
  `X402` at a glance, alongside the existing `source_channel` (a different axis — UI channel vs.
  settlement rail).

---

## 🔌 Provider Data & Operator Controls

#### Live provider catalogue (VTpass-sourced)

`src/lib/vtpassCatalog.ts` is the single source of truth for every provider list in the app.
It calls VTpass's `/services?identifier=…` and returns the provider's real `serviceID`, VTpass's
own product **name**, VTpass's own **logo URL**, and its published **`minimium_amount`** (sic)
and **`maximum_amount`**.

Five categories are supported, keyed by the identifiers VTpass actually accepts (two of which
had to be discovered — the obvious guesses return `011 "Category Does not Exist"`):

| App concept | VTpass identifier |
|---|---|
| Airtime | `airtime` (with `foreign-airtime` filtered out — international is its own flow) |
| Data / Internet | `data` — **not** `mobile-data`/`internet` |
| Electricity | `electricity-bill` |
| Cable TV | `tv-subscription` — **not** `cable-tv` |
| Education | `education` |

**Caching and failure behaviour (this is the important part):**
- A module-level `Map` cache with a **1-hour TTL**, shared in-process. The browser reaches it
  through `GET /api/providers?category=…` (rate-limited 60/min per IP, `Cache-Control:
  public, max-age=300, s-maxage=3600, stale-while-revalidate=86400`); chat and MCP call
  `getCatalog()` directly. Both land on the same cache, so there is exactly one source of truth.
- **The cache is never evicted on failure — only overwritten on success.** The fallback chain is
  *fresh cache → live fetch → stale cache → bundled seed*, and `getCatalog()` **never throws and
  never returns an empty list**, so a picker can be rendered unconditionally and a VTpass blip
  can't blank it mid-purchase.
- A stale answer is returned with `stale: true`, and `/api/providers` then serves it `no-store`
  so a brief outage can't get frozen into an edge cache for an hour.
- `src/lib/providerFallback.ts` is the last-resort offline seed — **the only hardcoded provider
  data left**. Its logos are deliberately *local* files, because the one code path that exists
  for "VTpass is unreachable" must not render a dozen broken remote images.

**Why this replaced the hardcoded lists:** the old lists advertised `showmax`, `spectranet` and
`jamb` — all three return `Service is Not Valid` on this merchant account, so a user could pick
one, fill the form, pay on-chain, and only then have the vend fail into the refund path. They
also *omitted* `glo-sme-data` and `9mobile-sme-data`, which are live and were unreachable.

**Amount limits** come from the same records: `limitsFor(category, serviceID)` and
`limitsForIntent(intent, provider)` return the live per-provider `{min, max}`, and `null` when
VTpass publishes none — so "unknown" falls back to the caller's service-level default rather
than being mistaken for "unlimited".

#### Kill switches (two-level: master + per-provider)

`platform_settings.kill_switches` holds a **two-level** key system written by the admin
dashboard:

| Level | Keys |
|---|---|
| Per-service master | `MASTER_AIRTIME`, `MASTER_INTERNET`, `MASTER_ELECTRICITY`, `MASTER_CABLE`, `MASTER_EDUCATION`, `MASTER_INTERNATIONAL` |
| Per-provider (keyed by VTpass serviceID) | `AIRTIME_mtn`, `INTERNET_airtel-data`, `ELEC_ikeja-electric`, `CABLE_dstv`, `EDU_waec`, … |

A switch is **on unless explicitly `false`** (a missing key means enabled), and a payment is
refused when **either** level is off — the same `||` the web app uses.

`killSwitchKeysFor(intent, provider)` in `src/lib/serviceRules.ts` maps an agent intent onto
exactly those keys, normalising the provider through `resolveServiceId` first so a loose
`"ikeja"` from chat resolves to the `ELEC_ikeja-electric` key the operator actually toggled.
`checkServiceAllowed()` is then the gate every non-web channel must pass. Settings are cached
for **30 seconds**, so flipping a switch takes effect within half a minute everywhere.

> 🔴 **The bug this fixed:** these functions previously returned a single *bare* key
> (`AIRTIME`, `ELECTRICITY`, …) that nothing has written since the `MASTER_`/per-provider system
> replaced it. So "pause Electricity" in the dashboard flipped `MASTER_ELECTRICITY`, the website
> correctly refused — and chat, MCP and the autonomous scheduler carried on spending real user
> funds on a service the operator had deliberately switched off.

Separate from the per-service switches, `checkAgentSpendAllowed()` enforces the operator's
controls over the *agent* specifically: `agent_enabled` (master kill for all agent payments),
`agent_autonomous_enabled` (kills only unattended/scheduled execution), `agent_max_ngn_per_tx`,
`agent_daily_cap_ngn` (per user, per UTC day), and `ai_chat_enabled` for the in-app widget.
These sit **on top of** the on-chain allowance, never instead of it.

Bank Transfer has a standalone dashboard toggle (`BANK` key — no per-provider breakdown, since
it settles through Monnify/Moniepoint rather than a picker of VTpass providers), checked by
both the agent gate (`BANK_TRANSFER` in `serviceRules.ts`) and the web app's
`isCurrentServiceDisabled` in `page.tsx`.

Four more standalone switches pause an entire **channel** rather than a product —
`CHANNEL_WHATSAPP`, `CHANNEL_TELEGRAM`, `CHANNEL_X`, `CHANNEL_MCP` — enforced by
`isChannelEnabled()` in `serviceRules.ts`. WhatsApp/Telegram/X are checked once at the top of
the shared `/api/deai/core` engine (all three route through it); MCP is checked at
`tools/call` in `/api/mcp`. Same "missing key = enabled" default as every other switch here.

---

## 🧪 Testing & CI

```
npm test              # Run the unit test suite (Vitest)
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report
npm run typecheck     # tsc --noEmit — catches type errors before they hit a deploy
```

Tests currently cover the security-critical pure logic: PIN hashing/verification, internal
service auth, and the payment amount/token verification invariants (the checks that stand
between a user and an unpaid bill).

**CI** runs on every push/PR via `.github/workflows/ci.yml`: typecheck → lint → build → tests →
dependency audit. The typecheck step exists specifically to catch TypeScript errors *before*
they reach a production deploy.

---

## 🗄️ Database Setup

Beyond the core tables, run the migrations in `supabase/migrations/` **in order** in the Supabase SQL editor:

* `001_rate_limits.sql` — creates the `rate_limits` table required by `src/lib/rateLimit.ts`.
  **Rate limiting silently fails open without this table**, so apply it before relying on the
  throttles protecting your billable VTpass / WhatsApp / Claude endpoints.
* `002_customer_details.sql` — customer details captured on receipts.
* `003_scheduled_bills.sql` — Bill Pay & Autopay Agent scheduling.
* `004_agent_links.sql` — links a wallet to a Telegram/WhatsApp/X identity so the DeAI agent
  can recognise a user. **The security boundary is the on-chain `spendingAllowance` in
  AbaPayV3, not this table** — it's a UX mirror only.
* `005_autonomous_schedules.sql` — upgrades scheduled bills for true unattended execution,
  safe specifically because AbaPayV3's on-chain allowance bounds worst-case exposure.
* `006_agent_admin_controls.sql` — operator kill switches for the agent (`agent_enabled`,
  `agent_autonomous_enabled`, `ai_chat_enabled`, per-tx/daily NGN caps), settable from the
  admin dashboard's Agent tab without a redeploy or contract call.
* `007_transaction_source_channel.sql` — records which channel (web app / Telegram / WhatsApp /
  X / an unattended schedule) originated each transaction, for operator alerting.
* `008_refund_queue.sql` — queued refund pipeline for vends that fail after payment is taken.
* `009_support_tickets.sql` — support tickets from the web app and every social channel, with
  admin replies routed back to the user's original chat.
* `010_x402_payment_method.sql` — adds `payment_method` (`CONTRACT` | `X402`) to `transactions`,
  distinguishing the settlement rail (see [x402 settlement](#x402-settlement-main-app-only)).
* `011_one_off_schedules.sql` — adds `run_once_at` and `batch_id` to `scheduled_bills`, so a
  single chat request can create a one-time future payment (`frequency = 'once'`) or a
  multi-recipient batch, on top of the existing recurring monthly/weekly/daily schedules.
* `012_schedule_notify_channel.sql` — records which channel a schedule should report back on.
* `014`–`018_discount_*.sql` — the discount-campaign engine: campaigns, per-campaign caps,
  destination/IP caps, per-phone caps + a fraud toggle, and exclusions/full-status counting.
  (There is no `013`; numbering skips it.)
* `019_mcp_channel.sql` — adds `'MCP'` to `agent_links.channel` alongside
  `TELEGRAM`/`WHATSAPP`/`X`, so an AI agent is a first-class linked channel.
* `020_mcp_oauth.sql` — the OAuth 2.1 tables: dynamically registered clients, single-use
  authorization codes (with their PKCE challenge), and access/refresh token records (hashed,
  with rotation and revocation).

---

## 📱 Testing with MiniPay

AbaPay is highly optimized for mobile Web3 experiences. To test the dApp within the Celo MiniPay environment:
1. Deploy the project (e.g. to Vercel).
2. Set `NEXT_PUBLIC_NETWORK` to `celo-sepolia` (testnet) or `celo` (mainnet), and `NEXT_PUBLIC_APP_MODE` to `sandbox` or `production` accordingly.
3. Open the Opera Mini browser on Android, navigate to the MiniPay tab, and enter your deployed URL.

### Testing as a Farcaster Mini App

The app ships with Farcaster frame metadata (`public/.well-known/farcaster.json` and frame config in `layout.tsx`). Deploy to a public URL, then share the link in a Farcaster client that supports Mini Apps to launch it directly.

---

## 🛡️ Security Architecture

* **No-Log Keys:** VTpass secret keys, Supabase service role key, Telegram tokens, and all other secrets are strictly contained within server-side API routes — never exposed to the client bundle.
* **Replay Protection:** Every blockchain transaction hash is recorded and checked against a **persistent ledger** (a Supabase table with a unique constraint on the tx hash) before a utility vend is triggered. ⚠️ In-memory tracking alone is **not safe** in serverless environments: state resets on cold starts and isn't shared across concurrent instances, which would allow the same transaction hash to be replayed for multiple vends.
* **On-Chain Verification:** Every payment is independently verified against the blockchain (transaction receipt, contract address, and amount) server-side before any bill is vended — the client-submitted payload is never trusted blindly. Under Base gas sponsorship, the top-level transaction's `to` can be a bundler/EntryPoint contract rather than the AbaPay contract itself, so the webhook additionally decodes the transaction's logs and requires that the AbaPay contract genuinely emitted `PaymentReceived` — this holds regardless of how deeply nested the call was.
* **Event Cross-Validation:** The webhook decodes the `PaymentReceived` event and requires that its **payer, token, amount, and account number all match the pending record** before vending. This blocks the class of attack where a user has a small pending intent and then manually sends a different (or larger/smaller) transfer to the contract hoping it gets attached to the wrong record.
* **Stale Intent Expiry:** Pre-flight intents (records created before signing) that never result in an on-chain transaction are automatically expired by a scheduled cleanup (`/api/cleanup`, every 15 min) so they don't linger as `PENDING` forever. This only ever touches `preflight_`-prefixed rows, so a real broadcast transaction can never be expired.
* **Webhook Acknowledgment:** The webhook always returns 2xx once a request passes signature verification, even when no matching transaction record is found (test pings, unrelated activity, or a payment intent that hasn't synced yet are normal, expected outcomes — not delivery failures). Returning a non-2xx here would cause Alchemy to eventually auto-disable the webhook after repeated "failures" that were never really failures.
* **VTpass Delayed-Status Webhook:** `/api/webhook/vtpass` replies `{"response": "success"}` immediately — the exact acknowledgement VTpass parses for — and only then does the real work (via `after()`), because VTpass requires a prompt, lightweight reply and retries anything else as an unacknowledged delivery. The push itself is never trusted: the handler re-queries VTpass server-to-server with our API keys and acts only on that confirmed status.
* **Rate Verification:** The crypto amount paid is checked server-side against the platform's live exchange rate before vending, preventing underpayment exploits even if the client is tampered with.
* **Smart Contract Vault:** User stablecoins go directly into the immutable `AbaPay.sol` smart contract vault. Only the contract owner's cryptographically signed transaction can withdraw funds — no backend service ever holds custody of user funds directly.
* **Automatic Refunds:** If a verified on-chain payment fails to vend (provider outage, invalid details, etc.), the transaction is flagged and refunded back to the user's wallet, with the refund transaction hash recorded on the ledger.
* **Refund Verification:** `/api/admin/refund` verifies the refund on-chain (token, recipient, and amount all decoded from the transaction's ERC-20 Transfer logs) before marking a transaction `REFUNDED` — an admin cannot record a refund that never actually happened.
* **RPC Failover:** On-chain reads use viem's `fallback()` transport across multiple RPC endpoints (`src/lib/chain.ts`), so a single downed provider doesn't halt payment verification.
* **Content-Security-Policy:** Shipped in `Content-Security-Policy-Report-Only` mode (`next.config.ts`) — surfaces violations without risking breakage to wallet connections. Promote to enforcing (`Content-Security-Policy`) once verified against real wallet flows.
* **Admin Auth:** Admin-only API routes and the `/admin` dashboard are gated behind dedicated authentication (`src/utils/adminAuth.ts`), separate from the public storefront. Auth is a wallet-signature challenge verified against the contract owner, with a 12-hour session expiry and timestamp replay protection.
* **Internal-Only AI Routes:** The DeAI "brain" (`/api/deai/*`) is reachable only by the app's own bot webhooks via a signed internal-service token (`src/utils/internalAuth.ts`). This prevents the public internet from impersonating any user by their chat ID / phone number / X ID, or burning the Claude API budget.
* **Bot Webhook Signatures:** The WhatsApp and X webhooks verify Meta's `X-Hub-Signature-256` / X's `x-twitter-webhooks-signature` HMAC on every inbound payload (when the corresponding secret is configured), and Telegram verifies its secret token — so message events can't be forged.
* **Hashed Transaction PINs:** DeAI PINs are stored as salted scrypt hashes (`src/utils/pinSecurity.ts`), never plaintext, with legacy plaintext values transparently upgraded on next use and a 4-attempt lockout.
* **Scoped Paymaster Proxy:** The gas-sponsorship proxy (`/api/paymaster`) allowlists only ERC-7677 paymaster JSON-RPC methods, so it can't be abused as a general-purpose RPC relay running on your CDP key.

---

## 📖 User-Facing Documentation Surfaces

Four surfaces tell users what AbaPay does. They are **not** generated from anything — they go
stale silently unless deliberately updated, so treat them as part of the change, not as an
afterthought:

| Surface | Where | Reached from |
|---|---|---|
| Docs & FAQ page | `src/app/docs/page.tsx` | "Docs & FAQ" link in `AppFooter` |
| Terms of Service (full) | `src/app/terms/page.tsx` | "Terms" link in `AppFooter` |
| Privacy Policy (full) | `src/app/privacy/page.tsx` | "Privacy" link in `AppFooter` |
| This README | `README.md` | GitHub |

⚠️ `/terms` and `/privacy` are **written by engineers, not lawyers**, and have not had legal
review. Neither should be treated as legally vetted until a qualified lawyer has reviewed
them; `/terms` carries a visible notice at the bottom saying exactly that, and it must survive
any rewrite of the page.

There is no longer a separate in-app Terms/Privacy/FAQ modal. Those components existed in
`src/components/Modals.tsx`, but `TermsModal`/`PrivacyModal` were imported and never rendered,
and the FAQ was a footer button duplicating (and drifting from) the `/docs` FAQ. All three are
gone; `/docs` is the single docs + FAQ surface.

---

## 🏢 Legal Entity

AbaPay is operated by **Masonode Technologies Limited**, a company registered with the Corporate Affairs Commission (CAC) of the Federal Republic of Nigeria under **RC 9524980**.

---

## 👨‍💻 Maintainer

Built and maintained by **Oluwafemi Olagoke** ([@investorphem](https://github.com/investorphem)).

*Focusing on Web3, Decentralized AI, and scalable blockchain applications.*
