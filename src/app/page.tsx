"use client";

import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import sdk from "@farcaster/miniapp-sdk";
import { createWalletClient, createPublicClient, custom, http, parseUnits, formatUnits, encodeFunctionData, type WalletClient, type Chain } from "viem";
import { eip5792Actions } from "viem/experimental";
import { celo, celoSepolia, base, baseSepolia } from "viem/chains";
import Link from "next/link";
import {
  ShieldCheck, Zap, AlertTriangle, CheckCircle2, ChevronDown,
  Loader2, Coins, Briefcase, ListPlus, Users, Landmark, XCircle,
  RefreshCw, Tv, GraduationCap, Send, Globe, Sparkles, LogOut, Check
} from "lucide-react";
import { supabase } from "@/utils/supabase";
import { walletSessionMessage, WALLET_SESSION_MAX_AGE_MS } from "@/lib/walletSession";
import { celoAttributionSuffix } from "@/lib/attribution";
import { useProviders, useValidSelection, useProviderLimits } from "@/lib/useProviders";
import { useAccount, useConnect, useDisconnect, useWalletClient, useSwitchChain } from 'wagmi';
import { payWithX402, X402PaymentError } from "@/lib/x402Pay";

import { ReceiptModal, SelectionModal } from "@/components/Modals";
import PointsBadge from "@/components/PointsBadge"; 
import DataVariationsUI from "@/components/DataVariationsUI"; 
import AppFooter from "@/components/AppFooter"; 
import { AgentHub } from "@/components/AgentHub";
import { AIChat } from "@/components/AIChat";
import {
  probeInjectedConnectors,
  isUserRejection,
  isValoraBrowser,
  isBaseAppBrowser,
  connectedWalletIsValora,
  walletApprovedChainIds,
  walletConnectSessionLive,
  walletCanSignTypedData,
  walletApprovedMethods,
  walletRouteFor,
  routeIsRemote,
  type InjectedProbe,
  type InjectedCandidate,
  withConnectTimeout,
  waitForRelayHandshake,
  describeConnectFailure,
  ConnectTimeoutError,
  RelayUnreachableError,
  INJECTED_CONNECT_TIMEOUT_MS,
  RELAY_HANDSHAKE_TIMEOUT_MS,
} from "@/lib/walletEnv";
import {
  ABAPAY_ABI, ERC20_ABI, SERVICES,
  SUPPORTED_TOKENS, SUPPORTED_COUNTRIES, PRE_SELECT_AMOUNTS,
  ELEC_PRE_SELECT_AMOUNTS, ITEMS_PER_PAGE, extractVtpassArray,
  DEFAULT_CHAIN, normalizeChainName, tokensForChain, defaultTokenForChain
} from "@/constants";
import { HistoryTab } from "@/components/HistoryTab";
import AppTour, { hasSeenTour, type TourTab } from "@/components/AppTour";

// 🔴 THE BUG THIS FIXES: a wallet interaction (approve/payBill/sendCalls/allowance calls) that
// never actually prompts — a locked extension, a dead WalletConnect session, a mobile wallet
// that failed to deep-link back — spun the "Please approve..." status indefinitely, with no
// way for the user to tell "still waiting on you" apart from "something is actually broken".
// Wrapping every wallet-signature call in a bounded timeout turns silence into a clear message.
// 90s is generous for a human to actually review and approve, not for a wallet that never woke up.
// ⚡ THE BUG THIS FIXES: AbortSignal.timeout() (used for every fetch timeout in this file) is
// a relatively recent Web API — unsupported in older mobile WebViews / in-app browsers (some
// Android Telegram/WhatsApp in-app browsers, older embedded Chromium builds). Calling it in an
// environment that lacks it throws SYNCHRONOUSLY, before fetch() is ever invoked — the request
// never leaves the browser, but the surrounding try/catch still catches the throw and shows a
// normal-looking error toast, making this indistinguishable from a real network failure. This
// manual AbortController + setTimeout equivalent works in every browser that supports fetch at
// all (which every browser here already requires), removing that whole class of silent failure.
function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

// A distinct type, because "the wallet never answered" needs different handling from "the
// wallet said no". Timing out does NOT cancel the underlying request: the wallet may still be
// holding a signature prompt that the user can approve a moment later. Anything that reacts to
// a failure by starting a SECOND payment has to be able to tell the two apart — see the x402
// catch block, where getting this wrong would mean paying twice.
class WalletTimeoutError extends Error {
  constructor() {
    super("Your wallet didn't respond in time. Check that it's unlocked and connected, then try again.");
    this.name = 'WalletTimeoutError';
  }
}

function withWalletTimeout<T>(promise: Promise<T>, ms = 90_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new WalletTimeoutError()), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

/**
 * The Celo tokens that can settle on x402 — i.e. the ones that implement EIP-3009
 * `transferWithAuthorization` and whose EIP-712 domain is registered in the settle route's
 * X402_DOMAINS_BY_CHAIN.
 *
 * 🔴 ONE LIST, BECAUSE TWO DRIFTED. This existed twice — once at the pay button's rail decision
 * and once as a guard inside processX402Payment. Adding USA₮ to the first and not the second
 * routed Celo USA₮ payments to x402 and had x402 itself refuse them with "This token isn't
 * supported on this network yet.", on a token whose domain was verified on-chain and whose vault
 * support was already configured. Both now read this.
 *
 * USDm is deliberately absent: Mento tokens expose only EIP-2612 permit(), so there is no
 * signature scheme the "exact" scheme could settle.
 */
const CELO_X402_TOKENS = ['USDC', 'USD₮', 'USA₮'];

export default function Home() {
  const { address: wagmiAddress, isConnected: isWagmiConnected, chain: wagmiChain, connector: wagmiConnector } = useAccount();
  const { connectors, connect, connectAsync, status: connectStatus } = useConnect();
  const autoConnectTried = useRef(false);
  // Did the USER ask for this connection, or did wagmi restore one on mount? Only the restored
  // kind is dropped for Valora — see the effect that enforces "no auto-connect in Valora".
  const userInitiatedConnect = useRef(false);
  const valoraAutoConnectChecked = useRef(false);
  // Asked once per session. A wallet on an unsupported chain gets one switch request, never a
  // loop — declining must leave the app usable, not re-prompt on every render.
  const chainSwitchAsked = useRef(false);
  // Surfaces WHY a connect attempt failed. Previously every failure was silent.
  const [connectError, setConnectError] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  // What the browser's injected wallet actually is — see the silent probe effect below.
  const [injectedProbe, setInjectedProbe] = useState<InjectedProbe | null>(null);
  // Every injected wallet wagmi discovered (EIP-6963 included), each with what it answered
  // when asked about this site. Drives auto-connect and the Connect button's routing.
  const [injectedCandidates, setInjectedCandidates] = useState<InjectedCandidate[]>([]);
  // Open only while the user is picking between multiple installed wallets. `resolve` is the
  // waiting handleConnectClick — calling it with a candidate continues the connect, calling
  // it with null cancels cleanly (no error banner, no WalletConnect fallback).
  const [walletChoice, setWalletChoice] = useState<
    { options: InjectedCandidate[]; resolve: (c: InjectedCandidate | null) => void } | null
  >(null);

  /**
   * Present the installed wallets and wait for the user to pick one.
   *
   * Promise-based rather than a callback chain so handleConnectClick reads top to bottom and
   * keeps ONE error/timeout path for every route into a connection — the chooser is a pause in
   * that flow, not a second flow.
   */
  const askWhichWallet = useCallback(
    (options: InjectedCandidate[]) =>
      new Promise<InjectedCandidate | null>((resolve) => {
        setWalletChoice({
          options,
          resolve: (choice) => { setWalletChoice(null); resolve(choice); },
        });
      }),
    [],
  );
  const { disconnect } = useDisconnect();
  // ⚡ ADD THIS: Grabs the live WalletConnect provider securely
  const { data: wagmiWalletClient } = useWalletClient();
  const { switchChain } = useSwitchChain(); // ⚡ used by the DeAI deep-link handler to land on the right chain

  const [environment, setEnvironment] = useState<'MINIPAY' | 'FARCASTER' | 'WEB' | 'LOADING' | 'BASE'>('LOADING');

  // 🔴 MINIPAY HAD ITS OWN, UNGATED PATH TO `address`/`client`.
  //
  // The proof-before-publish rule only wrapped the WEB bridge. MiniPay's branch in the
  // environment detector called setAddress/setClient DIRECTLY — so the account and balance were
  // live before any ownership signature, exactly the "connect, then verify" ordering the WEB
  // fix was built to close. Declining the signature did nothing because there was nothing left
  // to take away: the app was already usable.
  //
  // Held here instead, and published through the SAME gated bridge pattern WEB uses, so
  // "nothing is shown until the signature succeeds" is one rule instead of two.
  const [minipayPending, setMinipayPending] = useState<{ address: string; client: any } | null>(null);

  // ⚡ THE NETWORK BADGE IS A MENU, NOT A TOGGLE.
  //
  // 🔴 IT USED TO ROTATE THE CHAIN ON EVERY CLICK, which meant the only way to reach Celo from
  // Base was to fire a real `wallet_switchEthereumChain` prompt and hope you had guessed right —
  // and with two chains a mis-tap could only be undone by doing it again. It is now a menu that
  // shows what is available and switches only once something is actually chosen.
  //
  // It is also where Disconnect lives. There was no way to disconnect at all before: the app
  // called wagmi's disconnect() on error paths, but nothing in the UI offered it, so a user who
  // wanted to change wallet had no way to say so. This is the one control that already
  // represents "the wallet you are connected as", which makes it the honest place for it.
  const [chainMenuOpen, setChainMenuOpen] = useState(false);
  const chainMenuRef = useRef<HTMLDivElement | null>(null);


  // Close on an outside click or Escape — a menu that can only be dismissed by choosing
  // something is a trap, and this one has a destructive item in it.
  useEffect(() => {
    if (!chainMenuOpen) return;
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      if (chainMenuRef.current && !chainMenuRef.current.contains(e.target as Node)) setChainMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setChainMenuOpen(false); };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [chainMenuOpen]);

  /**
   * WHICH ROUTE the live wallet is on — read from the connector, not guessed from the page.
   *
   * It changes what the user physically has to do to approve, and therefore what we should tell
   * them. An injected wallet raises its own window right here; a WalletConnect wallet (Valora,
   * Trust, Rainbow on a phone) gets a request over the relay with nothing to bring it to the
   * foreground — the user has to switch to it themselves, and if we don't say so they will sit
   * watching a spinner. MiniPay, Farcaster and Base App bypass wagmi and inject directly, so
   * they are in-page too, and each is named rather than lumped under "your wallet".
   *
   * 🔴 THE OLD TEST WAS `environment !== 'WEB' || connector.type === 'injected'`, i.e. "an
   * in-app browser means an in-page wallet". That is not true of the wallet this matters most
   * for: Valora browses to AbaPay in its own webview and then reaches it over the WalletConnect
   * RELAY, so the host said "in-browser" while the request was actually going to a separate app.
   * Every message derived from it then told the user the opposite of what to do.
   */
  const walletRoute = useMemo(
    () => walletRouteFor(wagmiConnector, environment),
    [wagmiConnector, environment],
  );

  /** Is the wallet a separate app the user has to switch to? Drives every prompt below. */
  const isRemoteWallet = useMemo(() => routeIsRemote(walletRoute), [walletRoute]);
  const isInjectedWallet = !isRemoteWallet;

  /**
   * "Please sign the final payment" → tells the user WHERE to go and do it, per route.
   *
   * "…in your wallet" is only actionable when the wallet is in this browser. Over
   * WalletConnect the request lands in a separate app that nothing brings to the foreground,
   * so the honest instruction is "switch to it" — which is precisely what was missing while a
   * Valora user watched a spinner waiting for a prompt that was already sitting in Valora.
   *
   * The in-page hosts get their own names rather than a generic "your wallet": in MiniPay or
   * Farcaster the approval appears in THAT app's own sheet, and naming it is the difference
   * between looking for a prompt and finding one.
   */
  const walletApprovalPrompt = useCallback(
    (action: string) => {
      switch (walletRoute) {
        case 'walletconnect': return `${action} — open your wallet app to approve it.`;
        case 'minipay':       return `${action} in MiniPay...`;
        case 'farcaster':     return `${action} in Farcaster...`;
        case 'base-app':      return `${action} in Base App...`;
        default:              return `${action} in your wallet...`;
      }
    },
    [walletRoute],
  );

  const [killSwitches, setKillSwitches] = useState<Record<string, boolean>>({});
  const [address, setAddress] = useState<string | null>(null);

  // 🔐 PROOF THAT THE CONNECTED ADDRESS IS ACTUALLY YOURS.
  //
  // 🔴 WHAT AN UNPROVEN ADDRESS COULD REACH. History used to be read straight from the browser
  // with `.ilike('wallet_address', address)` — a filter chosen by the client, which is not a
  // permission. Any address the page believed it was connected to returned that address's
  // payments: phone numbers, meter numbers, amounts. A provider that simply CLAIMS an address it
  // does not hold was enough. The signature is what turns "the wallet told us this address" into
  // "the wallet demonstrated it holds this address", and GET /api/history now derives the
  // address from the signature rather than from anything the caller sends.
  //
  // Held in sessionStorage, not localStorage: it should not outlive the browser session, and it
  // is a bearer credential for its lifetime (see WALLET_SESSION_MAX_AGE_MS). Read-only scope —
  // every mutation keeps its own fresh, per-action signature.
  const [walletProof, setWalletProof] = useState<{ address: string; signature: string; timestamp: string } | null>(null);
  const walletProofInFlight = useRef(false);
  // 🔴 WHICH ADDRESS THE APP CURRENTLY CARES ABOUT — read by the in-flight verification to decide
  // whether its result is still wanted. It replaces the per-run `cancelled` flag that used to make
  // that call, and the difference is the whole bug: `cancelled` asks "was my effect run
  // superseded?", which is NOT the same question as "is this signature still useful?". A signature
  // proves ownership of the address it was made for no matter how many times the effect re-ran
  // while the wallet was thinking. See the verification effect below.
  // `string | null | undefined` mirrors proofAddress exactly: it is wagmiAddress (undefined when
  // absent) for WEB, minipayPending?.address for MiniPay, and `address` (null when absent)
  // elsewhere. Narrowing it would just move the null-handling somewhere less honest.
  const proofAddressRef = useRef<string | null | undefined>(undefined);

  /** Headers for a request that must prove wallet ownership, or null when unproven. */
  const walletProofHeaders = useCallback((): Record<string, string> | null => {
    if (!walletProof || !address) return null;
    if (walletProof.address.toLowerCase() !== address.toLowerCase()) return null;
    return {
      'x-wallet-address': walletProof.address,
      'x-wallet-signature': walletProof.signature,
      'x-wallet-timestamp': walletProof.timestamp,
    };
  }, [walletProof, address]);
  const [client, setClient] = useState<WalletClient | null>(null);

  // ⚡ SMART MAINNET DETECTOR ⚡
  const isMainnet = 
    process.env.NEXT_PUBLIC_NETWORK === "mainnet" || 
    process.env.NEXT_PUBLIC_NETWORK === "celo" || 
    process.env.NEXT_PUBLIC_NETWORK === "base";

  // ⚡ MUST BE A USESTATE (Defaults to Celo, but changes to Base when connected) ⚡
  // Seeded from the app's DEFAULT chain (Base). This was still Celo — a leftover from when Celo
  // was the default — so before a wallet connected, the token picker and the balance read were
  // pointed at a different chain from the one the app was about to connect on.
  const [activeChain, setActiveChain] = useState<any>(isMainnet ? base : baseSepolia);

  // ⚡ THE ONE PLACE THAT DECIDES "WHICH CHAINS CAN THIS ENVIRONMENT EVEN SEE."
  //
  // 🔴 BASE APP WAS NEVER ACTUALLY A LOCKED ENVIRONMENT — IT WAS PLAIN 'WEB' THAT HAPPENED TO
  // AUTO-CONNECT. `environment` has a 'BASE' member in its type, but nothing ever sets it;
  // isBaseAppBrowser() was only ever consulted for silent auto-connect (see AUTO_CONNECT_SURFACES
  // in walletEnv.ts). So a Base App user got the full WEB experience underneath — both chains in
  // the picker, an interactive network menu offering Celo, exactly the surface area someone
  // running inside a Base-only wallet has no way to act on correctly.
  //
  // Adding a real 'BASE' environment state would touch every place `environment === 'WEB'` gates
  // the proof-before-publish bridge, the auto-connect allowlist, the connect button — all
  // machinery this is not meant to change. `chainLock` is deliberately a SEPARATE, PURELY
  // DERIVED value: which single chain (if any) this surface is confined to, regardless of which
  // `environment` bucket it falls under. Nothing here is state — it is recomputed every render
  // from `environment` and the same browser signal Base App auto-connect already trusts, so nulling
  // it out never requires its own effect or cleanup.
  //
  //   MINIPAY              -> Celo only  (MiniPay does not run on Base)
  //   FARCASTER             -> Base only  (the Farcaster mini-app path targets Base)
  //   WEB, inside Base App  -> Base only  (Base App is a Base wallet; Celo was never reachable)
  //   anything else (plain WEB) -> null   (both chains, full switcher)
  const chainLock: 'CELO' | 'BASE' | null =
    environment === 'MINIPAY' ? 'CELO'
    : environment === 'FARCASTER' ? 'BASE'
    : (environment === 'WEB' && isBaseAppBrowser()) ? 'BASE'
    : null;

  const [nairaAmount, setNairaAmount] = useState(""); 
  const [accountNumber, setAccountNumber] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerEmail, setCustomerEmail] = useState(""); 
  const [status, setStatus] = useState("");

  const [activeTab, setActiveTab] = useState<"pay" | "bank" | "education" | "history" | "agent">("pay");

  // ⚡ IN-APP PRODUCT TOUR — auto-launches once per browser (localStorage-gated, see
  // AppTour.tsx) for a first-time visitor; replayable anytime via the compass icon in the
  // header. A returning visitor who already finished or cancelled it is never shown it again.
  const [tourActive, setTourActive] = useState(false);
  useEffect(() => {
    if (!hasSeenTour()) setTourActive(true);
  }, []);

  // ⚡ DeAI agent allowance state
  const [agentAllowance, setAgentAllowance] = useState<string | null>(null);
  const [isApprovingAgent, setIsApprovingAgent] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  /**
   * ⚡ AN ESCAPE HATCH FROM A WALLET THAT NEVER ANSWERS ⚡
   *
   * 🔴 DISMISSING A WALLET PROMPT IS NOT ALWAYS AN ANSWER. Every cancellation path in this file
   * assumes the wallet reports the rejection — EIP-1193 says it should, and injected wallets do.
   * Valora over WalletConnect does not: dismissing its sheet sends NOTHING back over the relay,
   * so there is no rejection to catch, no error and no event. The request simply stays open and
   * the page goes on waiting for a decision that has already been made. Reported as "I cancelled
   * the wallet pop up and it kept loading for life".
   *
   * withWalletTimeout does eventually fire, but ninety seconds of frozen spinner AFTER you have
   * already tapped cancel reads as broken — and that budget has to stay ninety seconds, because
   * it is also how long someone gets to actually read a prompt before approving it.
   *
   * So the user gets to say so themselves. This cannot abort the in-flight request — nothing on
   * this side can — and it deliberately does NOT claim the payment was cancelled: if they
   * approve it a moment later it will still settle, and telling them otherwise is how someone
   * pays twice. It stops the spinner and says exactly that. Shown only after 15s, so a normal
   * payment never sees it.
   *
   * 🔴 AND ONLY ON THE ROUTE THAT HAS THE PROBLEM. This exists because a dismissal over the
   * WalletConnect relay sends NOTHING back. An injected wallet does not behave that way: cancel
   * an extension's prompt and it rejects the request, the catch block fires, and the spinner
   * stops on its own. Offering "stop waiting" there attaches an escape hatch to a payment that
   * was never trapped — it reads as the app admitting it has lost track of a transaction the
   * user is midway through approving, which is alarming precisely when calm is warranted.
   */
  const [canStopWaiting, setCanStopWaiting] = useState(false);
  useEffect(() => {
    if (!isProcessing || !isRemoteWallet) { setCanStopWaiting(false); return; }
    const t = setTimeout(() => setCanStopWaiting(true), 15_000);
    return () => clearTimeout(t);
  }, [isProcessing, isRemoteWallet]);

  const stopWaitingForWallet = useCallback(() => {
    setIsProcessing(false);
    setStatus("Stopped waiting. If the payment was already approved it will still go through — check History before trying again.");
  }, []);

  const [customerName, setCustomerName] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const [isConfirmModalOpen, setIsConfirmModalOpen] = useState(false);

  const [beneficiaries, setBeneficiaries] = useState<Record<string, {account: string, name: string | null}[]>>({});
  const [activeDeleteAccount, setActiveDeleteAccount] = useState<string | null>(null);
  const pressTimer = useRef<NodeJS.Timeout | null>(null);
  const isLongPress = useRef(false);

  // ⚡ THE BUG THIS FIXES: resolveBankAccount (the slow ~25-bank auto-detect sweep) and
  // verifyBankAccount (a single fast manual verify) are two independent async calls with no
  // way to know about each other. If a user gets impatient waiting on auto-detect and manually
  // picks a bank — which verifies successfully — the STILL-IN-FLIGHT auto-detect call has no
  // idea that happened. When it finally resolves (0 matches, or times out), it unconditionally
  // shows "Couldn't Detect Bank — select manually", even though the user already did exactly
  // that and it already verified. A plain `if (customerName) return` check doesn't work here —
  // customerName is read from a stale closure captured when the async call STARTED, not its
  // value when the awaited fetch finally resolves. This generation counter is bumped at the
  // start of every verify/resolve attempt; each call captures its own generation number and
  // discards its result entirely if a newer attempt has since started.
  const bankVerifyGenerationRef = useRef(0);

  const [meterAddress, setMeterAddress] = useState<string | null>(null);
  const [dynamicElecMin, setDynamicElecMin] = useState<number>(1000);
  const [meterAccountType, setMeterAccountType] = useState<string | null>(null);
  const [cableCurrentBouquet, setCableCurrentBouquet] = useState<string | null>(null);
  const [cableRenewAmount, setCableRenewAmount] = useState<number | null>(null);
  const [cableSubscriptionType, setCableSubscriptionType] = useState<"renew" | "change">("renew");
  const [cableVariations, setCableVariations] = useState<any[]>([]);
  const [selectedCablePlan, setSelectedCablePlan] = useState<any>(null);
  const [internetVariations, setInternetVariations] = useState<any[]>([]);
  const [selectedInternetPlan, setSelectedInternetPlan] = useState<any>(null);
  const [internetAccountId, setInternetAccountId] = useState<string | null>(null);
  const [bankVariations, setBankVariations] = useState<any[]>([]);
  const [selectedBank, setSelectedBank] = useState<any>(null);
  const [isFetchingBanks, setIsFetchingBanks] = useState(false);
  // ⚡ Populated when auto-detect (resolveBankAccount) finds MORE THAN ONE bank matching a
  // typed account number — the user picks theirs from this short list rather than the full
  // ~25-bank picker. Empty otherwise (single match auto-selects; zero matches falls back to
  // the full manual picker).
  const [bankSuggestions, setBankSuggestions] = useState<any[]>([]);
  const [educationProvider, setEducationProvider] = useState("waec");
  const [educationVariations, setEducationVariations] = useState<any[]>([]);
  const [selectedEducationPlan, setSelectedEducationPlan] = useState<any>(null);

  const [activeCountry, setActiveCountry] = useState<{code: string, name: string, currency?: string, flag?: string}>(SUPPORTED_COUNTRIES[0]);
  const [activeService, setActiveService] = useState(SERVICES[0]);
  // ⚡ Seeded from the bundled list purely so the very first render has SOMETHING selected; the
  // live lists below take over as soon as /api/providers answers, and useValidSelection moves
  // the selection off any serviceID VTpass no longer offers.
  const [elecProvider, setElecProvider] = useState("ikeja-electric");
  const [cableProvider, setCableProvider] = useState("dstv");
  const [telecomProvider, setTelecomProvider] = useState("mtn");
  const [internetProvider, setInternetProvider] = useState("mtn-data");
  const [meterType, setMeterType] = useState<"prepaid" | "postpaid">("prepaid");

  const [intlCountries, setIntlCountries] = useState<any[]>([]);
  const [intlProductTypes, setIntlProductTypes] = useState<any[]>([]);
  const [intlOperators, setIntlOperators] = useState<any[]>([]);
  const [intlVariations, setIntlVariations] = useState<any[]>([]);
  const [intlCurrency, setIntlCurrency] = useState<string>(""); 

  const [selectedIntlProduct, setSelectedIntlProduct] = useState<any>(null);
  const [selectedIntlOperator, setSelectedIntlOperator] = useState<any>(null);
  const [selectedIntlVariation, setSelectedIntlVariation] = useState<any>(null);
  const [intlFlexibleAmount, setIntlFlexibleAmount] = useState("");
  const [isIntlLoading, setIsIntlLoading] = useState(false);

  const [selectedReceipt, setSelectedReceipt] = useState<any>(null); 
  const [isSelectionModalOpen, setIsSelectionModalOpen] = useState(false);
  const [modalTitle, setModalTitle] = useState("");
  const [modalOptions, setModalOptions] = useState<any[]>([]); 
  const [modalCallback, setModalCallback] = useState<((value: string) => void) | null>(null);
  const [modalType, setModalType] = useState<'standard' | 'token' | 'provider' | 'country' | 'bank'>('standard'); 
  const [toast, setToast] = useState<{title: string, message: string, type: 'success' | 'error'} | null>(null);
  const [isSupportOpen, setIsSupportOpen] = useState(false);
  const [supportMessage, setSupportMessage] = useState("");
  const [supportEmail, setSupportEmail] = useState("");
    const [supportTxHash, setSupportTxHash] = useState<string | null>(null);
  const [supportChain, setSupportChain] = useState<string | null>(null); // ⚡ ADD THIS LINE
  const [supportFile, setSupportFile] = useState<File | null>(null);
  const [isSendingSupport, setIsSendingSupport] = useState(false);

  const [currentPage, setCurrentPage] = useState(1);
  // Seeded from the DEFAULT chain (Base → USDC), not a hardcoded symbol. Before a wallet is
  // connected there is no activeChain to derive this from, and the old hardcoded "USD₮" meant
  // the very first thing a Base user saw was the token Base does NOT lead with.
  const [selectedToken, setSelectedToken] = useState(() => defaultTokenForChain(DEFAULT_CHAIN));
  const [walletBalance, setWalletBalance] = useState("0.00");
  const [isFetchingBalance, setIsFetchingBalance] = useState(false);
  const [exchangeRate, setExchangeRate] = useState<number>(1550); 
  const [transactions, setTransactions] = useState<any[]>([]);
  const [globalFiatRates, setGlobalFiatRates] = useState<Record<string, number>>({});

  // ⚡ DYNAMIC ABAPAY CONTRACT ROUTING ⚡
  const ABAPAY_CONTRACT = useMemo(() => {
    if (activeChain?.id === base.id || activeChain?.id === baseSepolia.id) {
      return (process.env.NEXT_PUBLIC_ABAPAY_BASE_ADDRESS || process.env.NEXT_PUBLIC_ABAPAY_ADDRESS) as `0x${string}`;
    }
    return (process.env.NEXT_PUBLIC_ABAPAY_CELO_ADDRESS || process.env.NEXT_PUBLIC_ABAPAY_ADDRESS) as `0x${string}`;
  }, [activeChain]);

  const GAS_CURRENCY = isMainnet ? "0x765DE816845861e75A25fCA122bb6898B8B1282a" : "0xdE9e4C3ce781b4bA68120d6261cbad65ce0aB00b";

  const indexOfLastItem = currentPage * ITEMS_PER_PAGE;
  const indexOfFirstItem = indexOfLastItem - ITEMS_PER_PAGE;
  const currentTransactions = transactions.slice(indexOfFirstItem, indexOfLastItem);
  const totalPages = Math.ceil(transactions.length / ITEMS_PER_PAGE);

  // ⚡ LIVE PROVIDER LISTS — names, logos and amount limits straight from VTpass's
  // /services?identifier=… catalogue (via /api/providers, since VTpass credentials are
  // server-only). Nothing about the arrangement of the pickers changed; only the source of the
  // data behind them. A provider VTpass adds appears here with no deploy; one it drops
  // disappears, instead of being offered and then failing at vend time.
  const { providers: telecomProviders } = useProviders('airtime');
  const { providers: internetProviders } = useProviders('data');
  const { providers: electricityProviders } = useProviders('electricity');
  const { providers: cableProviders } = useProviders('cable');
  const { providers: educationProviders } = useProviders('education');

  const currentDisco = useMemo(() => electricityProviders.find(d => d.serviceID === elecProvider), [electricityProviders, elecProvider]);
  const currentCable = useMemo(() => cableProviders.find(c => c.serviceID === cableProvider), [cableProviders, cableProvider]);
  const currentInternet = useMemo(() => internetProviders.find(c => c.serviceID === internetProvider), [internetProviders, internetProvider]);
  const currentTelecom = useMemo(() => telecomProviders.find(t => t.serviceID === telecomProvider), [telecomProviders, telecomProvider]);
  const currentEducation = useMemo(() => educationProviders.find(e => e.serviceID === educationProvider), [educationProviders, educationProvider]);

  const isInternational = activeCountry.code !== "NG";

  // ⚡ DYNAMIC NETWORK TEXT ⚡
  //
  // 🔴 PRE-CONNECT USED TO HARDCODE "Base & Celo" NO MATTER WHAT — even in MiniPay, even in
  // Farcaster, even in Base App, all of which are already locked to one chain before a wallet is
  // ever connected (connectMiniPay sets activeChain to Celo, the Farcaster branch sets it to
  // Base, both BEFORE requesting addresses — see the Chameleon Environment Detector). This text
  // was the one place that ignored that and showed both chains regardless, which is exactly the
  // leak the user meant by "whether a user has connect wallet or not": AppFooter renders this
  // unconditionally, so a MiniPay user who hasn't tapped Connect yet saw "Base & Celo" in the
  // footer despite the rest of the app already behaving as Celo-only underneath.
  const activeNetworkDisplay = useMemo(() => {
    if (!address) return chainLock === 'CELO' ? 'Celo' : chainLock === 'BASE' ? 'Base' : 'Base & Celo';
    if (activeChain?.name?.toLowerCase().includes("base")) return "Base";
    if (activeChain?.name?.toLowerCase().includes("celo")) return "Celo";
    return activeChain?.name || "Base & Celo";
  }, [address, activeChain, chainLock]);

  // ⚡ MULTI-CHAIN TOKEN FILTER & AUTO-SWITCHER ⚡
  //
  // Both the filtering and the per-chain ordering now come from constants/tokensForChain, so
  // the Pay tab, the Agent Hub, the chat agent and the MCP tools can't disagree about which
  // stablecoin a chain leads with. Base → USDC then USD₮; Celo → USD₮, USDC, USDm.
  //
  // With no wallet connected `activeChain` is undefined, which resolves to DEFAULT_CHAIN
  // rather than to an empty list — the picker used to render with nothing in it until the
  // user connected.
  const availableTokens = useMemo(
    () => tokensForChain(activeChain?.name),
    [activeChain]
  );

  // 🔴 SWITCHING CHAIN MUST RESET TO THAT CHAIN'S LEAD STABLECOIN, NOT JUST RESCUE AN
  // IMPOSSIBLE ONE. This only fired when the selected token didn't exist on the new chain —
  // and USD₮ exists on BOTH. So arriving on Base from Celo (or from a Celo-shaped saved state)
  // silently kept USD₮ selected, even though Base leads with USDC.
  //
  // That wasn't cosmetic, it changed the settlement rail: x402 on Base requires USDC, because
  // Base USD₮ has no `transferWithAuthorization` to sign. A Base user left on USD₮ was quietly
  // routed to the contract call and never saw x402 at all — reported as "in base mode it's
  // using the normal contract call route".
  //
  // Keyed on the chain ID so it fires when the CHAIN changes, and never fights a user who
  // deliberately picked the other token while staying put.
  const lastTokenChainId = useRef<number | null>(null);
  useEffect(() => {
    if (availableTokens.length === 0) return;
    const chainId = activeChain?.id ?? null;

    if (lastTokenChainId.current !== chainId) {
      lastTokenChainId.current = chainId;
      setSelectedToken(availableTokens[0]); // the chain's lead stablecoin — USDC on Base
      return;
    }
    // Same chain, but the current pick is somehow not offered here — rescue it.
    if (!availableTokens.find(t => t.symbol === selectedToken.symbol)) {
      setSelectedToken(availableTokens[0]);
    }
  }, [availableTokens, selectedToken.symbol, activeChain]);

  const isCurrentServiceDisabled = useMemo(() => {
      if (!killSwitches) return false;
      
      // 🌐 Check the database kill-switch for international transactions. 
      // If it's not set in the DB yet, it defaults to true (Disabled) instantly!
      if (isInternational) {
          return killSwitches.hasOwnProperty('MASTER_INTERNATIONAL') 
            ? killSwitches['MASTER_INTERNATIONAL'] === false 
            : true; 
      }

      if (activeTab === 'education') return killSwitches['MASTER_EDUCATION'] === false || killSwitches[`EDU_${educationProvider}`] === false;
      // 🔴 THE GAP THIS FIXES: the admin dashboard now has a Bank Transfer kill switch
      // (writes kill_switches.BANK — see src/lib/serviceRules.ts's BANK_TRANSFER spec,
      // which the agent already reads), but nothing here ever checked it — an operator
      // pausing bank transfers only stopped the agent, while the web app happily kept
      // taking crypto for transfers the operator had explicitly switched off.
      if (activeTab === 'bank') return killSwitches['BANK'] === false;
      if (activeTab === 'pay') {
          if (activeService.id === "AIRTIME") return killSwitches['MASTER_AIRTIME'] === false || killSwitches[`AIRTIME_${telecomProvider.toLowerCase()}`] === false;
          if (activeService.id === "INTERNET") return killSwitches['MASTER_INTERNET'] === false || killSwitches[`INTERNET_${internetProvider}`] === false;
          if (activeService.id === "ELECTRICITY") return killSwitches['MASTER_ELECTRICITY'] === false || killSwitches[`ELEC_${elecProvider}`] === false;
          if (activeService.id === "CABLE") return killSwitches['MASTER_CABLE'] === false || killSwitches[`CABLE_${cableProvider}`] === false;
      }
      return false;
  }, [killSwitches, activeTab, activeService, educationProvider, telecomProvider, internetProvider, elecProvider, cableProvider, isInternational]);

  // ⚡ LIVE PER-PROVIDER AMOUNT LIMITS (VTpass minimium_amount / maximum_amount).
  //
  // 🔴 THE BUG THIS FIXES: the ceiling here was ONE flat number per service, but VTpass's real
  // ceiling varies per network — mtn 200,000 · glo 100,000 · airtel 50,000 · etisalat 50,000.
  // The flat ₦50,000 airtime cap therefore REFUSED a perfectly valid ₦120,000 MTN top-up, while
  // simply raising it to a flat ₦200,000 would ACCEPT a ₦120,000 Airtel top-up that VTpass
  // rejects at vend time — after the user has already paid on-chain. No single flat number is
  // correct for all four networks, so the number now comes from the network itself.
  //
  // Electricity is the same story: the discos range from ₦100 (Ikeja, Aba) to ₦2,000 (Ibadan)
  // against one hardcoded ₦1,000 default.
  const telecomLimits = useProviderLimits(telecomProviders, telecomProvider);
  const elecLimits = useProviderLimits(electricityProviders, elecProvider);

  const dynamicMinAmount = useMemo(() => {
    if (activeTab === "bank") return 1000;
    // 🔴 Deliberately Math.max, not a straight swap: VTpass's floor can only ever TIGHTEN our
    // own ₦100 floor, never loosen it. MTN's published minimum is ₦10 — honouring that literally
    // would silently drop the app's business minimum to ₦10 as a side effect of live sourcing,
    // which is a pricing change nobody asked for. Where VTpass is STRICTER (Airtel's ₦50 floor,
    // Ibadan's ₦2,000) it wins, because those are vends that would otherwise be paid for and
    // then rejected.
    if (activeService.id === "AIRTIME") return Math.max(100, telecomLimits.min ?? 0);
    return 100;
  }, [activeService, activeTab, telecomLimits.min]);

  const dynamicMaxAmount = useMemo(() => {
    if (activeTab === "bank") return 5000000;
    // Falls back to the previous flat number when VTpass publishes no ceiling, so "unknown"
    // never accidentally becomes "unlimited".
    if (activeService.id === "ELECTRICITY") return elecLimits.max ?? 1000000;
    if (activeService.id === "AIRTIME") return telecomLimits.max ?? 50000;
    return Infinity;
  }, [activeService, activeTab, telecomLimits.max, elecLimits.max]);

  // The electricity floor is the stricter of VTpass's published disco minimum and whatever the
  // meter verification came back with (a postpaid balance owed sets dynamicElecMin).
  const effectiveElecMin = useMemo(
    () => Math.max(dynamicElecMin, elecLimits.min ?? 0),
    [dynamicElecMin, elecLimits.min]
  );

  const isFixedPlan = isInternational 
    ? (selectedIntlVariation && selectedIntlVariation.fixedPrice === "Yes")
    : (activeTab === "education" || (activeTab === "pay" && (activeService.id === "INTERNET" || activeService.id === "CABLE")));

  const currentMinDisplay = (activeTab === "pay" && activeService.id === "ELECTRICITY") ? effectiveElecMin : dynamicMinAmount;

  const displayForeignAmount = useMemo(() => {
      if (!isInternational) return "0";
      if (!selectedIntlVariation) return "0";
      if (selectedIntlVariation.fixedPrice === "Yes") return parseFloat(selectedIntlVariation.variation_amount || "0").toLocaleString();
      return parseFloat(intlFlexibleAmount || "0").toLocaleString();
  }, [isInternational, selectedIntlVariation, intlFlexibleAmount]);

  const calculatedNairaAmount = useMemo(() => {
    if (!isInternational) return nairaAmount;
    if (!selectedIntlVariation) return "0";

    const rate = parseFloat(selectedIntlVariation.variation_rate || "1");
    if (selectedIntlVariation.fixedPrice === "Yes") {
        const charged = parseFloat(selectedIntlVariation.charged_amount || "0");
        if (charged > 0) return charged.toString();
        const varAmt = parseFloat(selectedIntlVariation.variation_amount || "0");
        return (varAmt * rate).toString();
    }
    const input = parseFloat(intlFlexibleAmount || "0");
    return (input * rate).toString();
  }, [isInternational, selectedIntlVariation, intlFlexibleAmount, nairaAmount]);

  // ⚡ DISCOUNT PREVIEW — this is a preview only; /api/pay independently re-derives the same
  // discount server-side (see src/lib/discounts.ts) and is what actually enforces it. Debounced
  // so switching services/typing an amount doesn't fire a request per keystroke. Service key
  // mirrors buildBackendPayload's `uiCategory` (BANK/EDUCATION/AIRTIME/INTERNET/ELECTRICITY/
  // CABLE/INTERNATIONAL) so the preview and the real server-side check are always looking at
  // the same thing.
  //
  // 🔴 THE BUG THIS FIXES: this used to bail out entirely for international payments — but
  // /api/pay's own discount lookup was NEVER told to treat international any differently, so a
  // "global" (no services restriction) campaign would still silently MATCH an international
  // transaction server-side and reduce the required crypto, while this client never showed the
  // discount, never subtracted it from cryptoToCharge, and the user just ended up paying less
  // than the full displayed price with no explanation. calculatedNairaAmount already holds a
  // real NGN-equivalent for international requests (see its own useMemo above), so the exact
  // same discount math genuinely applies — international is now a first-class, matchable
  // service key ("INTERNATIONAL") instead of being silently excluded on one side only.
  const [activeDiscount, setActiveDiscount] = useState<{ id: string; name: string; type: 'PERCENT' | 'FIXED'; value: number; maxDiscountNgn: number | null } | null>(null);
  const [discountNgn, setDiscountNgn] = useState(0);

  useEffect(() => {
    const bill = parseFloat(calculatedNairaAmount) || 0;
    if (bill <= 0) { setActiveDiscount(null); setDiscountNgn(0); return; }
    const serviceKey = isInternational ? "INTERNATIONAL" : activeTab === "bank" ? "BANK" : activeTab === "education" ? "EDUCATION" : activeService.id;

    const t = setTimeout(() => {
      const walletParam = address ? `&wallet=${encodeURIComponent(address)}` : '';
      const destinationParam = accountNumber ? `&destination=${encodeURIComponent(accountNumber)}` : '';
      fetch(`/api/discounts/active?service=${encodeURIComponent(serviceKey)}&amount=${bill}${walletParam}${destinationParam}`)
        .then((r) => r.json())
        .then((d) => {
          if (d?.success) { setActiveDiscount(d.discount || null); setDiscountNgn(Number(d.discountNgn) || 0); }
        })
        .catch(() => { setActiveDiscount(null); setDiscountNgn(0); });
    }, 400);

    return () => clearTimeout(t);
  }, [calculatedNairaAmount, activeTab, activeService.id, isInternational, address, accountNumber]);

  // Foreign-currency-equivalent of discountNgn, for DISPLAY only — cryptoToCharge/the server
  // both work entirely in NGN terms already (calculatedNairaAmount IS the NGN-equivalent for an
  // international request too), so no payment math depends on this. Derived from the ratio of
  // the two amounts already on screen (calculatedNairaAmount / displayForeignAmount) rather than
  // re-deriving the plan's own rate/fixed-price logic, so it's automatically correct whichever
  // of that branching produced the current numbers.
  const foreignDiscountAmount = useMemo(() => {
    if (!isInternational || discountNgn <= 0) return null;
    const ngn = parseFloat(calculatedNairaAmount) || 0;
    const foreign = parseFloat(String(displayForeignAmount).replace(/,/g, '')) || 0;
    if (ngn <= 0 || foreign <= 0) return null;
    const impliedRate = ngn / foreign; // NGN per 1 unit of the foreign currency
    return discountNgn / impliedRate;
  }, [isInternational, discountNgn, calculatedNairaAmount, displayForeignAmount]);

  const { cryptoToCharge, currentFee } = useMemo(() => {
    const bill = parseFloat(calculatedNairaAmount) || 0;
    const fee = (activeTab === "bank" || activeService.id === "ELECTRICITY" || activeService.id === "CABLE" || activeTab === "education") ? 100 : 0;
    // ⚡ CBN STAMP DUTY — ₦50 fixed, mandated on electronic transfers of ₦10,000 and above.
    // Deliberately NOT folded into `currentFee`: that value is shown to the user everywhere
    // (checkout total, receipts, history) as "+₦100 FEE", and stamp duty is a regulatory
    // pass-through, not a fee we're charging — it's silently absorbed into the crypto amount
    // charged instead. Server-side (/api/pay, /api/pay/x402) computes the identical amount
    // and is the one that actually enforces/records it; this is only the on-screen estimate,
    // kept in sync so the preview matches what gets charged.
    const stampDuty = (activeTab === "bank" && bill >= 10000) ? 50 : 0;
    const crypto = (bill + fee + stampDuty - discountNgn) / exchangeRate;
    return { cryptoToCharge: crypto.toFixed(4), currentFee: fee };
  }, [calculatedNairaAmount, exchangeRate, activeService, activeTab, discountNgn]);

  const walletFiatDisplay = useMemo(() => {
    const bal = parseFloat(walletBalance);
    if (isNaN(bal)) return "0.00";

    if (isInternational) {
        const currencyCode = intlCurrency || (activeCountry as any).currency || activeCountry.code;

        if (selectedIntlVariation && selectedIntlVariation.variation_rate) {
            const rate = parseFloat(selectedIntlVariation.variation_rate);
            const foreignBal = (bal * exchangeRate) / rate;
            return `${currencyCode} ${foreignBal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        }

        const liveRate = globalFiatRates[currencyCode];
        if (liveRate) {
            const foreignBal = bal * liveRate;
            return `${currencyCode} ${foreignBal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        }
        return `${currencyCode} ...`;
    }

    return `₦${(bal * exchangeRate).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }, [walletBalance, exchangeRate, isInternational, activeCountry, intlCurrency, selectedIntlVariation, globalFiatRates]);

  const checkoutDetails = useMemo(() => {
    let title = ""; let recipient = accountNumber; let recipientLabel = "Recipient";

    if (isInternational) {
        title = `${activeCountry.name} ${selectedIntlProduct?.name || 'Airtime'}`;
        recipientLabel = "Phone Number";
    } else if (activeTab === "bank") {
      title = `Transfer to ${selectedBank?.name || "Bank"}`; recipientLabel = "Account";
    } else if (activeTab === "education") {
      title = currentEducation?.displayName || "Education";
      recipient = educationProvider === "jamb" ? accountNumber : customerPhone; recipientLabel = educationProvider === "jamb" ? "Profile ID" : "Phone Number";
    } else {
      if (activeService.id === "AIRTIME") { 
         title = `${telecomProvider === 'etisalat' ? '9MOBILE' : telecomProvider.toUpperCase()} Airtime`; 
         recipientLabel = "Phone Number"; 
      } 
      else if (activeService.id === "INTERNET") { title = `${currentInternet?.displayName || "Data"} Plan`; recipientLabel = internetProvider === 'smile-direct' ? "Email Account" : internetProvider === 'spectranet' ? "Spectranet ID" : "Phone Number"; } 
      else if (activeService.id === "ELECTRICITY") { title = `${currentDisco?.displayName || "Electricity"} (${meterType})`; recipientLabel = "Meter No"; } 
      else if (activeService.id === "CABLE") { title = `${currentCable?.displayName || "Cable TV"}`; recipientLabel = "Smartcard / IUC"; }
    }
    return { title, recipient, recipientLabel };
  }, [isInternational, activeCountry, selectedIntlProduct, activeTab, activeService, selectedBank, educationProvider, telecomProvider, currentInternet, internetProvider, currentDisco, meterType, currentCable, accountNumber, customerPhone]);

  // ⚡ THE PENDING DUPLICATE DETECTOR ⚡
  const hasPendingDuplicate = useMemo(() => {
    if (!checkoutDetails.recipient) return false;

    return transactions.some(tx => 
        tx.status === 'PENDING' &&
        tx.account === checkoutDetails.recipient &&
        (tx.amountNaira === calculatedNairaAmount || tx.amountNaira.includes(displayForeignAmount || "xyz"))
    );
  }, [transactions, checkoutDetails.recipient, calculatedNairaAmount, displayForeignAmount]);

  // ⚡ SMART ELECTRICITY DAILY BLOCKER ⚡
  const electricityDailyDuplicate = useMemo(() => {
    if (activeTab !== "pay" || activeService.id !== "ELECTRICITY" || isInternational) return false;
    if (!accountNumber || !nairaAmount) return false;

    const todayStr = new Date().toLocaleDateString();

    return transactions.some(tx => {
        if (tx.status !== 'SUCCESS') return false;
        if (tx.service !== 'ELECTRICITY') return false;
        if (tx.account !== accountNumber) return false;
        if (tx.amountNaira !== nairaAmount) return false;

        try {
            const txDateStr = new Date(tx.date).toLocaleDateString();
            return txDateStr === todayStr;
        } catch (e) {
            return false;
        }
    });
  }, [activeTab, activeService.id, isInternational, accountNumber, nairaAmount, transactions]);

  const isFormValid = useMemo(() => {
    if (isCurrentServiceDisabled) return false;

    if (isInternational) {
        if (!selectedIntlProduct || !selectedIntlOperator || accountNumber.length < 6) return false;
        if (!selectedIntlVariation) return false;
                if (selectedIntlVariation.fixedPrice !== "Yes") {
            const flexInput = parseFloat(intlFlexibleAmount || "0");
            if (flexInput <= 0) return false;

            // ⚡ MINIMUM 1 USD (1 STABLECOIN) CHECK ⚡
            const flexNairaEquivalent = flexInput * parseFloat(selectedIntlVariation.variation_rate || "1");
            const flexCryptoEquivalent = flexNairaEquivalent / exchangeRate;
            if (flexCryptoEquivalent < 1) return false;
        }
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(customerEmail)) return false;
        return true;
    }

    const amount = parseFloat(nairaAmount);
    if (!nairaAmount || isNaN(amount)) return false;
    if (!isFixedPlan) {
        const activeMinAmount = (activeTab === "pay" && activeService.id === "ELECTRICITY") ? effectiveElecMin : dynamicMinAmount;
        if (amount < activeMinAmount || amount > dynamicMaxAmount) return false;
    }
    if (activeTab === "bank") return accountNumber.length === 10 && customerName !== null && selectedBank !== null && customerPhone.length >= 10 && customerEmail.includes('@') && customerEmail.includes('.');
    if (activeTab === "education") {
      if (educationProvider === "jamb") return accountNumber.length >= 10 && customerName !== null && selectedEducationPlan !== null && customerPhone.length >= 10;
      return selectedEducationPlan !== null && customerPhone.length >= 10;
    }
    if (activeTab === "pay") {
      if (activeService.id === "AIRTIME") return accountNumber.length === 11 && accountNumber.startsWith("0");
      if (activeService.id === "INTERNET") {
        if (internetProvider === 'smile-direct') return internetAccountId !== null && selectedInternetPlan !== null && customerPhone.length >= 10;
        else if (internetProvider === 'spectranet') return accountNumber.length >= 5 && selectedInternetPlan !== null;
        else return accountNumber.length === 11 && accountNumber.startsWith("0") && selectedInternetPlan !== null;
      }
            if (activeService.id === "ELECTRICITY") {
          if (electricityDailyDuplicate) return false; // ⚡ Block identical daily payments
          return accountNumber.length >= 10 && customerName !== null && customerPhone.length >= 10;
      }
      if (activeService.id === "CABLE") {
        if (cableProvider === "showmax") return accountNumber.length >= 11 && selectedCablePlan !== null;
        if (accountNumber.length < 10 || customerName === null) return false;
        if (['dstv', 'gotv'].includes(cableProvider) && cableSubscriptionType === 'change' && !selectedCablePlan) return false;
        if (!['dstv', 'gotv'].includes(cableProvider) && !selectedCablePlan) return false;
        return true;
      }
    }
    return false;
  }, [isInternational, selectedIntlProduct, selectedIntlOperator, selectedIntlVariation, intlFlexibleAmount, customerEmail, accountNumber, nairaAmount, activeService, customerName, dynamicMinAmount, dynamicMaxAmount, effectiveElecMin, cableSubscriptionType, selectedCablePlan, selectedBank, selectedInternetPlan, internetAccountId, customerPhone, internetProvider, activeTab, cableProvider, selectedEducationPlan, educationProvider, isFixedPlan, isCurrentServiceDisabled]);

  const showToast = (title: string, message: string, type: 'success' | 'error' = 'success') => {
    setToast({ title, message, type }); setTimeout(() => setToast(null), 5000);
  };

  const handleProviderChange = (newProvider: string, type: 'internet' | 'telecom' | 'cable' | 'elec' | 'bank' | 'education') => {
    setIsVerifying(false); setStatus("");
    setNairaAmount(""); setCustomerName(null); setCustomerPhone(""); setCustomerEmail(""); setMeterAddress(null); setDynamicElecMin(1000); setMeterAccountType(null);
    // ⚡ Bank is the exception: the account number is typed FIRST (auto-detect resolves the
    // bank from it) — a manual pick here is an override of an already-typed number, not the
    // start of a fresh entry, so wiping accountNumber would throw away what the user typed.
    if (type !== 'bank') setAccountNumber("");
    if (type === 'internet') { setInternetVariations([]); setInternetProvider(newProvider); setSelectedInternetPlan(null); setInternetAccountId(null); }
    else if (type === 'telecom') { setTelecomProvider(newProvider); }
    else if (type === 'cable') { setCableProvider(newProvider); setSelectedCablePlan(null); setCableCurrentBouquet(null); setCableRenewAmount(null); setCableSubscriptionType("renew"); }
    else if (type === 'elec') { setElecProvider(newProvider); }
    else if (type === 'bank') {
      setSelectedBank(newProvider);
      setBankSuggestions([]);
      if (accountNumber.length === 10 && (newProvider as any)?.variation_code) verifyBankAccount((newProvider as any).variation_code);
    }
    else if (type === 'education') { setEducationProvider(newProvider); setSelectedEducationPlan(null); }
  };

  // Keep every selection pointing at a service VTpass still sells (see useValidSelection).
  //
  // 🔴 Deliberately routed through handleProviderChange rather than the bare setState: if VTpass
  // drops the service the user is currently on, the meter/smartcard number, amount, verified
  // name and fetched plan list sitting in the form all belong to the OLD provider. Silently
  // swapping only the provider id would leave that stale data attached to a different service —
  // e.g. an Ikeja meter number verified against Ikeja, now submitted to Eko. This is the exact
  // reset the picker already performs on a manual provider change; an automatic one is no
  // different. Membership-based, not position-based, so the normal seed->live handover (whose
  // orderings differ — the seed leads with mtn, VTpass leads with airtel) changes nothing.
  useValidSelection(telecomProviders, telecomProvider, (id) => handleProviderChange(id, 'telecom'));
  useValidSelection(internetProviders, internetProvider, (id) => handleProviderChange(id, 'internet'));
  useValidSelection(electricityProviders, elecProvider, (id) => handleProviderChange(id, 'elec'));
  useValidSelection(cableProviders, cableProvider, (id) => handleProviderChange(id, 'cable'));
  useValidSelection(educationProviders, educationProvider, (id) => handleProviderChange(id, 'education'));

  const handleResetService = (s: any) => {
    setIsVerifying(false); setStatus(""); 
    setActiveService(s); setAccountNumber(""); setCustomerName(null); setNairaAmount(""); setCustomerPhone(""); setCustomerEmail(""); 
    setCableCurrentBouquet(null); setCableRenewAmount(null); setSelectedCablePlan(null);
    setCableSubscriptionType("renew"); setSelectedBank(null); setSelectedInternetPlan(null); setInternetAccountId(null);
    setSelectedEducationPlan(null); setInternetVariations([]); setMeterAddress(null); setDynamicElecMin(1000); setMeterAccountType(null);
    setSelectedIntlProduct(null); setSelectedIntlOperator(null); setSelectedIntlVariation(null); setIntlFlexibleAmount(""); setIntlOperators([]); setIntlVariations([]); setIntlCurrency("");
  };

  const handleTabSwitch = (tab: "pay" | "bank" | "education" | "history" | "agent") => {
    if (isInternational && tab !== "pay" && tab !== "history") return;
    // The Agent tab sets an on-chain spending allowance — meaningless without a wallet.
    if (tab === "agent" && !address) {
      showToast("Connect Your Wallet", "Connect your wallet first to set up agent-initiated payments.", "error");
      return;
    }
    setActiveTab(tab); setCustomerPhone(""); setCustomerEmail(""); handleResetService(SERVICES[0]);
  };

  const openSelectionModal = (type: 'standard' | 'token' | 'provider' | 'country' | 'bank', title: string, options: any[], callback: (value: string) => void) => {
    setModalType(type as any); setModalTitle(title); setModalOptions(options); setModalCallback(() => callback); setIsSelectionModalOpen(true);
  };

  const handleCountryChange = (countryCode: string) => {
    const country = intlCountries.find(c => c.code === countryCode) || SUPPORTED_COUNTRIES.find(c => c.code === countryCode);
    if (country) { 
        setActiveCountry(country); 
        if (country.code !== "NG") setActiveTab("pay");
        handleResetService(SERVICES[0]); 
    }
  };

  const getCurrentProviderKey = () => {
    if (activeTab === "bank") return selectedBank?.variation_code;
    if (activeTab === "education") return educationProvider;
    if (activeTab === "pay") {
      if (activeService.id === "AIRTIME") return telecomProvider;
      if (activeService.id === "INTERNET") return internetProvider;
      if (activeService.id === "ELECTRICITY") return `${elecProvider}-${meterType}`;
      if (activeService.id === "CABLE") return cableProvider;
    }
    return null;
  };

  const saveBeneficiary = (account: string, name: string | null) => {
    if (!address) return; 
    const key = getCurrentProviderKey();
    if (!key) return;

    setBeneficiaries(prev => {
      const currentList = prev[key] || [];
      const filteredList = currentList.filter(b => b.account !== account);
      const newList = [{ account, name }, ...filteredList].slice(0, 4); 
      const newStorage = { ...prev, [key]: newList };
      localStorage.setItem(`abapay_beneficiaries_${address}`, JSON.stringify(newStorage));
      return newStorage;
    });
  };

  const removeBeneficiary = (accountToRemove: string) => {
    if (!address) return;
    const key = getCurrentProviderKey();
    if (!key) return;

    setBeneficiaries(prev => {
      const currentList = prev[key] || [];
      const newList = currentList.filter(b => b.account !== accountToRemove);
      const newStorage = { ...prev, [key]: newList };
      localStorage.setItem(`abapay_beneficiaries_${address}`, JSON.stringify(newStorage));
      return newStorage;
    });
  };

  const handleShareReceipt = async () => {
    const receiptText = `🧾 AbaPay Receipt\n\nDate: ${selectedReceipt?.date}\nStatus: ${selectedReceipt?.status}\nProduct: ${selectedReceipt?.network} ${selectedReceipt?.service}\nRecipient: ${selectedReceipt?.account}\nAmount Paid: ${isNaN(Number(selectedReceipt?.amountNaira)) ? selectedReceipt?.amountNaira : `₦${Number(selectedReceipt?.amountNaira).toLocaleString()}`}\nCrypto Used: ${selectedReceipt?.amountCrypto} ${selectedReceipt?.tokenUsed}\nTx Hash: ${selectedReceipt?.txHash}\n\nSecured by ${selectedReceipt?.blockchain || activeChain.name} Network`;
    if (navigator.share) { try { await navigator.share({ title: 'Receipt', text: receiptText }); } catch (err) {} } 
    else { try { await navigator.clipboard.writeText(receiptText); showToast("Copied!", "Receipt details copied to clipboard.", "success"); } catch (err) {} }
  };

    const handleSendSupport = async () => {
    // ⚡ 1. VALIDATE EMAIL ⚡
    if (!supportEmail.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supportEmail)) {
        return showToast("Error", "Please enter a valid email address.", "error");
    }
    if (!supportMessage.trim()) return showToast("Error", "Please enter a message.", "error");
    
    setIsSendingSupport(true);
    try {
            const formData = new FormData();
      formData.append("email", supportEmail); 
      formData.append("message", supportMessage);
      if (address) formData.append("userAddress", address);
      if (supportTxHash) formData.append("txHash", supportTxHash);
      
      // ⚡ ADD THIS: Sends the saved chain, or falls back to the current active network
      formData.append("chain", supportChain || activeChain?.name || "Unknown"); 
      
      if (supportFile) formData.append("file", supportFile);

      const res = await fetch('/api/support', { method: 'POST', body: formData });
      const data = await res.json();
      if (data.success) {
        showToast("Ticket Sent", data.message, "success");
        setIsSupportOpen(false); setSupportMessage(""); setSupportChain(null); setSupportEmail(""); setSupportFile(null);
      } else { showToast("Error", data.message || "Failed to send ticket", "error"); }
    } catch (e) { showToast("Error", "Network error. Failed to send ticket.", "error"); } 
    finally { setIsSendingSupport(false); }
  };

  // ⚡ Bank transfers settle through Monnify (Moniepoint Inc.'s API), not VTpass — the bank
  // list, account verification and the actual payout all come from src/lib/monnify.ts now.
  // `variation_code` here holds Monnify's CBN bank code (e.g. "044"), not a VTpass slug.
  const fetchBanksManual = async () => {
    setIsFetchingBanks(true);
    try {
      const res = await fetch(`/api/monnify/banks`);
      const data = await res.json();
      if (data.success && Array.isArray(data.banks) && data.banks.length > 0) {
        setBankVariations(data.banks.map((b: any) => ({ variation_code: b.code, name: b.name })));
      } else throw new Error("Empty");
    } catch (e) {
      setBankVariations([{ variation_code: '044', name: 'Access Bank' }, { variation_code: '058', name: 'Guaranty Trust Bank' }, { variation_code: '999992', name: 'OPay' }, { variation_code: '50515', name: 'Moniepoint Microfinance Bank' }, { variation_code: '057', name: 'Zenith Bank' }]);
    } finally { setIsFetchingBanks(false); }
  };

  // Single-bank verify — used when the user manually (re)picks a bank, either because
  // auto-detect found no match or they're overriding an auto-detected suggestion.
  const verifyBankAccount = async (bankCode: string) => {
    // 🔴 THE BUG THIS FIXES: no offline check, no request timeout, and a failure response was
    // silently swallowed — a bad account number, or a dropped connection, both just spun the
    // "Verifying..." indicator forever with no feedback at all.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      showToast("You're Offline", "Check your internet connection and try again.", "error");
      return;
    }
    // Claims the generation for THIS attempt — see bankVerifyGenerationRef's own comment.
    const myGeneration = ++bankVerifyGenerationRef.current;
    setIsVerifying(true); setCustomerName(null);
    try {
      const res = await fetch('/api/monnify/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountNumber, bankCode }),
        signal: timeoutSignal(15000),
      });
      const data = await res.json();
      if (bankVerifyGenerationRef.current !== myGeneration) return; // superseded — discard
      if (data.success) setCustomerName(data.accountName);
      else showToast("Verification Failed", data.message || "Could not verify this account.", "error");
    } catch (e: any) {
      if (bankVerifyGenerationRef.current !== myGeneration) return;
      const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      showToast("Verification Failed", timedOut ? "This is taking too long — check your connection and try again." : "Network error — check your connection and try again.", "error");
    }
    if (bankVerifyGenerationRef.current === myGeneration) setIsVerifying(false);
  };

  // Auto-detect: "here's an account number, which bank is it?" — tries the number against
  // every bank's Name Enquiry until one (or more) return a real account name. The way
  // Paystack/Mono-style "auto-detect" actually works — there's no way to derive the bank
  // from a NUBAN's digits alone.
  const resolveBankAccount = async () => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      showToast("You're Offline", "Check your internet connection and try again.", "error");
      return;
    }
    // Claims the generation for THIS sweep — see bankVerifyGenerationRef's own comment. This
    // is the fix for "choose bank manually" popping up again after a manual pick already
    // verified successfully: that manual pick's verifyBankAccount() call claims a NEWER
    // generation, so when this (now-stale) sweep's slow response finally arrives, it notices
    // it's been superseded and discards its result entirely instead of overriding it.
    const myGeneration = ++bankVerifyGenerationRef.current;
    setIsVerifying(true); setCustomerName(null); setBankSuggestions([]);
    try {
      // ⚡ Generous timeout — this fans out to every bank in parallel batches (see
      // /api/monnify/resolve), so it's naturally slower than a single verify, but it must
      // still fail with a clear message rather than spin the UI forever on a genuine outage.
      const res = await fetch('/api/monnify/resolve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountNumber }),
        signal: timeoutSignal(45000),
      });
      const data = await res.json();
      if (bankVerifyGenerationRef.current !== myGeneration) return; // superseded — discard

      const matches = data.matches || [];

      // 🔴 THE BUG THIS FIXES: a single match used to auto-select and auto-verify silently —
      // no confirmation step at all. A brute-force Name Enquiry sweep can occasionally return
      // a REAL match at an unintended bank (a coincidental valid NUBAN for a different person
      // — Monnify's sandbox in particular has shown this for well-known banks that don't
      // actually use phone-number-style accounts, like GTBank matching a number the user
      // intended as a phone number for a different, neobank-style provider). Silently
      // committing to that match risked sending money to the wrong person with nothing for
      // the user to catch before it happened. Now ANY match (one or many) requires an
      // explicit tap to confirm, showing the real verified name so the user can recognize
      // "that's not me/not who I meant" before anything is selected.
      if (matches.length >= 1) {
        setBankSuggestions(matches); // let the user pick/confirm theirs, even if there's only one
      } else if (selectedBank?.variation_code) {
        // No auto-detect match, but a bank was already picked manually — verify against it.
        await verifyBankAccount(selectedBank.variation_code);
        return; // verifyBankAccount manages its own isVerifying lifecycle (and generation)
      } else if (!data.success) {
        showToast("Couldn't Detect Bank", data.message || "Please select your bank manually.", "error");
      }
    } catch (e: any) {
      if (bankVerifyGenerationRef.current !== myGeneration) return;
      const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      showToast("Couldn't Detect Bank", timedOut ? "This is taking too long — please select your bank manually." : "Network error — please select your bank manually.", "error");
    }
    if (bankVerifyGenerationRef.current === myGeneration) setIsVerifying(false);
  };

  const verifyMerchant = async () => {
    // 🔴 THE BUG THIS FIXES: no offline check, no request timeout, and the catch block was
    // completely empty — a dropped connection while verifying an electricity meter, cable
    // smartcard, or JAMB profile just spun "Verifying..." forever with zero feedback.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      showToast("You're Offline", "Check your internet connection and try again.", "error");
      return;
    }
    setIsVerifying(true); setCustomerName(null); setCableCurrentBouquet(null); setCableRenewAmount(null); setInternetAccountId(null);
    setMeterAddress(null); setDynamicElecMin(1000); setMeterAccountType(null);

    try {
        let serviceID = ""; let reqType = undefined;
        if (activeTab === "education" && educationProvider === "jamb") { serviceID = "jamb"; reqType = selectedEducationPlan?.variation_code; }
        else {
          serviceID = activeService.id === "ELECTRICITY" ? elecProvider : activeService.id === "INTERNET" ? internetProvider : cableProvider;
          reqType = activeService.id === "ELECTRICITY" ? meterType : undefined;
        }

        const res = await fetch(`/api/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ billersCode: accountNumber, serviceID: serviceID, type: reqType }), signal: timeoutSignal(20000) });
        const data = await res.json();

        if (data.code === '000') {
          setCustomerName(data.content.Customer_Name || data.content.account_name || data.content.name);
          if (data.content.Address) setMeterAddress(data.content.Address);
          if (data.content.Min_Purchase_Amount) setDynamicElecMin(Number(data.content.Min_Purchase_Amount));
          if (data.content.Customer_Account_Type) setMeterAccountType(data.content.Customer_Account_Type);

          if (activeTab === "pay" && activeService.id === "INTERNET" && internetProvider === "smile-direct") setInternetAccountId(data.content.AccountId || data.content.account_id);
          if (activeTab === "pay" && activeService.id === "CABLE") {
            setCableCurrentBouquet(data.content.Current_Bouquet || "Unknown Package");
            if (data.content.Renewal_Amount && ['dstv', 'gotv'].includes(cableProvider)) {
              setCableRenewAmount(data.content.Renewal_Amount);
              if (cableSubscriptionType === "renew") setNairaAmount(data.content.Renewal_Amount.toString());
            }
          }
        } else { setStatus("Account could not be verified."); }
    } catch (e: any) {
      const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      showToast("Verification Failed", timedOut ? "This is taking too long — check your connection and try again." : "Network error — check your connection and try again.", "error");
    }
    setIsVerifying(false);
  };

  // ⚡ SHARED: which service is being paid, and the payload /api/pay (and /api/pay/x402)
  // both expect. Used by both processBlockchainPayment (contract call) and
  // processX402Payment (x402 settlement) so the service-resolution branching lives once.
  const buildBackendPayload = () => {
    let vtpassServiceID = ""; let displayNetwork = ""; let finalVariationCode = 'none'; let payloadBillersCode = accountNumber; let uiCategory = "";

    if (isInternational) {
        vtpassServiceID = "foreign-airtime"; displayNetwork = selectedIntlOperator.name; finalVariationCode = selectedIntlVariation.variation_code; uiCategory = `INTL ${selectedIntlProduct.name.toUpperCase()}`;
    } else if (activeTab === "bank") {
      vtpassServiceID = "moniepoint-transfer"; displayNetwork = selectedBank.name; finalVariationCode = selectedBank.variation_code; uiCategory = "BANK";
    } else if (activeTab === "education") {
      vtpassServiceID = educationProvider; displayNetwork = educationProvider; finalVariationCode = selectedEducationPlan?.variation_code || 'none'; uiCategory = "EDUCATION"; payloadBillersCode = educationProvider === "jamb" ? accountNumber : customerPhone;
    } else {
      uiCategory = activeService.id;
      if (activeService.id === "ELECTRICITY") { vtpassServiceID = elecProvider; displayNetwork = elecProvider; finalVariationCode = meterType; }
      else if (activeService.id === "CABLE") { vtpassServiceID = cableProvider; displayNetwork = cableProvider; finalVariationCode = (['dstv', 'gotv'].includes(cableProvider) && cableSubscriptionType === 'renew') ? 'none' : selectedCablePlan?.variation_code || 'none'; }
      else if (activeService.id === "INTERNET") { vtpassServiceID = internetProvider; displayNetwork = internetProvider; finalVariationCode = selectedInternetPlan?.variation_code || 'none'; payloadBillersCode = internetProvider === 'smile-direct' ? (internetAccountId || accountNumber) : accountNumber; }
      else { vtpassServiceID = telecomProvider; displayNetwork = telecomProvider; }
    }

    // Normalised to exactly 'BASE' | 'CELO'. This used to send the raw viem chain name, so a
    // testnet payment stored the literal "BASE SEPOLIA" — which resolveChain's exact-match
    // then read back as Celo. Sending the canonical name keeps every consumer honest.
    const currentBlockchainName = normalizeChainName(activeChain?.name);

    const backendPayload: any = {
      serviceID: vtpassServiceID, serviceCategory: uiCategory, network: displayNetwork.toUpperCase(), billersCode: payloadBillersCode, amount: cryptoToCharge,
      nairaAmount: calculatedNairaAmount,
      foreignAmount: isInternational ? (selectedIntlVariation?.fixedPrice === "Yes" ? selectedIntlVariation.variation_amount : intlFlexibleAmount) : undefined,
      displayAmount: isInternational ? `${intlCurrency || activeCountry.currency || activeCountry.code} ${displayForeignAmount}` : undefined,
      token: selectedToken.symbol,
      variation_code: finalVariationCode, phone: customerPhone || accountNumber, email: customerEmail, wallet_address: address,
      subscription_type: activeTab === "pay" && activeService.id === "CABLE" && ['dstv', 'gotv'].includes(cableProvider) ? cableSubscriptionType : undefined,
      meter_account_type: meterAccountType, operator_id: isInternational ? selectedIntlOperator?.operator_id : undefined, country_code: isInternational ? activeCountry.code : undefined, product_type_id: isInternational ? selectedIntlProduct?.product_type_id : undefined,
      customer_name: customerName || undefined,
      customer_address: meterAddress || undefined,
      source_channel: 'WEB',
      blockchain: currentBlockchainName
    };

    return { backendPayload, vtpassServiceID, payloadBillersCode, uiCategory, displayNetwork, finalVariationCode, currentBlockchainName };
  };

  // ⚡ SHARED: toast/history/balance-refresh tail — identical whether the payment settled
  // via the contract call or via x402.
  const handleVendResult = (finalStatus: any, realTxHash: string, backendPayload: any, uiCategory: string, displayNetwork: string, payloadBillersCode: string, currentBlockchainName: string) => {
      saveBeneficiary(accountNumber, customerName);
      handleResetService(SERVICES[0]);

      // 🔴 THE BUG THIS FIXES: this status/toast wording is shared by every category, and was
      // written entirely from the "vending a bill/token" mental model — fine for airtime,
      // meaningless (and a little alarming) for a bank transfer, where nothing is being
      // "vended" at all, just sent.
      const isBankTransfer = uiCategory === 'BANK';

      if (finalStatus.status === 'SUCCESS') {
          setStatus(isBankTransfer ? "Success! Your transfer has been sent." : "Success! Token/Ref Dispatched.");
          const earnedPoints = Number((parseFloat(calculatedNairaAmount) / exchangeRate).toFixed(2));
          if (earnedPoints > 0) {
              window.dispatchEvent(new CustomEvent('abapoints-awarded', { detail: earnedPoints }));
              showToast("Transaction Successful", `Payment confirmed! You earned +${earnedPoints.toFixed(2).replace(/\.00$/, '')} AbaPoints ✨`, "success");
          } else {
              showToast("Transaction Successful", "Your transaction has been successfully processed.", "success");
          }
      } else if (finalStatus.status === 'TIMEOUT') {
          setStatus(isBankTransfer ? "Transfer sent! We're confirming it landed in the background." : "Payment Sent! We're finishing your vending in the background.");
          showToast("Processing", "You can safely leave this page. Receipt will be in History.", "success");
      } else {
          setStatus(isBankTransfer ? "Transfer Failed. Admin alerted." : "Vending Failed. Admin alerted.");
          showToast(isBankTransfer ? "Transfer Error" : "Vending Error", finalStatus.message || (isBankTransfer ? "Payment received, but the transfer failed." : "Payment received, but vending failed."), "error");
      }

      const updatedHistory = [{
          id: realTxHash.slice(0,8), date: new Date().toLocaleString(), status: finalStatus.status === 'TIMEOUT' ? "PENDING" : finalStatus.status,
          amountNaira: isInternational ? `${intlCurrency || activeCountry.code} ${displayForeignAmount}` : calculatedNairaAmount,
          amountCrypto: backendPayload.amount, tokenUsed: selectedToken.symbol, service: uiCategory, network: displayNetwork.toUpperCase(), txHash: realTxHash, account: payloadBillersCode,
          blockchain: currentBlockchainName, purchased_code: finalStatus.purchased_code, units: finalStatus.units, country_code: isInternational ? activeCountry.code : null,
          // ⚡ The verified name shown live during entry (bank account holder / electricity
          // meter owner) — previously dropped here, so it never made it into history or the
          // receipt modal even though it was captured and saved to the DB correctly.
          customerName: customerName || null,
      }, ...transactions];
      setTransactions(updatedHistory);
      localStorage.setItem(`abapay_history_${address}`, JSON.stringify(updatedHistory));
      setCurrentPage(1);
  };

  // ⚡ FRESH ON-CHAIN BALANCE GUARD — checks the ACTUAL token balance on-chain right now,
  // not the cached `walletBalance` state (which can be stale if the user just moved funds or
  // switched token/chain). Returns true if there's enough to cover the payment. Used by BOTH
  // pay paths so a low balance is caught with a clear message BEFORE the user commits to a
  // transaction that would otherwise fail confusingly at settlement (the x402 path had no
  // balance check at all, so it always failed the hard way).
  // `chainOverride` lets a caller that just resynced the chain (see ensureWalletReachable) pass
  // the CURRENT chain directly, rather than reading the `activeChain` closure this function
  // would otherwise capture — which, within that same call, can still be one render behind.
  const hasEnoughBalanceOnChain = async (chainOverride?: any): Promise<boolean> => {
    const chain = chainOverride || activeChain;
    try {
      if (!address || !chain) return false;
      const tokenAddress = getAgentTokenAddress(chain);
      if (!tokenAddress) return false;
      const publicClient = createPublicClient({ chain, transport: http() });
      const balanceWei = await publicClient.readContract({ address: tokenAddress as `0x${string}`, abi: ERC20_ABI, functionName: 'balanceOf', args: [address] }) as bigint;
      const balance = parseFloat(formatUnits(balanceWei, selectedToken.decimals));
      setWalletBalance(balance.toFixed(4)); // keep the UI figure in sync while we're here
      return balance >= parseFloat(cryptoToCharge);
    } catch {
      // If we genuinely can't read the balance, don't hard-block — fall back to the cached
      // value so a transient RPC hiccup doesn't stop a user who actually has the funds.
      return parseFloat(walletBalance) >= parseFloat(cryptoToCharge);
    }
  };

  /**
   * Refuse to start a wallet interaction the wallet cannot possibly answer.
   *
   * Two ways that happens, and BOTH present as an eternal spinner rather than an error,
   * because in each case nothing rejects — the request simply goes nowhere:
   *
   * 🔴 A DEAD SESSION. A restored-but-dead WalletConnect session is the worst state the app
   * can be in, because everything LOOKS fine: address set, balance rendered, button enabled —
   * and then the request is written to a closed socket, no prompt appears on the phone, and
   * there is not even an error to show.
   *
   * 🔴 AN UNAPPROVED CHAIN. A WalletConnect wallet silently DROPS requests for a chain outside
   * its approved session. Valora is Celo-only; the app defaults to Base; the session looks
   * healthy right up until the first `eth_sendTransaction` for Base vanishes. The effect below
   * normally follows the wallet onto a chain it did approve, but it is asynchronous and the
   * user can outrun it — so the last word belongs here, where nothing has been committed yet.
   *
   * Returns true when it is safe to proceed. Disconnects on a dead session so the Connect
   * button pairs fresh rather than restoring the same corpse.
   */
  // 🔴 RETURNS THE RESOLVED CHAIN, NOT JUST A BOOLEAN — A RESYNC WITHIN THIS CALL IS INVISIBLE TO
  // ITS CALLER OTHERWISE. `setActiveChain` schedules a state update for the NEXT render; it does
  // not rewrite the `activeChain` binding the caller already closed over earlier in the SAME
  // function execution. So a resync performed here would fix the chain for the click AFTER this
  // one and silently do nothing for the payment actually in flight — precisely the report ("it
  // didn't grab the changes yet") this function exists to close. Callers use the returned chain
  // for whatever guard checks come immediately after, instead of their own `activeChain` closure.
  const ensureWalletReachable = useCallback(async (): Promise<{ chain: any } | false> => {
    const live = await walletConnectSessionLive(wagmiConnector);
    if (live === false) {
      setStatus("Your wallet connection has dropped — tap Connect to reconnect, then try again.");
      setIsProcessing(false);
      try { disconnect(); } catch { /* best effort */ }
      localStorage.removeItem('abapay_connected');
      return false;
    }

    let resolvedChain = activeChain;

    // 🔴 ASK THE WALLET WHAT CHAIN IT IS ACTUALLY ON, RIGHT NOW — DON'T TRUST REACT STATE ALONE.
    //
    // "I switch chains and it sometimes complains the network isn't supported — like it didn't
    // grab the change yet." That is exactly what happens for an INJECTED wallet: the
    // WalletConnect check just below only ever constrains a WalletConnect session —
    // walletApprovedChainIds() reads null ("unknowable") for anything injected, so for a
    // MetaMask/Base-Account-shaped wallet this function did nothing at all to verify the chain
    // before proceeding. `activeChain` only updates when wagmi's OWN `chainChanged` listener
    // fires and that update propagates through the wagmi bridge — real, but not instantaneous,
    // and a payment attempted in the gap between switching in the wallet and that propagation
    // landing sees the OLD `activeChain`.
    //
    // `client.getChainId()` asks the wallet directly, at the moment it matters, and is the one
    // source neither wagmi's event timing nor React's render timing can make stale. A mismatch
    // means our state hasn't caught up yet — not that the wallet is on an unsupported network —
    // so it is resynced here rather than reported as an error. The guards that run right after
    // this function returns then see the CURRENT chain instead of a lagging one.
    if (client && resolvedChain) {
      try {
        const liveChainId = await client.getChainId();
        if (liveChainId !== resolvedChain.id) {
          const liveChain = [base, baseSepolia, celo, celoSepolia].find((c) => c.id === liveChainId);
          if (liveChain) {
            console.warn(`[wallet] activeChain (${resolvedChain.id}) was behind the wallet's real chain (${liveChainId}) — resynced to ${liveChain.name}.`);
            setActiveChain(liveChain); // for the NEXT render — resolvedChain is what THIS call uses
            resolvedChain = liveChain;
          }
          // An unrecognised chain ID is left for the balance/token guards below to report — this
          // function's job is only to correct a LAG, not to invent support for a chain we don't have.
        }
      } catch {
        // Couldn't ask — proceed on whatever `activeChain` already said, exactly as before this
        // check existed. A failed read is not evidence of anything.
      }
    }

    // null = unknowable (an injected wallet), which must read as "no constraint" — never as
    // "supports nothing", or every in-browser wallet would be blocked on a false negative.
    const approved = await walletApprovedChainIds(wagmiConnector);
    if (approved && resolvedChain && !approved.includes(resolvedChain.id)) {
      const usable = [base, baseSepolia, celo, celoSepolia].find((c) => approved.includes(c.id));
      setStatus(
        usable
          ? `Your wallet isn't connected to ${resolvedChain.name}. Switch AbaPay to ${usable.name} and try again.`
          : `Your wallet isn't connected to a network AbaPay supports. Reconnect it on Base or Celo.`,
      );
      setIsProcessing(false);
      // Nudge the app onto the chain the wallet actually agreed to, so the retry works.
      if (usable) setActiveChain(usable);
      return false;
    }

    // Reachable, on a chain it agreed to — or not a WalletConnect wallet at all. `resolvedChain`
    // carries any correction made above; falls back to the app's default only if there was never
    // an activeChain to begin with (shouldn't happen once connected, but keeps this total).
    return { chain: resolvedChain || (isMainnet ? base : baseSepolia) };
  }, [wagmiConnector, disconnect, activeChain, client, isMainnet]);

  const processBlockchainPayment = async () => {
    if (!address || !client) return setStatus("Connect Wallet First");
    const reach = await ensureWalletReachable();
    if (!reach) return;
    // See the matching note in processX402Payment — `reach.chain` is what that call just
    // verified against the wallet; `activeChain` here can still be one render behind it.
    if (!(await hasEnoughBalanceOnChain(reach.chain))) return setStatus(`Insufficient ${selectedToken.symbol} balance — you need ${cryptoToCharge} ${selectedToken.symbol}. Top up and try again.`);

    setIsProcessing(true);
    setStatus("Initiating Blockchain Escrow...");

            // ⚡ FIX: Add a safety flag to track if crypto left the wallet!
    let preflightHash = "";
    let realTxHash = "";
    let txHasBeenSigned = false; 
    let backendPayload: any = null; // ⚡ ADD THIS LINE HERE

    try {
      // 1. Network Sync
      //
      // 🔴 EVERY CALL HERE IS A WALLET ROUND-TRIP, AND NONE OF THEM HAD A TIMEOUT. Over
      // WalletConnect, `wallet_switchEthereumChain` and `wallet_addEthereumChain` are exactly
      // the requests a wallet is most likely to ignore rather than refuse — Valora drops
      // anything for a chain outside its approved session — so this block could hang before a
      // single payment prompt was ever raised, with the button spinning and nothing to catch.
      // 30s is generous for a chain switch, which needs at most one tap.
      try {
        const currentChainId = await withWalletTimeout(client.getChainId(), 30_000);
        if (currentChainId !== activeChain.id) {
            await withWalletTimeout(client.switchChain({ id: activeChain.id }), 30_000);
            await new Promise(resolve => setTimeout(resolve, 1500));
        }
      } catch (switchError) {
        // A wallet that won't switch may still accept the chain being added. If THAT is also
        // ignored, stop and say so: sending a transaction for a chain the wallet has not
        // acknowledged is how a payment disappears with no prompt and no error.
        try {
          await withWalletTimeout(client.addChain({ chain: activeChain }), 30_000);
          await new Promise(resolve => setTimeout(resolve, 1500));
        } catch {
          setStatus(`Your wallet didn't switch to ${activeChain.name}. Open it, switch network manually, then try again — or pick a network your wallet supports.`);
          setIsProcessing(false);
          return; // 🛑 Do not send a transaction the wallet is going to ignore.
        }
      }

      const valueInWei = parseUnits(cryptoToCharge, selectedToken.decimals);

      let tokenAddress;
      if (activeChain.id === base.id) tokenAddress = (selectedToken as any).baseMainnet || selectedToken.mainnet;
      else if (activeChain.id === baseSepolia.id) tokenAddress = (selectedToken as any).baseSepolia || selectedToken.sepolia;
      else if (activeChain.id === celo.id) tokenAddress = (selectedToken as any).celoMainnet || selectedToken.mainnet;
      else tokenAddress = (selectedToken as any).celoSepolia || selectedToken.sepolia;

      const publicClient = createPublicClient({ chain: activeChain, transport: http(undefined, { fetchOptions: { cache: 'no-store' } }), pollingInterval: 4000 });
      const txConfig: any = { account: address as `0x${string}` };
      if (environment === 'MINIPAY') txConfig.feeCurrency = GAS_CURRENCY as `0x${string}`; 

      setStatus("Verifying permissions...");
      const currentAllowance = await publicClient.readContract({ address: tokenAddress as `0x${string}`, abi: ERC20_ABI, functionName: 'allowance', args: [address, ABAPAY_CONTRACT], blockTag: 'latest' }) as bigint;

      // ==========================================
      // ⚡ BASE GAS SPONSORSHIP (PAYMASTER) CAPABILITY CHECK ⚡
      // Only smart-account connections (e.g. Coinbase Smart Wallet / Base Account) advertise
      // EIP-5792 `paymasterService` support. Regular EOA wallets (MetaMask, WalletConnect,
      // Valora) simply won't have this capability, and we transparently fall back to the
      // normal self-paid flow further down — no behavior change for those wallets.
      // ==========================================
      const isBaseChain = activeChain.id === base.id || activeChain.id === baseSepolia.id;
      const paymasterProxyUrl = typeof window !== 'undefined' ? `${window.location.origin}/api/paymaster` : undefined;
      let usingBasePaymaster = false;

      // 🔴 AND IT MUST NOT BE ASKED OF A WALLET THAT WON'T ANSWER. `wallet_getCapabilities` is
      // an ordinary WalletConnect request, so a session that never negotiated it drops the call
      // on the floor — no prompt, no error, nothing back — and this `await` had no timeout,
      // which would strand the payment on a spinner BEFORE the user was ever asked to approve
      // anything. Ask only when the session says it will answer (or the wallet is in-page, where
      // the question is answered in-process), and bound it either way.
      const capabilitiesNegotiated = !isRemoteWallet
        || ((await walletApprovedMethods(wagmiConnector))?.includes('wallet_getCapabilities') ?? false);

      if (isBaseChain && paymasterProxyUrl && capabilitiesNegotiated && typeof client.getCapabilities === 'function') {
          try {
              const capabilities: any = await withWalletTimeout(client.getCapabilities({ account: address as `0x${string}` }), 8_000);
              const chainCaps = capabilities?.[activeChain.id] || capabilities?.[`0x${activeChain.id.toString(16)}`];
              usingBasePaymaster = !!chainCaps?.paymasterService?.supported;
          } catch (capError) {
              usingBasePaymaster = false; // Wallet doesn't support capability discovery — fall back safely
          }
      }

      const { backendPayload: builtPayload, vtpassServiceID, payloadBillersCode, uiCategory, displayNetwork, currentBlockchainName } = buildBackendPayload();
      backendPayload = builtPayload;

      setStatus(walletApprovalPrompt("Please approve the transaction"));

            // ==========================================
      // ⚡ STRICT FIREWALL: ISOLATED APPROVAL BLOCK
      // Skipped entirely when we're routing through the sponsored paymaster batch below —
      // in that case the approve call (if needed) travels inside the same sponsored sendCalls.
      // ==========================================
      if (!usingBasePaymaster && currentAllowance < valueInWei) {
          setStatus("Awaiting token approval...");
          try {
              const appHash = await withWalletTimeout(client.writeContract({
                  chain: activeChain,
                  address: tokenAddress as `0x${string}`,
                  abi: ERC20_ABI,
                  functionName: 'approve',
                  args: [ABAPAY_CONTRACT, parseUnits("100000", selectedToken.decimals)],
                  ...txConfig,
                  dataSuffix: celoAttributionSuffix(activeChain), // Celo attribution only; no-op on Base
              }));
              setStatus("Confirming approval on-chain...");
              await publicClient.waitForTransactionReceipt({ hash: appHash, confirmations: 1 });
              
              // Give the RPC nodes 1 second to update the allowance state globally
              await new Promise(resolve => setTimeout(resolve, 1000));
              
          } catch (appError: any) {
              // A wallet APP that never answered is not a user who said no. Over WalletConnect
              // a timeout here means the request didn't reach the phone — the relay socket
              // died under a restored session — and calling that "Approval Cancelled" sends
              // the user looking for a prompt they declined and never saw. Name the real
              // problem and drop the session so Connect pairs fresh instead of restoring the
              // same dead one. Nothing was signed at this point, so there is no intent to
              // clean up.
              if (appError instanceof WalletTimeoutError && !isInjectedWallet) {
                  setStatus("Your wallet never received the approval request. Tap Connect to reconnect your wallet, then try again.");
                  try { disconnect(); } catch { /* best effort */ }
                  localStorage.removeItem('abapay_connected');
                  setIsProcessing(false);
                  return;
              }
              // User rejected approval, wallet glitched, OR withWalletTimeout gave up waiting
              // on an in-browser wallet — that last case has no `.shortMessage` (it's a plain
              // Error, not a viem one), so fall back to `.message` rather than mislabeling a
              // genuine timeout as "User rejected.".
              // Stop everything. Do NOT touch the database.
              setStatus(`Approval Cancelled: ${appError.shortMessage?.slice(0, 60) || appError.message?.slice(0, 80) || "User rejected."}`);
              setIsProcessing(false);
              return; // 🛑 EXIT FUNCTION IMMEDIATELY
          }
      }

      // ==========================================
      // ⚡ PREFLIGHT INTENT (Only runs if approval is successful or wasn't needed)
      // ==========================================
      const realNonce = await publicClient.getTransactionCount({ address: address as `0x${string}`, blockTag: 'latest' });

      // 3. TRUE PRE-FLIGHT INTENT
      preflightHash = `preflight_${address}_${Date.now()}`;
      backendPayload.txHash = preflightHash;

      setStatus("Securing transaction intent...");
      const intentRes = await fetch('/api/pay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...backendPayload, intent_only: true }) });
      // 🔴 THE BUG THIS FIXES: this response used to be discarded entirely — the server's
      // duplicate-electricity check (and any other intent_only rejection) had no way to stop
      // anything, since the wallet was prompted to sign regardless of what the server said.
      // That made the duplicate guard purely advisory even when the SERVER enforced it — the
      // enforcement never reached the user. Now a rejection here stops the flow before the
      // wallet is ever prompted, same as the approval-cancelled branch above.
      if (!intentRes.ok) {
        let intentMsg = "Couldn't start this payment. Please try again.";
        try { const intentJson = await intentRes.json(); if (intentJson?.message) intentMsg = intentJson.message; } catch {}
        setStatus(intentMsg);
        setIsProcessing(false);
        return; // 🛑 EXIT FUNCTION IMMEDIATELY — nothing was signed, nothing to clean up
      }

      // 🔴 THE BUG THIS FIXES: hasEnoughBalanceOnChain() only ran ONCE, before the approve
      // step — but on a chain where gas can be paid from the SAME token balance (Celo's
      // feeCurrency mechanism — visible on-chain as small internal token transfers alongside
      // the main one), the approve() transaction just above can itself consume a sliver of
      // that balance. A user paying with close to their full balance passed the initial
      // check, then reverted on-chain with "ERC20: transfer amount exceeds balance" once
      // approve's own gas cost ate into an already-thin margin. Re-checking fresh right
      // before the actual signed payBill call catches that instead of burning more gas on a
      // transaction that's already doomed to revert.
      if (!(await hasEnoughBalanceOnChain())) {
          setStatus(`Insufficient ${selectedToken.symbol} balance — a prior step used some of it for network fees. You need ${cryptoToCharge} ${selectedToken.symbol}. Top up and try again.`);
          setIsProcessing(false);
          return;
      }

      setStatus(walletApprovalPrompt("Please sign the final payment"));

      const callData = encodeFunctionData({
          abi: ABAPAY_ABI, 
          functionName: 'payBill', 
          args: [tokenAddress, vtpassServiceID, payloadBillersCode, valueInWei] 
      });

      // ⚡ FIX 1: Restored your original, perfect builder code formatting
      const builderCodeSuffix = "0x62635f6a63757a316632330b0080218021802180218021802180218021";
      const attributedData = `${callData}${builderCodeSuffix.replace('0x', '')}` as `0x${string}`;

            let rawHash;

      // ==========================================
      // ⚡ SPONSORED PATH: Base + paymaster-capable wallet
      // Batches (approve if needed) + payBill into a single sponsored EIP-5792 call.
      // ==========================================
      if (usingBasePaymaster) {
          let callsId: string | undefined;

          try {
              const calls: any[] = [];
              if (currentAllowance < valueInWei) {
                  calls.push({
                      to: tokenAddress as `0x${string}`,
                      data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [ABAPAY_CONTRACT, parseUnits("100000", selectedToken.decimals)] }),
                  });
              }
              calls.push({ to: ABAPAY_CONTRACT as `0x${string}`, data: attributedData });

              setStatus(walletApprovalPrompt("Please sign the sponsored transaction"));
              const sendCallsResult: any = await withWalletTimeout(client.sendCalls({
                  account: address as `0x${string}`,
                  chain: activeChain,
                  calls,
                  capabilities: { paymasterService: { url: paymasterProxyUrl! } },
              }));
              callsId = typeof sendCallsResult === 'string' ? sendCallsResult : sendCallsResult?.id;
              if (!callsId) throw new Error("Wallet did not return a calls identifier.");
          } catch (sendCallsError: any) {
              // ⚡ NOTHING WAS BROADCAST — the wallet/paymaster rejected this before it ever left
              // the device (e.g. user declined, capability check was stale, paymaster policy
              // rejected the batch). It is genuinely safe to fall back to the normal self-paid flow.
              console.log("Sponsored payment could not be submitted, falling back to self-paid gas:", sendCallsError);
              usingBasePaymaster = false;
          }

          if (callsId) {
              // ⚡ THE WALLET ACCEPTED THE CALLS — TREAT THIS AS "SIGNED" FROM HERE ON. ⚡
              // Whatever happens next (lost network, RPC hiccup, slow bundler), we must NEVER
              // resubmit a second transaction and must NEVER wipe the pending intent: the
              // sponsored payment is very likely already broadcast/in-flight on-chain. Setting
              // txHasBeenSigned here means the outer catch block will preserve the pending
              // record instead of cancelling it, and the webhook's existing abandoned-intent
              // rescue (matches by wallet address) will complete the vend once Alchemy detects
              // the transaction — exactly the same safety net already used for a normal
              // "signed but the app crashed before confirming" scenario.
              txHasBeenSigned = true;

              setStatus("Confirming sponsored transaction on-chain...");
              let callsStatus: any = null;
              let pollingError: any = null;

              try {
                  for (let i = 0; i < 30; i++) {
                      callsStatus = await client.getCallsStatus({ id: callsId });
                      const statusValue = callsStatus?.status;
                      const isConfirmed = statusValue === 'CONFIRMED' || statusValue === 'success' || statusValue === 200;
                      if (isConfirmed && callsStatus?.receipts?.length) break;
                      await new Promise(resolve => setTimeout(resolve, 2000));
                  }
              } catch (pollError: any) {
                  pollingError = pollError; // e.g. network dropped mid-confirmation
              }

              const receiptHash = callsStatus?.receipts?.[callsStatus.receipts.length - 1]?.transactionHash;

              if (!receiptHash) {
                  // Either the poll loop errored (network/RPC dropped) or genuinely timed out
                  // without confirming. Either way: do NOT resubmit. The payment was already
                  // sent to the wallet/bundler — surface this honestly and stop here.
                  console.log("Could not confirm sponsored transaction from this device:", pollingError);
                  setStatus("Payment sent! Confirming in the background — check History shortly.");
                  showToast("Processing", "Your sponsored payment was sent. If your connection drops now, don't retry — check History in a minute; we'll finish confirming it in the background.", "success");
                  setIsProcessing(false);
                  return; // 🛑 EXIT: nothing more to do from this device right now
              }

              rawHash = receiptHash;
          }
      }

      // ==========================================
      // ⚡ NORMAL SELF-PAID PATH (all Celo wallets, and any Base wallet without paymaster support)
      // ==========================================
      if (!rawHash) {
          if (isBaseChain) {
              // 🔴 THIS WAS THE ONE WALLET CALL IN THE FILE WITH NO TIMEOUT — and Base is now
              // the default chain, so it is the path most users take. A wallet that never
              // answers (a backgrounded WalletConnect app, a wallet that swallowed the request)
              // left the button spinning indefinitely with nothing to catch. Same 90s budget as
              // every other wallet interaction here.
              rawHash = await withWalletTimeout(client.sendTransaction({
                  to: ABAPAY_CONTRACT,
                  data: attributedData,
                  account: address as `0x${string}`,
                  ...txConfig // ⚡ FIX 2: Removed forced nonce so wallets don't block the transaction
              }));
          } else {
              rawHash = await withWalletTimeout(client.writeContract({
                  address: ABAPAY_CONTRACT,
                  abi: ABAPAY_ABI,
                  functionName: 'payBill',
                  args: [tokenAddress, vtpassServiceID, payloadBillersCode, valueInWei],
                  ...txConfig, // ⚡ FIX 2: Removed forced nonce
                  dataSuffix: celoAttributionSuffix(activeChain), // Celo Builders attribution (Celo path only)
              }));
          }
      }


            // ⚡ CRITICAL FIX: The transaction is on the blockchain! Lock the safety flag! ⚡
      txHasBeenSigned = true;
      realTxHash = rawHash.toLowerCase();  
      backendPayload.txHash = realTxHash;

      // 5. WAIT FOR BLOCKCHAIN
      setStatus("Confirming on blockchain... Please hold.");
      // ⚡ CHANGED txHashString TO realTxHash BELOW ⚡
      const receipt = await publicClient.waitForTransactionReceipt({ hash: realTxHash as `0x${string}`, confirmations: 1 });

      // ⚡ CRITICAL FRONTEND FIX: Verify it didn't revert before calling the backend ⚡
      if (receipt.status !== 'success') {
          throw new Error("Transaction failed on the blockchain. Your funds were not deducted.");
      }

      setStatus(uiCategory === 'BANK' ? `Payment Secured! Sending your transfer...` : `Payment Secured! Vending in progress...`);

      const res = await fetch('/api/pay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...backendPayload, intent_only: false, preflight_hash: preflightHash }) });
      const finalStatus = await res.json();

      handleVendResult(finalStatus, realTxHash, backendPayload, uiCategory, displayNetwork, payloadBillersCode, currentBlockchainName);

      const balanceWei = await publicClient.readContract({ address: tokenAddress as `0x${string}`, abi: ERC20_ABI, functionName: 'balanceOf', args: [address] });
      setWalletBalance(parseFloat(formatUnits(balanceWei as bigint, selectedToken.decimals)).toFixed(4));

    } catch (e: any) { 
        // ⚡ THE FATAL FLAW FIX: Did the user reject, or did the network timeout? ⚡
        if (!txHasBeenSigned) {
            // SAFE: User rejected the wallet popup BEFORE signing (or withWalletTimeout gave up
            // on a wallet that never responded — a plain Error with no `.shortMessage`, so fall
            // back to `.message` rather than mislabeling a timeout as "User rejected.").
            // A timeout on a wallet APP is usually a request that never arrived rather than a
            // user who ignored it — the relay socket having quietly died under a restored
            // session. Say what to do about it instead of reporting a bare timeout, and drop
            // the session so Connect pairs fresh rather than restoring the same dead one.
            if (e instanceof WalletTimeoutError && !isInjectedWallet) {
              setStatus("Your wallet never received the request. Tap Connect to reconnect your wallet, then try again.");
              try { disconnect(); } catch { /* best effort */ }
              localStorage.removeItem('abapay_connected');
              if (preflightHash) {
                fetch('/api/pay', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ txHash: preflightHash, cancel_intent: true }),
                }).catch(() => {});
              }
              return;
            }
            setStatus(`Cancelled: ${e.shortMessage?.slice(0, 60) || e.message?.slice(0, 80) || "User rejected."}`);
            if (preflightHash) {
                 fetch('/api/pay', { 
                     method: 'POST', 
                     headers: { 'Content-Type': 'application/json' }, 
                     body: JSON.stringify({ txHash: preflightHash, cancel_intent: true }) 
                 }).catch(()=>{});
            }
        } else {
            // CRISIS AVERTED: Crypto left the wallet, but the app crashed/timed out!
            // Force the real hash into the database so your Admin panel can see it!
            setStatus("Network slow. Securing receipt to database..."); 
                        if (preflightHash && realTxHash && backendPayload) {
                 fetch('/api/pay', {  
                     method: 'POST', 
                     headers: { 'Content-Type': 'application/json' }, 
                     // We pass the payload again to force the database to overwrite the fake hash with the real one
                     body: JSON.stringify({ ...backendPayload, intent_only: false, preflight_hash: preflightHash }) 
                 }).catch(()=>{});
            }
            showToast("Transaction Processing", "Your payment was sent but the network is slow. Check your History tab in a minute.", "success");
        }
        } finally { 
        setIsProcessing(false); 
    }
}; // <--- THIS IS THE MISSING BRACKET!

  // ⚡ x402 SETTLEMENT (main app only, Celo + USDC) — see README "x402 settlement".
  //
  // Deliberately much simpler than processBlockchainPayment above: there's no approval step,
  // no preflight-intent row, no manual writeContract/waitForTransactionReceipt — the
  // facilitator submits and confirms the payment inside fetchWithX402Payment itself. Since
  // settlement is atomic within that single request, there's no "signed but unconfirmed"
  // state to rescue in the catch block, unlike the contract-call path.
  const processX402Payment = async () => {
    // `client` is required now that the signature is taken from the app's own wallet client
    // rather than a parallel SDK — same precondition the contract-call path has always had.
    if (!address || !client) return setStatus("Connect Wallet First");
    const reach = await ensureWalletReachable();
    if (!reach) return;
    // 🔴 `reach.chain`, NOT `activeChain`, FOR EVERYTHING IMMEDIATELY BELOW.
    //
    // ensureWalletReachable() may have just resynced the chain against what the wallet is
    // actually on — but that resync is a setState, visible on the NEXT render, not to this
    // function's own `activeChain` closure captured back when it started running. Reading
    // `activeChain` here would be exactly the staleness this whole check exists to close:
    // "I switch chains and it sometimes says the network isn't supported — like it didn't grab
    // the change yet." `reach.chain` is the answer that call just verified, not React's copy.
    const payChain = reach.chain;
    // Celo: USDC + USD₮ (both have EIP-3009). Base: USDC only (Base USD₮ has no
    // transferWithAuthorization) and only when the Coinbase-facilitator rail is enabled.
    const onCelo = payChain?.id === celo.id || payChain?.id === celoSepolia.id;
    const onBase = payChain?.id === base.id || payChain?.id === baseSepolia.id;
    const baseX402Enabled = process.env.NEXT_PUBLIC_BASE_X402_ENABLED !== 'false';
    // ⚡ Deliberately generic wording — x402 vs. the normal contract-call rail is an internal
    // routing decision (see `useX402` below), never something the user chose or should see.
    // A USDm/USDT transaction on Celo looks identical to the user whichever rail settles it.
    if (!onCelo && !(onBase && baseX402Enabled)) return setStatus("This network isn't supported for this token yet.");
    // 🔴 A SECOND COPY OF THE TOKEN LIST LIVED HERE AND WENT STALE. The rail decision at the pay
    // button was updated for USA₮; this guard was not, so a Celo USA₮ payment was routed to x402
    // and then refused by x402 itself with "This token isn't supported on this network yet." —
    // reported exactly that way, on a token whose EIP-3009 domain had been verified on-chain and
    // whose vault support was already set.
    //
    // Kept as one list rather than two: CELO_X402_TOKENS is what both this guard and the rail
    // decision read, so the next token can only be added in one place.
    if (onCelo && !CELO_X402_TOKENS.includes(selectedToken.symbol)) return setStatus("This token isn't supported on this network yet.");
    if (onBase && selectedToken.symbol !== "USDC") return setStatus("This token isn't supported on this network yet.");
    // 🔴 Was missing entirely — x402 payments failed at settlement on a low balance instead
    // of being caught here first.
    if (!(await hasEnoughBalanceOnChain(payChain))) return setStatus(`Insufficient ${selectedToken.symbol} balance — you need ${cryptoToCharge} ${selectedToken.symbol}. Top up and try again.`);

    setIsProcessing(true);
    // 🔴 WAS "Confirming on blockchain... Please hold." — SET BEFORE ANYTHING WAS SIGNED.
    //
    // x402 needs an EIP-712 `transferWithAuthorization` signature from the wallet before the
    // facilitator can settle anything, so at this point the app is waiting on the USER, not on
    // the chain. Claiming otherwise is what made the Valora case unreadable: the wallet is a
    // separate app, nothing brings it to the foreground, and the screen insisted the
    // blockchain was already working on a payment that had not been authorised yet. Anyone
    // would sit and wait. Name the thing we are actually waiting for.
    setStatus(walletApprovalPrompt("Approve this payment"));

    const { backendPayload, uiCategory, displayNetwork, payloadBillersCode, currentBlockchainName } = buildBackendPayload();

    try {
      // 🔴 AND IT COULD HANG FOREVER. The contract-call path wraps its wallet interaction in
      // withWalletTimeout; this one had nothing, so a signature request that never reached the
      // wallet — the exact WalletConnect-to-a-backgrounded-mobile-app case — left the user on
      // a spinner with no error, no retry and no explanation, indefinitely. Same 90s budget
      // and the same message as every other wallet interaction in this file.
      //
      // Signed by `client` — the same wallet connection every contract call in this file uses.
      // It used to go through thirdweb's separate wallet stack, which had to establish itself
      // first and showed up over WalletConnect as an extra connection prompt before anything
      // was even signed. See src/lib/x402Pay.ts.
      //
      // The 90s budget is handed to the SIGNATURE only, not to the whole payment: once the user
      // has signed, the facilitator's settlement must be allowed to finish. Timing that out
      // would report "your wallet didn't respond" about a payment already being settled.
      //
      // Keeping the budget off the settle request is also what makes WalletTimeoutError mean
      // one exact thing — the wallet never answered, so nothing was ever sent to settle — which
      // is why the catch below can fall back to the contract call on it without risking a
      // double charge. See the WalletTimeoutError branch there.
      const finalStatus: any = await payWithX402({
        url: '/api/pay/x402',
        body: backendPayload,
        client,
        account: address as `0x${string}`,
        expectedChainId: activeChain?.id,
        wrapSignature: (p) => withWalletTimeout(p),
        // ⚡ ONE SIGNATURE ON THIS RAIL. payWithX402 defaults to a single attempt, so no second
        // prompt is raised here — if the payment cannot be completed, the catch below hands the
        // bill to the contract call instead.
        //
        // 🔴 WHY THE AUTOMATIC RE-SIGN WAS TAKEN BACK OUT. It was added to automate the
        // workaround people had found by hand ("cancel and retry the same x402 and it goes
        // through"), which was sound only while first attempts failed OCCASIONALLY. Once one
        // started failing reproducibly, the rescue became a second wallet prompt on EVERY
        // payment — indistinguishable, from the user's side, from an app that ignored the first
        // one, which is exactly the suspicion this flow has spent months trying to shake.
        //
        // The handler is kept because the capability is still there behind maxAttempts, and if it
        // is ever turned back on the second prompt must be explained rather than just appearing.
        onRetry: (reason) => {
          console.warn('[x402] Facilitator refused; re-signing before falling back:', reason);
          setStatus(walletApprovalPrompt('That payment was turned down — approve it once more'));
        },
      });

      // The server's duplicate-electricity check runs BEFORE the facilitator settles the x402
      // payment (see /api/pay/x402's placement comment), so a DUPLICATE response here means
      // nothing was charged — handled separately from a real vend failure below, since running
      // it through handleVendResult would log a fake "DUPLICATE" entry into the user's payment
      // history for a payment that never actually happened.
      if (finalStatus?.status === 'DUPLICATE') {
        setStatus(finalStatus.message || "You already paid this today.");
        showToast("Duplicate Payment", finalStatus.message || "You already paid this today.", "error");
        return;
      }

      // Unlike the contract path, the browser never sees this transaction directly — the
      // facilitator submits it, not the connected wallet — so the server hands it back.
      const realTxHash = (finalStatus.tx_hash || `x402_${Date.now()}`).toLowerCase();

      handleVendResult(finalStatus, realTxHash, backendPayload, uiCategory, displayNetwork, payloadBillersCode, currentBlockchainName);

      const tokenAddress = getAgentTokenAddress();
      if (tokenAddress) {
        const publicClient = createPublicClient({ chain: activeChain, transport: http() });
        const balanceWei = await publicClient.readContract({ address: tokenAddress as `0x${string}`, abi: ERC20_ABI, functionName: 'balanceOf', args: [address] });
        setWalletBalance(parseFloat(formatUnits(balanceWei as bigint, selectedToken.decimals)).toFixed(4));
      }
    } catch (e: any) {
      // 🔴 THE BUG THIS FIXES: an x402 settlement failure (Celo's facilitator briefly
      // unreachable, its own backend down, whatever) simply failed the payment outright —
      // "Payment failed with status 402" — with no way to complete it until the facilitator
      // recovered, even though the standard on-chain flow was working fine the whole time.
      //
      // x402 settlement is atomic: the facilitator either actually moves funds via the
      // payer's signed EIP-3009 authorization (a real success, handled above — never reaches
      // this catch) or nothing happens at all. So ANY failure here is safe to retry via the
      // completely independent contract-call flow: it's a different signing mechanism
      // entirely (a real payBill() transaction, not an EIP-3009 authorization), so whatever
      // caused x402 to fail cannot recur there.
      // 🔴 A SILENT WALLET USED TO END THE PAYMENT HERE. IT IS NOW THE FALLBACK'S CUE.
      //
      // This branch stopped dead, on the reasoning that the signature might still arrive and
      // settle a moment later, so starting the contract-call flow risked paying twice. That was
      // TRUE of the thirdweb client, which owned the settle request and could complete it after
      // our timeout fired. It has not been true since x402 moved to src/lib/x402Pay.ts: the
      // settle POST is made by that function, on the line after the signature is awaited, so a
      // timeout unwinds it and no X-PAYMENT header is ever sent. A signature that shows up late
      // has nobody left to hand it to the facilitator — it goes nowhere.
      //
      // Which makes this the single most important line for Valora. Valora renders the x402
      // typed data as "Verify wallet", announces "Connection to AbaPay was successful!" when the
      // user taps Allow, and returns NOTHING. Refusing to fall back left that user on a dead
      // payment; the old workaround was to keep Valora off the x402 rail entirely, which is why
      // "the Base and Celo x402 route are both ignored in Valora". Now the rail is tried, and
      // when the wallet does not answer, the contract call takes over by itself.
      if (e instanceof WalletTimeoutError) {
        console.error('[x402] Wallet never returned a signature; nothing was sent to settle — falling back to the contract call.');
        setStatus("Your wallet didn't return the fast-payment approval — switching to the standard one. It will ask you to approve again.");
        await processBlockchainPayment();
        return; // processBlockchainPayment manages its own isProcessing/status lifecycle
      }

      // 🔴 A REJECTION IS AN ANSWER, NOT A FAULT. Falling back here meant that declining the
      // signature immediately raised a SECOND, different wallet prompt for the same bill —
      // observed in the wild: the user dismissed a request their wallet had flagged as
      // malicious, the spinner carried on regardless, and another approval appeared. That
      // reads as an app ignoring "no" and asking again, which is exactly the behaviour a
      // suspicious user is watching for. Stop when the user says stop.
      if (isUserRejection(e)) {
        setStatus("Payment cancelled.");
        return;
      }

      // 🔴 SETTLED, THEN SOMETHING ELSE WENT WRONG — NEVER FALL BACK.
      //
      // A failure carrying a tx_hash means the facilitator ALREADY took the money; the server
      // has recorded it and queued a refund (see /api/pay/x402's "write the row FIRST" note).
      // The old code could not see this — thirdweb's wrapper threw a bare Error with no body —
      // so it went on to raise a SECOND, real payment prompt for a bill the user had already
      // paid. That is a double charge, and it is the whole reason payWithX402 surfaces
      // `settled` instead of just a message.
      if (e instanceof X402PaymentError && e.settled) {
        console.error('[x402] Settled but not delivered — refund queued, NOT falling back:', e.message, e.txHash);
        setStatus(e.message || "Your payment went through but the bill couldn't be delivered — a refund is on its way.");
        showToast("Payment Received, Bill Not Delivered", "Your payment settled but we couldn't complete the purchase. A refund has been queued automatically — check your History tab.", "error");
        return;
      }

      // Nothing moved, so the contract-call rail is a genuinely safe second attempt — but it is
      // a WHOLE SECOND PAYMENT FLOW, with its own approval and its own send. Saying so is the
      // difference between "why is my wallet asking me again?" and an expected retry.
      console.error('[x402] Settlement failed, falling back to the standard on-chain flow:', e.message);
      setStatus("Couldn't use the fast payment method — switching to the standard one. Your wallet will ask you to approve once more.");
      await processBlockchainPayment();
      return; // processBlockchainPayment manages its own isProcessing/status lifecycle
    } finally {
      setIsProcessing(false);
    }
  };

  useEffect(() => { if (status && !isProcessing) { const timer = setTimeout(() => setStatus(""), 5000); return () => clearTimeout(timer); } }, [status, isProcessing]);

  // ⚡ THE CONNECT-ERROR BANNER TIMES OUT TOO — IT USED TO SIT ON SCREEN UNTIL DISMISSED BY HAND.
  //
  // Every `setConnectError(...)` across the connect flow (declined, unreachable, no connector,
  // Valora needing a fresh session, and more) fed one banner that never cleared itself. Once one
  // fired, it stayed exactly as written — "Verifying your wallet was cancelled..." — until the
  // NEXT connect attempt overwrote or cleared it, which reads as the app being stuck on an old
  // message rather than a text banner that already did its job. Same rule the `status` line
  // above already uses: long enough to actually read (10s — this one carries more to read than a
  // one-line status), gone on its own after that. A brand new error arriving mid-countdown
  // restarts the clock rather than racing the old timer to clear it early.
  useEffect(() => { if (connectError) { const timer = setTimeout(() => setConnectError(null), 10_000); return () => clearTimeout(timer); } }, [connectError]);

  // ⚡ DeAI AGENT ALLOWANCE (AbaPayV3) ⚡
  //
  // Two on-chain transactions, both signed BY THE USER from their own wallet:
  //   1. ERC-20 approve(AbaPay, amount)      — lets the contract move the tokens at all
  //   2. setSpendingAllowance(token, amount) — the cap the agent is bound by
  //
  // The cap lives ON-CHAIN. Our backend cannot raise it, and a compromised relayer key can
  // never spend beyond it. Setting it to 0 revokes agent spending instantly.
  const AGENT_ABI = useMemo(() => ([
    { inputs: [{ name: 'tokenAddress', type: 'address' }, { name: 'amount', type: 'uint256' }], name: 'setSpendingAllowance', outputs: [], stateMutability: 'nonpayable', type: 'function' },
    { inputs: [{ name: 'user', type: 'address' }, { name: 'tokenAddress', type: 'address' }], name: 'remainingAllowance', outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  ] as const), []);

  // Resolve the selected token's address on the ACTIVE chain (mirrors the payment flow).
  const getAgentTokenAddress = useCallback((chainOverride?: any): string | undefined => {
    const chain = chainOverride || activeChain;
    if (!chain) return undefined;
    if (chain.id === base.id) return (selectedToken as any).baseMainnet || selectedToken.mainnet;
    if (chain.id === baseSepolia.id) return (selectedToken as any).baseSepolia || selectedToken.sepolia;
    if (chain.id === celo.id) return (selectedToken as any).celoMainnet || selectedToken.mainnet;
    return (selectedToken as any).celoSepolia || selectedToken.sepolia;
  }, [activeChain, selectedToken]);

  // ⚡ AGENT HUB — INDEPENDENT CHAIN/TOKEN RESOLUTION ⚡
  //
  // Deliberately separate from activeChain/selectedToken/getAgentTokenAddress above (which
  // track the main Pay tab's selector and are used elsewhere on the page, e.g. refreshing
  // wallet balance after an x402 payment). The Agent Hub lets the user pick a chain/token to
  // approve an allowance for that's independent of whatever the Pay tab's selector happens
  // to be set to — approving USDC on Base must never silently depend on the Pay tab
  // currently showing USD₮ on Celo, which is exactly the bug this replaces.
  const resolveAgentChain = useCallback((chainName: 'CELO' | 'BASE') => {
    if (chainName === 'BASE') return isMainnet ? base : baseSepolia;
    return isMainnet ? celo : celoSepolia;
  }, [isMainnet]);

  const resolveAgentContractFor = useCallback((chainName: 'CELO' | 'BASE'): `0x${string}` | undefined => {
    if (chainName === 'BASE') return (process.env.NEXT_PUBLIC_ABAPAY_BASE_ADDRESS || process.env.NEXT_PUBLIC_ABAPAY_ADDRESS) as `0x${string}`;
    return (process.env.NEXT_PUBLIC_ABAPAY_CELO_ADDRESS || process.env.NEXT_PUBLIC_ABAPAY_ADDRESS) as `0x${string}`;
  }, []);

  const resolveAgentTokenFor = useCallback((tokenSymbol: string, chainName: 'CELO' | 'BASE'): { address: string; decimals: number } | undefined => {
    const token = (SUPPORTED_TOKENS as any[]).find((t: any) => t.symbol === tokenSymbol);
    if (!token) return undefined;
    const addr = chainName === 'BASE'
      ? (isMainnet ? (token.baseMainnet || token.mainnet) : (token.baseSepolia || token.sepolia))
      : (isMainnet ? (token.celoMainnet || token.mainnet) : (token.celoSepolia || token.sepolia));
    if (!addr) return undefined;
    return { address: addr, decimals: token.decimals };
  }, [isMainnet]);

  // Called by AgentHub whenever its own chain/token selection changes (including on mount),
  // so the displayed "Agent can spend up to..." always reflects whatever combo is currently
  // selected THERE, not the Pay tab's selector.
  const checkAgentAllowanceFor = useCallback(async (tokenSymbol: string, chainName: 'CELO' | 'BASE'): Promise<string | null> => {
    if (!address) { setAgentAllowance(null); return null; }
    const contract = resolveAgentContractFor(chainName);
    const tokenInfo = resolveAgentTokenFor(tokenSymbol, chainName);
    if (!contract || !tokenInfo) { setAgentAllowance(null); return null; }
    try {
      const pc = createPublicClient({ chain: resolveAgentChain(chainName), transport: http() });
      const raw = await pc.readContract({
        address: contract,
        abi: AGENT_ABI,
        functionName: 'remainingAllowance',
        args: [address as `0x${string}`, tokenInfo.address as `0x${string}`],
      }) as bigint;
      const formatted = formatUnits(raw, tokenInfo.decimals);
      setAgentAllowance(formatted);
      return formatted;
    } catch {
      // Contract may still be V1/V2 (no allowances) — treat as "agent payments not enabled".
      setAgentAllowance(null);
      return null;
    }
  }, [address, resolveAgentChain, resolveAgentContractFor, resolveAgentTokenFor, AGENT_ABI]);


  // ⚡ IN-APP AI CHAT: fill the form from a parsed request. The chat NEVER pays —
  // the user reviews and signs, exactly as they always have.
  const handleAIPrefill = (p: any) => {
    setActiveTab('pay');
    if (p.amountNgn) setNairaAmount(String(p.amountNgn));
    if (p.billersCode) setAccountNumber(p.billersCode);

    const cat = (p.serviceCategory || '').toUpperCase();
    if (cat === 'ELECTRICITY') {
      const svc = SERVICES.find(sv => sv.id === 'ELECTRICITY');
      if (svc) setActiveService(svc);
      if (p.serviceID) setElecProvider(p.serviceID);
      if (p.meterType === 'prepaid' || p.meterType === 'postpaid') setMeterType(p.meterType);
    } else if (cat === 'CABLE') {
      const svc = SERVICES.find(sv => sv.id === 'CABLE');
      if (svc) setActiveService(svc);
      if (p.serviceID) setCableProvider(p.serviceID);
    } else if (cat === 'DATA') {
      const svc = SERVICES.find(sv => sv.id === 'INTERNET');
      if (svc) setActiveService(svc);
      if (p.provider) setTelecomProvider(String(p.provider).toLowerCase());
    } else {
      const svc = SERVICES.find(sv => sv.id === 'AIRTIME');
      if (svc) setActiveService(svc);
      if (p.provider) setTelecomProvider(String(p.provider).toLowerCase());
    }
    setStatus('✅ Filled in from your request — review and tap Pay.');
  };

  const handleAINavigate = (tab: string) => {
    if (['pay', 'bank', 'education', 'history', 'agent'].includes(tab)) {
      handleTabSwitch(tab as any);
    }
  };

  // Returns a result (rather than throwing) so AgentHub can show its own local confirmation —
  // the shared `status` banner only renders inside the Pay tab's JSX, so a setStatus() call
  // made while the user is on the Agent Hub tab was previously invisible.
  //
  // tokenSymbol/chainName come from AgentHub's OWN selector, independent of the Pay tab's
  // selectedToken/activeChain — see the resolveAgentChain/etc comment above.
  const handleApproveAgentAllowance = async (amount: string, tokenSymbol: string, chainName: 'CELO' | 'BASE'): Promise<{ success: boolean; message: string }> => {
    // `client` (not wagmiWalletClient) — MiniPay and the Farcaster Mini App both bypass wagmi
    // entirely (see the environment detector below) and populate `client` from their own
    // provider instead, so wagmiWalletClient is undefined in those two environments even
    // though the wallet is genuinely connected. `client` is a superset: in the plain-web
    // case it's set FROM wagmiWalletClient (see the effect below), so this covers all three.
    if (!address || !client) { const m = "Connect your wallet first."; setStatus(m); return { success: false, message: m }; }
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt < 0) { const m = "Enter a valid amount."; setStatus(m); return { success: false, message: m }; }

    const tokenInfo = resolveAgentTokenFor(tokenSymbol, chainName);
    const contract = resolveAgentContractFor(chainName);
    if (!tokenInfo || !contract) { const m = `${tokenSymbol} isn't available on ${chainName}.`; setStatus(m); return { success: false, message: m }; }
    const targetChain = resolveAgentChain(chainName);

    setIsApprovingAgent(true);
    try {
      // Make sure the wallet is actually on the chain we're about to sign for — the user may
      // be approving a DIFFERENT chain here than whatever the Pay tab's wallet is currently on.
      const currentChainId = await client.getChainId();
      if (currentChainId !== targetChain.id) {
        setStatus(`Switching to ${chainName}...`);
        await client.switchChain({ id: targetChain.id });
      }

      const amountWei = parseUnits(amt.toFixed(tokenInfo.decimals), tokenInfo.decimals);
      const pc = createPublicClient({ chain: targetChain, transport: http() });

      // 1) ERC-20 approval (skipped when revoking, or when already sufficient).
      if (amt > 0) {
        const current = await pc.readContract({
          address: tokenInfo.address as `0x${string}`,
          abi: ERC20_ABI,
          functionName: 'allowance',
          args: [address as `0x${string}`, contract],
        }) as bigint;

        if (current < amountWei) {
          setStatus("Approve the token spend in your wallet...");
          const h = await withWalletTimeout(client.writeContract({
            chain: targetChain,
            address: tokenInfo.address as `0x${string}`,
            abi: ERC20_ABI,
            functionName: 'approve',
            args: [contract, amountWei],
            account: address as `0x${string}`,
            dataSuffix: celoAttributionSuffix(targetChain), // Celo attribution only; no-op on Base
          }));
          await pc.waitForTransactionReceipt({ hash: h, confirmations: 1 });
        }
      }

      // 2) The on-chain agent cap — this is the security boundary.
      setStatus(amt === 0 ? "Revoking agent access..." : "Setting your agent spend limit...");
      const hash = await withWalletTimeout(client.writeContract({
        chain: targetChain,
        address: contract,
        abi: AGENT_ABI,
        functionName: 'setSpendingAllowance',
        args: [tokenInfo.address as `0x${string}`, amountWei],
        account: address as `0x${string}`,
        dataSuffix: celoAttributionSuffix(targetChain), // Celo attribution only; no-op on Base
      }));
      await pc.waitForTransactionReceipt({ hash, confirmations: 1 });

      await checkAgentAllowanceFor(tokenSymbol, chainName);
      const successMsg = amt === 0 ? "Agent access revoked." : `Agent can now spend up to ${amt} ${tokenSymbol} on ${chainName}.`;
      setStatus(successMsg);
      return { success: true, message: successMsg };
    } catch (e: any) {
      // A cancelled signature is not an error to diagnose — this is a two-transaction flow, so
      // saying plainly which half was cancelled saves the user wondering whether the first one
      // still went through.
      if (isUserRejection(e)) {
        const cancelled = "Cancelled — nothing was changed.";
        setStatus(cancelled);
        return { success: false, message: cancelled };
      }
      console.error('Agent allowance failed:', e);
      const errMsg = e?.shortMessage?.slice(0, 60) || e?.message?.slice(0, 80) || "Could not set the agent limit. Is the contract AbaPayV3?";
      setStatus(errMsg);
      return { success: false, message: errMsg };
    } finally {
      setIsApprovingAgent(false);
    }
  };

  // AgentHub's wallet-signature auth (linking a chat channel / MCP key, changing a PIN,
  // unlinking) needs a message signed with WHICHEVER client is actually live — same reasoning
  // as `client` vs wagmiWalletClient above. AgentHub itself stays wallet-agnostic; it just
  // calls this and gets back a signature or null.
  const signAgentMessage = async (message: string): Promise<string | null> => {
    if (!client || !address) return null;
    try {
      return await client.signMessage({ account: address as `0x${string}`, message });
    } catch (e) {
      console.error('Agent message signing failed:', e);
      return null;
    }
  };

  // ⚡ DeAI DEEP-LINK HAND-OFF ⚡
  // When a user completes a request with the DeAI agent on Telegram/WhatsApp/X, the agent
  // sends them a signed link back into this app. We verify it server-side (it's HMAC-signed
  // and expires in 15 min), then pre-fill the payment form. The user just connects their
  // wallet and signs — AbaPay never holds their funds, and no contract change was needed.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const pay = params.get('pay');
    const sig = params.get('sig');
    if (!pay || !sig) return;

    (async () => {
      try {
        const res = await fetch('/api/deai/resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ payload: pay, sig }),
        });
        const data = await res.json();

        if (!data.success) {
          setStatus(data.message || 'This payment link is no longer valid.');
          return;
        }

        const it = data.intent;

        // Pre-fill the form from the agent's verified intent.
        setActiveTab('pay');
        if (it.amountNgn) setNairaAmount(String(it.amountNgn));
        if (it.billersCode) setAccountNumber(it.billersCode);
        // Receipt email the user opted into during chat (see AWAITING_EMAIL_CHOICE in
        // src/app/api/deai/core/route.ts) — already validated server-side before the link
        // was issued, so it's safe to pre-fill directly.
        if (it.email) setCustomerEmail(it.email);

        const cat = (it.serviceCategory || '').toUpperCase();
        if (cat === 'ELECTRICITY') {
          const svc = SERVICES.find(s => s.id === 'ELECTRICITY');
          if (svc) setActiveService(svc);
          if (it.serviceID) setElecProvider(it.serviceID);
          if (it.meterType === 'prepaid' || it.meterType === 'postpaid') setMeterType(it.meterType);
        } else if (cat === 'CABLE') {
          const svc = SERVICES.find(s => s.id === 'CABLE');
          if (svc) setActiveService(svc);
          if (it.serviceID) setCableProvider(it.serviceID);
        } else if (cat === 'DATA') {
          const svc = SERVICES.find(s => s.id === 'INTERNET');
          if (svc) setActiveService(svc);
          if (it.provider) setTelecomProvider(it.provider.toLowerCase());
        } else if (cat === 'EDUCATION') {
          // Education lives on its OWN tab, not under `pay`/SERVICES — without this branch an
          // education hand-off landed on the AIRTIME service with the exam body dropped and
          // the billers code sitting in the airtime number field, i.e. a WAEC PIN request
          // arriving as an airtime top-up to the buyer's own phone.
          setActiveTab('education');
          if (it.serviceID) setEducationProvider(it.serviceID);
          // WAEC has no account field at all — its billers code IS the contact phone (see
          // buildBackendPayload). JAMB's is the profile ID, which the shared setAccountNumber
          // above already put in the right place.
          if (it.serviceID !== 'jamb' && it.billersCode) setCustomerPhone(it.billersCode);
        } else {
          const svc = SERVICES.find(s => s.id === 'AIRTIME');
          if (svc) setActiveService(svc);
          if (it.provider) setTelecomProvider(it.provider.toLowerCase());
        }

        setStatus(`✅ Request loaded from DeAI${it.customerName ? ` — ${it.customerName}` : ''}. Connect your wallet to approve.`);

        // ⚡ CHAIN + TOKEN: honor what the agent specified, so an agent-originated payment
        // can't silently land on the wrong chain (wrong tokens, and no Celo attribution).
        if (it.token) {
          const tok = SUPPORTED_TOKENS.find((t: any) => t.symbol === it.token);
          if (tok) setSelectedToken(tok);
        }
        if (it.chain) {
          const wantBase = String(it.chain).toUpperCase() === 'BASE';
          const targetId = wantBase
            ? (isMainnet ? base.id : baseSepolia.id)
            : (isMainnet ? celo.id : celoSepolia.id);

          if (wagmiChain && wagmiChain.id !== targetId && switchChain) {
            try {
              switchChain({ chainId: targetId });
              setStatus(`Switching to ${it.chain} to complete your DeAI request…`);
            } catch {
              setStatus(`Please switch your wallet to ${it.chain} to complete this payment.`);
            }
          }
        }

        // Clean the URL so a refresh doesn't re-trigger (and the link isn't left in history).
        window.history.replaceState({}, '', window.location.pathname);
      } catch (err) {
        console.error('Deep link resolution failed:', err);
        setStatus('Could not load your DeAI request. Please try again.');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ⚡ 1. THE SETTINGS INTERVAL ⚡
  useEffect(() => {
    let intervalId: NodeJS.Timeout;
    async function fetchSettings() {
        try { 
            const { data: settingsData } = await supabase.from('platform_settings').select('exchange_rate, kill_switches').eq('id', 1).single(); 
            if (settingsData) {
                if (settingsData.exchange_rate) setExchangeRate(Number(settingsData.exchange_rate)); 
                if (settingsData.kill_switches) setKillSwitches(settingsData.kill_switches);
            }
        } catch (e) {}
    }
    fetchSettings(); 
    intervalId = setInterval(fetchSettings, 15000); 
    return () => { if (intervalId) clearInterval(intervalId); };
  }, []);

    // ⚡ FARCASTER SPLASH SCREEN DROPPER ⚡
  useEffect(() => {
    const notifyFarcaster = async () => {
      try {
        if (typeof window !== "undefined") {
          sdk.actions.ready();
        }
      } catch (error) { }
    };
    notifyFarcaster();
  }, []);


  // =======================================================================
  // 👇 PASTE THE NEW CODE RIGHT HERE, EXACTLY ABOVE THE WAGMI BRIDGE 👇
  // =======================================================================

  // ⚡ SILENT INJECTED PROBE — RUNS ONCE, ASKS THE PROVIDER WHAT IT IS ⚡
  //
  // Everything about auto-connect hangs off this. `eth_accounts` never prompts, so we can
  // ask on every page load whether this browser's wallet has already approved AbaPay. If it
  // has, the user should never see a Connect button at all.
  //
  // This replaced a flag-sniffing heuristic (`is*` properties on window.ethereum). Sniffing
  // was wrong in both directions: wallets that don't advertise a flag were treated as fake
  // and denied auto-connect, while a stub with a fake flag would still have hung. Asking the
  // provider and timing it out answers the only question that matters — does it work?
  // 🔴 PROBES EVERY WALLET WAGMI FOUND, NOT `window.ethereum`. Under EIP-6963 a wallet
  // announces itself over an event instead of claiming the `window.ethereum` global, so a
  // browser with a perfectly good wallet can have that global undefined — which is exactly
  // why a real web3 browser was being shown a WalletConnect QR for a wallet sitting in the
  // same browser, and why auto-connect never fired there.
  //
  // Depends on `connectors` because EIP-6963 discovery is ASYNC: wagmi's list grows a tick
  // or two after mount as wallets answer the announcement, so probing once on mount would
  // miss them. Re-probing when the list changes is what catches a late announcer.
  useEffect(() => {
    if (environment !== 'WEB' || connectors.length === 0) return;
    let cancelled = false;
    (async () => {
      const found = await probeInjectedConnectors(connectors);
      if (cancelled) return;
      setInjectedCandidates(found);
      // Keep the single-probe summary in sync for /network-check and the messaging below:
      // the best status any wallet reported is what describes this browser.
      const best = found.some((c) => c.status === 'authorized')
        ? 'authorized'
        : found.some((c) => c.status === 'available')
          ? 'available'
          : 'none';
      setInjectedProbe(best === 'authorized' ? { status: 'authorized', accounts: [] } : { status: best });
    })();
    return () => { cancelled = true; };
  }, [environment, connectors]);

  // ⚡ DROP A CONNECTION THAT WAS ONLY EVER REHYDRATED FROM STORAGE ⚡
  //
  // 🔴 WHY `reconnectOnMount={false}` DID NOT, ON ITS OWN, STOP VALORA CONNECTING BY ITSELF.
  // That flag stops wagmi RE-ESTABLISHING the connector on mount. It does not stop wagmi
  // REHYDRATING its state: the config persists to `cookieStorage` with `ssr: true`, so on load
  // wagmi restores `connections`/`current` from the cookie and `useAccount()` reports
  // `isConnected` with an address — while no provider has been set up and no relay socket
  // exists. The app looks connected because, as far as wagmi's state is concerned, it is.
  //
  // That is the exact pair of symptoms reported: Valora "still auto connects", and then paying
  // says "your wallet connection has dropped — tap Connect" on a wallet that appears connected.
  // Nothing had dropped; there was never a live session, only a cookie describing one.
  //
  // So a connection this page did not itself establish is not a connection. Base App's silent
  // connect is unaffected — it calls connect() explicitly below, which sets
  // `userInitiatedConnect`, as does the Connect button.
  const rehydratedConnectionChecked = useRef(false);
  useEffect(() => {
    if (environment !== 'WEB' || rehydratedConnectionChecked.current) return;
    if (!isWagmiConnected) return;
    rehydratedConnectionChecked.current = true;
    if (userInitiatedConnect.current) return; // established in this page session — genuine

    console.warn('[wallet] dropping a connection restored from storage — nothing was actually connected.');
    try { disconnect(); } catch { /* best effort — the release effect below clears the UI */ }
    localStorage.removeItem('abapay_connected');
  }, [environment, isWagmiConnected, disconnect]);

  // ⚡ NATIVE INJECTED AUTOCONNECT ⚡
  //
  // Fires ONLY when the wallet already has accounts for this site — i.e. an in-app wallet
  // browser (MiniPay, Valora, Base App, Trust, MetaMask mobile) or a returning user who
  // approved us before. In those cases wagmi's connect() resolves without a popup, because
  // the permission already exists, so the app just… appears connected.
  //
  // It deliberately does NOT fire on `available` (a real wallet that hasn't approved us):
  // auto-firing there would throw an unsolicited permission dialog in the user's face the
  // instant the page loads. That's what the Connect button is for.
  useEffect(() => {
    // Abort if already connected, explicitly logged out, or not in web mode
    if (address || environment !== 'WEB' || localStorage.getItem('abapay_explicit_logout') === 'true') return;
    if (connectStatus === 'pending') return; // a connection attempt is already in flight

    // 🔴 AUTO-CONNECT IS AN ALLOWLIST NOW, NOT A BLOCKLIST.
    //
    // This used to fire for ANY wallet that already had accounts for this site, with Valora
    // carved out by name once it turned out to auto-connect into a rail that cannot sign. That
    // had the polarity backwards: every new wallet was auto-connected by default and only
    // removed after someone reported a problem, which is how "it connects by itself and there is
    // no Connect button" kept coming back wearing a different wallet's name.
    //
    // Silent connect is only ever right where the app is running INSIDE the wallet — MiniPay,
    // Base App and Farcaster. There the user already chose the account by opening AbaPay there,
    // there is only one account it could mean, and no chooser is being hidden. In an ordinary
    // browser, even one whose extension authorised this site months ago, connecting without
    // being asked picks a wallet on the user's behalf and buries the real chooser (every
    // detected injected wallet, plus WalletConnect) behind a button they have no reason to press.
    //
    // MiniPay and Farcaster never reach this effect — they are detected by their own SDKs and
    // connect in the environment detector, so `environment` is not 'WEB' for them. Base App is
    // the one allowed surface that arrives through wagmi, so it is the one named here.
    // See AUTO_CONNECT_SURFACES in src/lib/walletEnv.ts.
    if (!isBaseAppBrowser()) return;

    // The wallet that ALREADY has accounts for this site — not merely "an injected connector
    // exists". If none has answered `authorized` yet, bail WITHOUT marking the attempt: the
    // effect re-runs as EIP-6963 discovery fills `connectors` in, so a wallet that announces
    // itself late still gets its auto-connect.
    const injectedConnector = injectedCandidates.find(c => c.status === 'authorized')?.connector;
    if (!injectedConnector) return;

    // Only auto-fire ONCE. If it doesn't complete, the visible Connect button stays as the
    // clean path forward (WalletConnect included).
    if (autoConnectTried.current) return;
    autoConnectTried.current = true;

    connect(
      { connector: injectedConnector },
      {
        onSuccess: () => localStorage.setItem('abapay_connected', 'true'),
        onError: () => {
          // Auto-connect couldn't complete — clear the flag so the visible Connect button
          // is the clean path forward (WalletConnect option included).
          localStorage.removeItem('abapay_connected');
        },
      }
    );
  }, [address, environment, injectedCandidates, connect, connectStatus]);


  /**
   * The MiniPay connection sequence, factored out of the environment detector so it can be
   * called TWICE: once automatically on load, and once from a real Connect button — the escape
   * hatch this needs. MiniPay is a captive webview with exactly one wallet, but that is not the
   * same as needing no way back in: a decline (or a signature that simply never answers — real,
   * documented uncertainty about MiniPay's personal_sign) used to leave the account permanently
   * unverified with only a refresh to fall back on, and even a refresh sometimes reported nothing
   * detected — because the automatic retry alone had no way to distinguish "still waiting" from
   * "genuinely stuck," and there was no button to force a clean restart.
   *
   * A fresh call here always requests accounts again and builds a NEW client, rather than
   * reusing whatever `minipayPending` already held — the difference between an actual retry and
   * repeating a request that already went nowhere once.
   */
  const connectMiniPay = useCallback(async () => {
    if (typeof window === "undefined" || !(window as any).ethereum?.isMiniPay) return;
    setIsConnecting(true);
    setMinipayVerifyFailed(false);
    try {
      const targetChain = isMainnet ? celo : celoSepolia;
      setActiveChain(targetChain);
      const miniPayClient = createWalletClient({ chain: targetChain, transport: custom((window as any).ethereum) });
      const [acc] = await miniPayClient.requestAddresses();
      const currentChainId = await miniPayClient.getChainId();
      if (currentChainId !== targetChain.id) await miniPayClient.switchChain({ id: targetChain.id }).catch(() => {});
      setMinipayPending({ address: acc, client: miniPayClient });
    } catch {
      setConnectError("Couldn't reach your MiniPay wallet. Tap Connect to try again.");
    } finally {
      setIsConnecting(false);
    }
  }, [isMainnet]);

  /**
   * MiniPay's own Disconnect. Clears the pending pair, the published address/client and any
   * cached proof for it — a full reset, so Connect afterward is a genuinely fresh attempt rather
   * than one that silently reuses whatever was stuck.
   */
  const handleMiniPayDisconnect = useCallback(() => {
    const addr = minipayPending?.address || address;
    if (addr) { try { sessionStorage.removeItem(`abapay_wallet_proof_${addr.toLowerCase()}`); } catch { /* private mode */ } }
    setMinipayPending(null);
    setAddress(null);
    setClient(null);
    setWalletProof(null);
    setMinipayVerifyFailed(false);
    showToast('Wallet Disconnected', 'Tap Connect when you want to pay.', 'success');
  }, [minipayPending, address]);

  /** Move the wallet — and the app — onto a chosen chain. Called only from the network menu. */
  const switchToChain = useCallback(async (target: Chain) => {
    setChainMenuOpen(false);
    if (environment !== 'WEB' || !client || activeChain?.id === target.id) return;
    try {
      setIsProcessing(true);
      await client.switchChain({ id: target.id });
      setActiveChain(target);
    } catch {
      // A wallet that doesn't know the chain yet can usually be taught it.
      try {
        await client.addChain({ chain: target });
        setActiveChain(target);
      } catch {
        showToast('Switch Failed', 'Please switch the network inside your wallet app.', 'error');
      }
    } finally {
      setIsProcessing(false);
    }
  }, [environment, client, activeChain]);

  /**
   * Disconnect, and mean it.
   *
   * 🔴 `abapay_explicit_logout` IS THE LOAD-BEARING PART. Base App's auto-connect reconnects a
   * wallet that already authorised this site, and without a record of the user having chosen to
   * leave it would do exactly that on the next render — disconnecting them into an immediate
   * reconnection. The flag is cleared by handleConnectClick, so pressing Connect is what opts
   * back in.
   *
   * 🔴 …AND THE PROOF HAS TO GO WITH IT, WHICH IS WHAT WAS ACTUALLY BROKEN IN BASE APP.
   *
   * "I click exit, I see the disconnected notification, but it immediately connects again and
   * shows the balance." The logout flag above was never the problem — clearing `walletProof` was
   * missing, and the WEB bridge republishes on exactly three conditions: wagmi still reports a
   * connection, it has an address, and `walletProof` matches that address. wagmi's disconnect()
   * is asynchronous, so for at least one render after this runs all three were still true — the
   * bridge then called setAddress(wagmiAddress) again AND
   * `localStorage.removeItem('abapay_explicit_logout')`, destroying the very guard that was
   * supposed to prevent the reconnect. The user was disconnected and re-connected in the same
   * tick, with the flag wiped on the way through.
   *
   * Dropping the proof removes the bridge's third condition, so there is nothing to republish
   * while wagmi finishes tearing the session down. The cached copy in sessionStorage goes too:
   * leaving it means the verification effect reads it back on its very next run and restores
   * `walletProof` from cache, which reopens the same hole a moment later. Every key is cleared
   * rather than just this address's, so no dependency on which address was live is needed here —
   * and after an explicit disconnect no wallet's proof should survive anyway.
   * handleMiniPayDisconnect has always done both of these, which is why MiniPay's own Disconnect
   * never showed this bug.
   */
  const handleDisconnect = useCallback(() => {
    setChainMenuOpen(false);
    try { disconnect(); } catch { /* best effort — the local state below is what the UI reads */ }
    localStorage.setItem('abapay_explicit_logout', 'true');
    localStorage.removeItem('abapay_connected');
    autoConnectTried.current = false;
    userInitiatedConnect.current = false;
    setAddress(null);
    setClient(null);
    setWalletProof(null);
    try {
      Object.keys(sessionStorage)
        .filter((k) => k.startsWith('abapay_wallet_proof_'))
        .forEach((k) => sessionStorage.removeItem(k));
    } catch { /* private mode — nothing was cached to begin with */ }
    setConnectError(null);
    showToast('Wallet Disconnected', 'Your wallet is no longer connected. Tap Connect when you want to pay.', 'success');
  }, [disconnect]);

  // 🔐 ASK FOR THE OWNERSHIP SIGNATURE ONCE PER SESSION, RIGHT AFTER CONNECTING.
  //
  // Runs for EVERY environment, auto-connected ones included — MiniPay, Base App and Farcaster
  // skip the Connect button, not the proof. verifySignatureAcrossChains handles both kinds of
  // wallet: plain ECDSA for EOAs (MetaMask, Valora, MiniPay) and ERC-1271/6492 on-chain
  // validation for smart accounts (Base Account, Safe), so no wallet is locked out by the
  // signature simply being a shape the server could not check.
  //
  // 🔴 A WALLET THAT CANNOT SIGN IS NOT TREATED AS A WALLET THAT REFUSED. A rejection is the user
  // saying no, and they are disconnected — they declined to prove the address is theirs. Any
  // OTHER failure (a wallet with no personal_sign, a relay that dropped the request) leaves them
  // connected but unproven: they can still pay, because paying is authorised by the payment
  // signature itself, and only the history read is withheld. Locking someone out of paying
  // because their wallet is unusual would be a worse bug than the one this closes.
  // ⚡ ON THE WEB IT SIGNS WITH THE WAGMI WALLET, NOT THE APP'S `client`.
  //
  // 🔴 THE "CONNECT, THEN VERIFY, AND MY BALANCE IS ALREADY SHOWING" REPORT. This used to wait
  // for the app's own `address`/`client`, which the wagmi bridge publishes the instant the wallet
  // connects — so the address, the balance and the history were on screen BEFORE anyone had
  // proven the account was theirs, and cancelling the signature left all of it sitting there.
  //
  // Verification now runs off wagmi's own address and wallet client, which exist as soon as the
  // connector does, and the bridge below refuses to publish anything until the proof matches.
  // One app-initiated prompt — the signature — and nothing is revealed until it succeeds.
  // MiniPay signs from the pending pair (not yet published to `address`/`client`); WEB signs from
  // wagmi's own state for the same reason; Farcaster and Base App still sign from the published
  // `client` — see the note above minipayPending for why MiniPay was the one that needed moving.
  const proofAddress = environment === 'WEB' ? (wagmiAddress as string | undefined)
    : environment === 'MINIPAY' ? minipayPending?.address
    : address;
  const proofSigner: any = environment === 'WEB' ? wagmiWalletClient
    : environment === 'MINIPAY' ? minipayPending?.client
    : client;

  /**
   * A wallet is attached but has not yet proven itself — the window between the connector
   * appearing and the ownership signature landing.
   *
   * The Connect button reads this so it keeps spinning through the signature instead of going
   * idle the moment the handshake completes, which is what made a half-finished connect look
   * finished. Nothing else in the app is allowed to treat this state as connected.
   */
  const awaitingProof = Boolean(
    (environment === 'WEB' || environment === 'MINIPAY') && proofAddress &&
    !(walletProof && walletProof.address.toLowerCase() === proofAddress.toLowerCase()),
  );

  // True only AFTER an actual decline/failure — never while the first request is still pending,
  // which `awaitingProof` alone cannot distinguish (it is true from the moment a pending pair
  // exists, before the wallet has answered at all).
  const [minipayVerifyFailed, setMinipayVerifyFailed] = useState(false);

  // Kept current every render so the in-flight verification can ask "is this signature still for
  // the address the app cares about?" instead of "was my effect run superseded?" — see the note
  // on proofAddressRef, and the deadlock described in the effect below.
  proofAddressRef.current = proofAddress;

  // Bumped when an in-flight verification finishes for an address the app has since moved off.
  // Without it the OTHER half of the same deadlock stays open: the in-flight guard makes a run
  // for the new address bail while the old one is still pending, and when the old one finally
  // returns it is correctly discarded — leaving nothing to ask for the new address's signature.
  // That is a real case (switching accounts in the wallet mid-prompt), not a theoretical one.
  const [proofRecheck, setProofRecheck] = useState(0);

  useEffect(() => {
    if (!proofAddress || !proofSigner) return;
    if (walletProof && walletProof.address.toLowerCase() === proofAddress.toLowerCase()) return;
    if (walletProofInFlight.current) return;
    // 🔴 DON'T CHASE A SIGNATURE FROM SOMEONE WHO JUST LEFT.
    //
    // handleDisconnect now clears `walletProof` (without that, Base App reconnected itself
    // instantly — see the note there). But wagmi's disconnect() is asynchronous, so for a render
    // or two afterwards `proofAddress`/`proofSigner` are still populated from wagmi while the
    // proof is gone — precisely the state this effect exists to resolve, which would have it pop
    // a signature request at someone who just pressed Exit. The same flag the auto-connect
    // effect already respects, and handleConnectClick already clears, is the honest answer to
    // "did the user ask to be here?". MiniPay is excluded because it never sets that flag: its
    // own Disconnect clears minipayPending outright, so proofAddress goes away by itself.
    if (environment === 'WEB' && localStorage.getItem('abapay_explicit_logout') === 'true') return;

    // A proof from earlier in this browser session is reused rather than re-prompted — a wallet
    // popup on every reload is how people are trained to sign without reading.
    try {
      const cached = sessionStorage.getItem(`abapay_wallet_proof_${proofAddress.toLowerCase()}`);
      if (cached) {
        const parsed = JSON.parse(cached) as { address: string; signature: string; timestamp: string };
        const age = Date.now() - parseInt(parsed.timestamp, 10);
        if (parsed.signature && age >= 0 && age < WALLET_SESSION_MAX_AGE_MS) { setWalletProof(parsed); return; }
        sessionStorage.removeItem(`abapay_wallet_proof_${proofAddress.toLowerCase()}`);
      }
    } catch { /* an unreadable cache just means we ask again */ }

    // 🔴 THE "I SIGN AND IT SAYS VERIFYING FOR LIFE" DEADLOCK — AND THE CANCEL ONE, SAME CAUSE.
    //
    // This used to guard every outcome with a per-run `cancelled` flag set by the effect cleanup.
    // Combined with the `walletProofInFlight` ref above, that produced a permanent hang the moment
    // ANYTHING changed this effect's dependencies while the wallet was showing its prompt:
    //
    //   1. the effect starts, sets walletProofInFlight = true, awaits signMessage
    //   2. a dependency changes (in MiniPay: the environment detector re-ran and handed us a
    //      brand-new wallet client — see the re-entry guard on that effect), so React runs this
    //      cleanup and sets cancelled = true
    //   3. the effect re-runs, hits `if (walletProofInFlight.current) return` and bails — correct
    //      on its face, since a prompt IS already open, so no second prompt is raised
    //   4. the user signs. The promise resolves. `if (cancelled) return` THROWS THE SIGNATURE AWAY
    //   5. `finally` clears the in-flight flag — but nothing is left to re-trigger the effect,
    //      because the dependency change that started all this already happened
    //   6. walletProof is never set, so `awaitingProof` stays true forever: "Verifying" spins for
    //      life. Declining took the identical path — the catch's `if (cancelled) return` skipped
    //      setMinipayVerifyFailed too, so the retry UI never appeared either.
    //
    // That is why shortening the signature timeout didn't help: the timeout fires correctly, and
    // its rejection is then discarded by the same guard.
    //
    // The fix is to ask the right question. A signature is valid for the address it was made for,
    // regardless of how many times this effect re-ran while the wallet was thinking — so the
    // result is applied whenever it still matches the address the app currently wants
    // (proofAddressRef), and only discarded when the user has genuinely moved to a different
    // wallet. No `cancelled` flag, so no way to strand a completed result.
    walletProofInFlight.current = true;
    const stillWanted = () =>
      proofAddressRef.current?.toLowerCase() === proofAddress.toLowerCase();
    (async () => {
      try {
        const timestamp = Date.now().toString();
        // 🔴 A SHORTER BUDGET THAN A REAL PAYMENT SIGNATURE GETS, ON PURPOSE.
        //
        // "Cancel and it keeps rolling — supposed to stop and show Connect right away." Some
        // wallets (MiniPay among them — the same uncertainty already documented elsewhere in
        // this file) don't reliably REJECT a declined signMessage; the promise can simply never
        // settle, and the only thing that ends it is withWalletTimeout's own budget. The default
        // is 90s, sized for a real payment the user might be reading carefully before approving.
        // Proving wallet ownership is not that — it is one quick prompt with nothing to weigh —
        // so a decline that never rejects should not cost the user a minute and a half of a
        // spinner reading "Verifying" before Connect reappears. 20s is still generous for
        // actually reading and tapping Approve; it just stops pretending a silent decline might
        // still resolve on its own past that point.
        const signature = String(await withWalletTimeout(
          proofSigner.signMessage({ account: proofAddress as `0x${string}`, message: walletSessionMessage(timestamp) }) as Promise<string>,
          20_000,
        ));
        const proof = { address: proofAddress, signature, timestamp };
        // Cached FIRST, before the still-wanted check: the cache is keyed by address, so storing a
        // proof the user just made is right even if they have since switched away — coming back to
        // that address in this session then costs no second prompt.
        try { sessionStorage.setItem(`abapay_wallet_proof_${proofAddress.toLowerCase()}`, JSON.stringify(proof)); } catch { /* private mode */ }
        if (!stillWanted()) return;
        setWalletProof(proof);
      } catch (e) {
        if (!stillWanted()) return;
        // 🔴 ON THE WEB, FAILING TO VERIFY DISCONNECTS — WHATEVER THE FAILURE LOOKED LIKE.
        //
        // This used to disconnect only on a recognised rejection and otherwise leave the user
        // connected-but-unproven. That was wrong for the wallet it matters most for: Valora over
        // WalletConnect sends NOTHING back when its sheet is dismissed (see the STOP WAITING
        // note in walletEnv), so cancelling is not a rejection this code can recognise — it is
        // silence, ending in a timeout. Reported exactly that way: "I cancel the verify wallet
        // pop up and I'm still seeing my history and the chain connected."
        //
        // So the rule is the outcome, not the error shape: no proof, no session. A cancel and a
        // dead relay are indistinguishable from here and both mean the same thing — this app
        // cannot show you data belonging to an address nobody demonstrated they hold.
        //
        // MiniPay and Farcaster are exempt: the app runs INSIDE the wallet, there is exactly one
        // account it could mean, and MiniPay in particular is not reliable at personal_sign —
        // disconnecting there would lock users out of an environment where the spoofing this
        // guards against cannot happen anyway.
        const rejected = isUserRejection(e);
        if (environment === 'WEB') {
          console.warn('[wallet] ownership signature not obtained — disconnecting:', rejected ? 'declined' : (e as Error)?.message);
          handleDisconnect();
          setConnectError(
            rejected
              ? 'Verifying your wallet was cancelled, so it has been disconnected. Tap Connect and approve the signature — it moves no money and approves no payment.'
              : "Your wallet didn't confirm it belongs to you, so it has been disconnected. Tap Connect to try again.",
          );
          return;
        }
        console.warn('[wallet] ownership signature unavailable in', environment, '— history stays hidden:', (e as Error)?.message);
        if (environment === 'MINIPAY') setMinipayVerifyFailed(true);
      } finally {
        // 🔴 ALWAYS RELEASED — THIS GUARD IS WHAT LOCKED PEOPLE OUT.
        //
        // It used to read `if (!cancelled)`, and the failure path CAUSES cancellation: refusing
        // the signature calls handleDisconnect, the dependencies change, React runs the cleanup,
        // and `cancelled` is true by the time this runs. So the flag stayed true for the life of
        // the page and the early-return at the top silently swallowed every later attempt —
        // reported as "even if I refresh and want to sign, it won't pop up again and keeps
        // throwing the error", with no way back in short of a new tab.
        //
        // A latch that is only ever set on the failure path is a trap. Released unconditionally.
        walletProofInFlight.current = false;
        // The app moved to a different address while this one was in the wallet, so the run that
        // would have asked for THAT address's signature bailed on the in-flight guard above.
        // Nothing else will re-trigger it — the dependency change that superseded us has already
        // happened — so it is re-triggered explicitly here. See proofRecheck.
        if (!stillWanted()) setProofRecheck((n) => n + 1);
      }
    })();
    // No cleanup: there is deliberately nothing to cancel. An in-flight signature request cannot
    // be recalled from the wallet anyway, and the only thing the old cleanup did was set the flag
    // that stranded the answer when it came back. Whether the result is still wanted is decided
    // by stillWanted() at the moment it arrives, which is when the question can actually be
    // answered correctly.
  }, [proofAddress, proofSigner, walletProof, handleDisconnect, environment, proofRecheck]);

  // ⚡ THE MANUAL CONNECT PATH ⚡
  //
  // The old handler fired `connect()` and walked away: no await, no timeout, no error
  // handler. Two very different failures therefore looked identical to the user — the
  // button simply did nothing, forever:
  //
  //   • a stub `window.ethereum` (no wallet behind it) swallowed the attempt, AND because
  //     the old code branched on `Boolean(window.ethereum)` it never tried WalletConnect;
  //   • a filtered WalletConnect relay (MTN and other Nigerian networks) left the relay
  //     socket hanging, and a WebSocket that never opens throws nothing to catch.
  //
  // Now: attempt injected only when a real wallet is present, ALWAYS fall through to
  // WalletConnect, race both against a timeout, and say out loud what failed.
  const handleConnectClick = useCallback(async () => {
    if (isConnecting) return;

    localStorage.removeItem('abapay_explicit_logout');
    userInitiatedConnect.current = true; // this one is deliberate — never auto-dropped below
    setConnectError(null);
    setIsConnecting(true);

    const wcConnector = connectors.find(c => c.id === 'walletConnect' || c.type === 'walletConnect');

    try {
      // 1. A REAL injected wallet is always the best path — no third-party host involved,
      //    which is exactly why it keeps working on networks that filter the relay.
      //
      //    "Real" is decided by asking each wallet wagmi discovered, not by reading
      //    `window.ethereum`: under EIP-6963 the wallet may never have claimed that global.
      //    Reading it was why this button opened a WalletConnect QR in a browser that had a
      //    wallet installed. If discovery hasn't settled yet, probe now rather than guessing.
      const candidates = injectedCandidates.length
        ? injectedCandidates
        : await probeInjectedConnectors(connectors);
      if (!injectedCandidates.length) setInjectedCandidates(candidates);

      // Only wallets that actually answered are worth prompting. A wedged provider ('none')
      // is excluded so it can't swallow the click.
      //
      // 🔴 …AND INSIDE VALORA, NONE OF THEM ARE. Valora's in-app browser answers the probe
      // like a real injected wallet and then never returns a signature — the user taps Allow,
      // Valora reports a successful CONNECTION, and the payment waits forever on a response
      // that was never sent. Emptying the list here drops the click straight through to the
      // WalletConnect branch below, which is Valora's supported rail and does return
      // responses. The wallet is in the same app, so pairing costs a tap.
      const usable = isValoraBrowser() ? [] : candidates.filter(c => c.status !== 'none');

      // 🔴 ASK, DON'T GUESS — AND ALWAYS OFFER WALLETCONNECT.
      //
      // Picking an installed wallet automatically would pop whichever extension answered first,
      // not necessarily the one the user meant, with no way to correct it. So the options are
      // presented and the chooser resolves through this same promise, keeping one flow (and one
      // set of timeouts and error messages) however the wallet was chosen.
      //
      // 🔴 WALLETCONNECT IS ALWAYS IN THE LIST, not merely what happens when nothing is
      // installed. The chooser used to require TWO OR MORE injected wallets before it appeared,
      // so the very common "one extension installed" browser silently connected to that
      // extension and was never offered WalletConnect at all — there was no way to pair a phone
      // wallet short of uninstalling the extension. Building the option list first and deciding
      // on the chooser from ITS length is what makes the single-wallet case a real choice.
      // ⚡ BASE ACCOUNT IS A FIRST-CLASS OPTION, NOT A HIDDEN ONE.
      //
      // The connector has been configured in src/config/wagmi.ts all along, but nothing ever
      // offered it: probeInjectedConnectors only returns connectors of type 'injected', and Base
      // Account is its own type. So a user with no extension could reach it only by accident.
      // It matters most on Base — the app's default chain — where it is the smart-account
      // experience that carries sponsored gas, and signature verification already handles the
      // ERC-1271 signatures it produces (see verifySignatureAcrossChains).
      const baseAccountConnector = connectors.find(c => c.id === 'baseAccount' || c.type === 'baseAccount');

      const options: InjectedCandidate[] = [
        ...usable,
        ...(baseAccountConnector ? [{ connector: baseAccountConnector, name: 'Base Account', status: 'available' as const }] : []),
        ...(wcConnector ? [{ connector: wcConnector, name: 'WalletConnect', status: 'available' as const }] : []),
      ];

      // One option is not a decision — a browser with no injected wallet still goes straight to
      // WalletConnect without a pointless one-item modal.
      let chosen: InjectedCandidate | null | undefined = options[0];

      if (options.length > 1) {
        chosen = await askWhichWallet(options);
        // Cancelled — not a failure, just stop. No error banner, no QR code.
        if (!chosen) return;
      }

      // Picked WalletConnect from the list: skip the injected attempt and go straight to the
      // relay flow below, which already handles the QR, the handshake timeout and the errors.
      const pickedWalletConnect = chosen?.connector === wcConnector;
      const injectedConnector = pickedWalletConnect ? undefined : chosen?.connector;

      if (injectedConnector) {
        try {
          await withConnectTimeout(
            connectAsync({ connector: injectedConnector }),
            INJECTED_CONNECT_TIMEOUT_MS,
            'injected',
          );
          localStorage.setItem('abapay_connected', 'true');
          return;
        } catch (injectedErr) {
          // 🔴 "CANCEL" MEANS CANCEL — DO NOT FALL THROUGH TO WALLETCONNECT.
          //
          // Dismissing the wallet prompt used to drop straight into the WalletConnect branch,
          // so the user who just said no was handed a QR code instead — and on a network that
          // filters the relay that branch then sits waiting on a socket that never opens. From
          // the outside it is indistinguishable from the app ignoring the cancel and hanging,
          // which is exactly what was reported. A rejection is a decision, not a failure to
          // route around: acknowledge it immediately and stop.
          if (isUserRejection(injectedErr)) {
            setConnectError('Connection request was cancelled.');
            return;
          }

          // A wallet that TIMED OUT is different again: it may still be sitting there waiting
          // for approval, and stacking a QR modal on top of a live wallet prompt is worse than
          // saying so. Report and stop.
          //
          // Anything else (unsupported chain, locked wallet, a provider that errored) is a
          // genuine failure to connect, and WalletConnect is still worth offering.
          if (injectedErr instanceof ConnectTimeoutError || !wcConnector) {
            setConnectError(describeConnectFailure(injectedErr));
            return;
          }
        }
      }

      // 2. WalletConnect — the fallback for a browser with NO injected wallet, which is what
      //    it was always meant to be: a plain desktop browser with no extension, or a phone
      //    browser pairing with a wallet app. Reaching it when an injected wallet exists is
      //    the bug fixed above, not the intent.
      if (wcConnector) {
        try {
          // ⚠️ NO timeout on this promise: it resolves only once the user has scanned the
          // QR and approved, which legitimately takes minutes.
          const connectPromise = connectAsync({ connector: wcConnector });
          // Keep the rejection handled while we watch the handshake, so a relay failure
          // can't surface as an unhandled promise rejection.
          let connectFailure: unknown = null;
          const settled = connectPromise.then(
            () => 'connected' as const,
            (err) => { connectFailure = err; return 'failed' as const; },
          );

          // Race the pairing URI (proof the relay is reachable) against the connection
          // itself — a user with an existing session connects without ever showing a QR.
          const outcome = await Promise.race([
            settled,
            waitForRelayHandshake(wcConnector, RELAY_HANDSHAKE_TIMEOUT_MS)
              .then((ok) => (ok ? ('handshake' as const) : ('norelay' as const))),
          ]);

          if (outcome === 'norelay') {
            setConnectError(describeConnectFailure(new RelayUnreachableError()));
            return;
          }
          if (outcome === 'failed') {
            setConnectError(describeConnectFailure(connectFailure));
            return;
          }
          if (outcome === 'handshake') {
            // Relay is fine and the QR is up. Now wait on the human for as long as it takes.
            const final = await settled;
            if (final === 'failed') {
              setConnectError(describeConnectFailure(connectFailure));
              return;
            }
          }

          localStorage.setItem('abapay_connected', 'true');
          return;
        } catch (wcErr) {
          setConnectError(describeConnectFailure(wcErr));
          return;
        }
      }

      setConnectError('No wallet connector is available in this browser.');
    } finally {
      setIsConnecting(false);
    }
  }, [connectors, connectAsync, isConnecting, injectedCandidates, askWhichWallet]);

  // =======================================================================


  // ⚡ WAGMI TO ABAPAY BRIDGE ⚡
  useEffect(() => {
    if (environment !== 'WEB' || !isWagmiConnected || !wagmiAddress) return;

    // 🔴 NOTHING IS PUBLISHED UNTIL THE WALLET HAS PROVEN ITSELF.
    //
    // `address` is what the entire app keys off — the header, the balance, the history, the pay
    // button. Setting it the moment wagmi connects is what put a user's address and balance on
    // screen BEFORE the ownership signature, and left them there when the signature was
    // cancelled: "I cancel the verify wallet pop up and it still shows my data."
    //
    // Holding it back until `walletProof` matches makes connecting a single act from the user's
    // side: press Connect, approve one signature, and the app fills in. Refuse, and there was
    // never anything to take away.
    //
    // WEB is gated here. MiniPay is gated by its own bridge just below, for the same reason —
    // see minipayPending. Farcaster still sets `address` directly in the environment detector;
    // no bug has been reported there and it is left alone rather than changed on spec.
    const verified = Boolean(walletProof && walletProof.address.toLowerCase() === wagmiAddress.toLowerCase());
    if (!verified) return;

    setAddress(wagmiAddress);
    localStorage.removeItem('abapay_explicit_logout');

    const targetChain = wagmiChain || (isMainnet ? base : baseSepolia);
    setActiveChain(targetChain);

    if (client) return;

    // ⚡ Wagmi's official WalletClient, so WalletConnect sockets can properly sign.
    if (wagmiWalletClient) {
      setClient((wagmiWalletClient as any).extend(eip5792Actions()));
      return;
    }

    // 🔴 …AND A FALLBACK, BECAUSE `useWalletClient()` CAN SIMPLY NOT RESOLVE.
    //
    // It is a query over getConnectorClient, which THROWS when the wallet's current chain
    // isn't in our `chains` config (ConnectorChainMismatchError, and the chain lookup returns
    // undefined). A wallet sitting on Ethereum mainnet — the default for a fresh MetaMask —
    // therefore yields `wagmiWalletClient === undefined` indefinitely.
    //
    // Nothing else noticed: `address` still gets set from wagmi and the balance still renders,
    // because balances are read through a PUBLIC client that needs no wallet. Only `client` was
    // left null, and the one place that surfaced was the pay button, which read "Connect Wallet
    // First" at a wallet that was plainly connected and showing a balance.
    //
    // Building the client straight from the connector's own provider — the same shape the
    // MiniPay and Farcaster paths already use — removes the dependency on that query
    // succeeding at all. The switch-to-a-supported-chain effect below fixes the underlying
    // mismatch; this makes sure a wallet is usable either way.
    let cancelled = false;
    (async () => {
      try {
        const provider = await wagmiConnector?.getProvider?.();
        if (!provider || cancelled) return;
        const fallbackClient = createWalletClient({
          account: wagmiAddress as `0x${string}`,
          chain: targetChain,
          transport: custom(provider as any),
        }).extend(eip5792Actions());
        if (!cancelled) setClient(fallbackClient);
      } catch (e) {
        console.error('[wallet] Could not build a wallet client from the connector:', e);
      }
    })();
    return () => { cancelled = true; };
  }, [environment, isWagmiConnected, wagmiAddress, wagmiChain, isMainnet, client, wagmiWalletClient, wagmiConnector, walletProof]);

  // ⚡ MINIPAY BRIDGE — THE SAME GATE, FOR THE ONE ENVIRONMENT THAT DIDN'T HAVE IT ⚡
  //
  // 🔴 "IN MINIPAY, AUTO-CONNECT IS WORKING AND THE SIGNATURE POP-UP FIRES, BUT DESPITE THE USER
  // DECLINING IT STILL GOES AHEAD WITH THE AUTO-CONNECT WITHOUT RECEIVING A SIGNATURE." The
  // environment detector's MiniPay branch used to call setAddress/setClient directly, the instant
  // the wallet answered requestAddresses — before any ownership signature. So the account and
  // balance were live regardless of what happened to the verification prompt, and declining it
  // did nothing because there was nothing left to take away.
  //
  // The detector now only sets `minipayPending`; this is what turns that into `address`/`client`,
  // and it does that ONLY once `walletProof` matches — same rule as the WEB bridge, same
  // publish-nothing-until-proven principle, just fed by MiniPay's own account/client pair instead
  // of wagmi's.
  useEffect(() => {
    if (environment !== 'MINIPAY' || !minipayPending) return;
    const verified = Boolean(walletProof && walletProof.address.toLowerCase() === minipayPending.address.toLowerCase());
    if (!verified) return;
    setAddress(minipayPending.address);
    setClient(minipayPending.client);
  }, [environment, minipayPending, walletProof]);

  // ⚡ AND LET GO THE MOMENT WAGMI DOES ⚡
  //
  // 🔴 THE "IT CONNECTED BY ITSELF AND THERE IS NO CONNECT BUTTON" TRAP, AND WHY THE VALORA
  // RULE BELOW DID NOT ACTUALLY WORK. The bridge above copies wagmi's address into this
  // component's own `address`, and nothing ever copied a DISCONNECT back. Every effect that
  // drops a connection — the restored-Valora rule below, the dead-session guard in
  // ensureWalletReachable — calls wagmi's disconnect() and then watches the page carry on as
  // though nothing happened, because the page keys off `address`: the Connect button renders on
  // `!address`, and so does the banner explaining why the wallet was dropped. So the user was
  // left looking at a connected-looking app, no Connect button, no message, and a `client`
  // pointing at a session that had just been torn down — which is precisely the "Valora auto
  // connects and I cannot get it to connect properly" report the Valora rule was meant to fix.
  //
  // Releasing both here, in one place, is what makes every disconnect in this file real.
  useEffect(() => {
    if (environment !== 'WEB') return;
    if (isWagmiConnected && wagmiAddress) return;
    if (address === null && client === null) return;
    setAddress(null);
    setClient(null);
  }, [environment, isWagmiConnected, wagmiAddress, address, client]);

  // ⚡ NO AUTO-CONNECT IN VALORA — PAIR FRESH OR NOT AT ALL ⚡
  //
  // 🔴 WHY A RESTORED VALORA SESSION IS DROPPED. wagmi persists the WalletConnect session and
  // restores it on mount, so opening AbaPay in Valora comes up connected with no Connect button
  // ever pressed — the "it auto connects after some time" report, and the reason the
  // WalletConnect option never appeared: there was nothing left to connect.
  //
  // Valora reaches this app over WalletConnect and nothing else, and a restored session there
  // has been the common factor in every hang. Dropping it costs one tap and guarantees the
  // session was negotiated fresh, with a live relay socket and current peer metadata.
  //
  // Deliberately narrow, because this friction is worth paying only where it buys something:
  //   • Valora only — identified from the session's own peer metadata, the sole signal
  //     available (its in-app browser injects nothing and reports a stock Chrome user agent).
  //   • Restored sessions only — a connection the user just asked for is never yanked out from
  //     under them (userInitiatedConnect).
  //   • Once per mount, so it can't fight a connect that's mid-flight.
  useEffect(() => {
    if (environment !== 'WEB' || !isWagmiConnected || !wagmiConnector) return;
    if (userInitiatedConnect.current || valoraAutoConnectChecked.current) return;
    valoraAutoConnectChecked.current = true;

    let cancelled = false;
    (async () => {
      if (!(await connectedWalletIsValora(wagmiConnector)) || cancelled) return;
      console.warn('[wallet] dropping a restored Valora session — Valora must pair fresh over WalletConnect.');
      try { disconnect(); } catch { /* best effort */ }
      localStorage.removeItem('abapay_connected');
      setConnectError('Tap Connect to link Valora — it needs a fresh WalletConnect session each time.');
    })();
    return () => { cancelled = true; };
  }, [environment, isWagmiConnected, wagmiConnector, disconnect]);

  // ⚡ FOLLOW THE WALLET ONTO A CHAIN IT CAN ACTUALLY TRANSACT ON ⚡
  //
  // 🔴 THE VALORA HANG. A WalletConnect wallet silently DROPS requests for a chain outside its
  // approved session — no prompt, no error, nothing back. Valora is Celo-only, and wagmi asks
  // for chains[0], which became Base when Base became the default. The session then looks
  // perfectly healthy (address set, balances rendering off a public RPC that needs no wallet)
  // right up until the first transaction vanishes into the void.
  //
  // So the app follows the WALLET rather than insisting on its own default: if the connected
  // wallet never approved the active chain, move the app to the first of our chains that it did
  // approve. A Valora user lands on Celo and pays normally, instead of watching a spinner
  // forever on Base. Injected wallets report null (unknowable, and switchable anyway) and are
  // left alone by the guard above.
  useEffect(() => {
    if (environment !== 'WEB' || !isWagmiConnected || !wagmiConnector || !activeChain) return;
    let cancelled = false;
    (async () => {
      const approved = await walletApprovedChainIds(wagmiConnector);
      if (cancelled || !approved || approved.includes(activeChain.id)) return;

      const fallback = [base, baseSepolia, celo, celoSepolia].find((c) => approved.includes(c.id));
      if (!fallback) {
        // The wallet approved nothing we support. Say so rather than letting the user discover
        // it by watching a payment silently fail.
        setStatus(`This wallet isn't connected to a network AbaPay supports. Reconnect it on Base or Celo.`);
        return;
      }
      console.warn(`[wallet] wallet has not approved chain ${activeChain.id}; following it to ${fallback.name}`);
      setActiveChain(fallback);
    })();
    return () => { cancelled = true; };
  }, [environment, isWagmiConnected, wagmiConnector, activeChain]);

  // ⚡ PUT THE WALLET ON A CHAIN WE ACTUALLY SUPPORT ⚡
  //
  // A wallet connects on whatever chain it happened to be on. If that is not one of ours,
  // `wagmiChain` is undefined, `useWalletClient()` throws, and every signature would be
  // attempted against the wrong network. Ask once, right after connecting, and let the user
  // decline — declining leaves them on the fallback client above rather than stuck.
  useEffect(() => {
    if (environment !== 'WEB' || !isWagmiConnected || wagmiChain || !switchChain) return;
    if (chainSwitchAsked.current) return;
    chainSwitchAsked.current = true;
    switchChain(
      { chainId: (isMainnet ? base : baseSepolia).id },
      { onError: () => { /* declined or unsupported — the fallback client still works */ } },
    );
  }, [environment, isWagmiConnected, wagmiChain, switchChain, isMainnet]);

  // ⚡ CAN THIS WALLET RETURN AN x402 SIGNATURE AT ALL? ⚡
  //
  // x402 needs an `eth_signTypedData_v4` signature to come BACK to the page, and a WalletConnect
  // session that never negotiated that method drops the request on the floor — no prompt, no
  // error, nothing back. Asking anyway is not a rail choice, it is a guaranteed wait followed by
  // the fallback, so the capability is resolved ONCE per connection (from the session, see
  // walletCanSignTypedData) and the rail is picked from the answer.
  //
  // 🔴 IT NO LONGER NAMES A WALLET. This used to answer false for Valora outright, on the
  // strength of Valora rendering the request as "Verify wallet" and reporting "Connection to
  // AbaPay was successful!" without returning a signature — which took the x402 rail away from
  // Valora on Celo AND Base permanently. A wallet that MIGHT not answer is not the same as one
  // that cannot: the rail is tried, and an unanswered signature now falls back on its own (see
  // the WalletTimeoutError branch in processX402Payment) instead of stranding the payment. That
  // fallback is what made it safe to stop guessing on the wallet's behalf.
  //
  // Defaults to true so the common case — an injected wallet, verified working — is never
  // demoted by a check that hasn't resolved yet.
  const [walletSupportsX402, setWalletSupportsX402] = useState(true);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const capable = await walletCanSignTypedData(wagmiConnector);
      if (!cancelled) setWalletSupportsX402(capable);
    })();
    return () => { cancelled = true; };
  }, [wagmiConnector, isWagmiConnected]);

  // ⚡ 2. THE CHAMELEON ENVIRONMENT DETECTOR ⚡
  //
  // 🔴 IT USED TO RE-DETECT EVERY TIME IT DETECTED SOMETHING — AND RECONNECT THE WALLET EACH TIME.
  //
  // `environment` was in this effect's dependency array while `detectAndConnect` is what SETS
  // `environment`. So the very first successful detection changed a dependency and re-ran the
  // whole effect: detect MiniPay, setEnvironment('MINIPAY'), connectMiniPay() — then immediately
  // detect MiniPay again and call connectMiniPay() a SECOND time. That second call builds a brand
  // new viem wallet client and hands it to setMinipayPending, which changes `proofSigner`'s
  // identity, which changes the verification effect's dependencies WHILE the wallet is showing
  // its signature prompt. The deadlock that produced is written up in full on that effect; the
  // short version is that the signature came back to an effect run that had already been told to
  // throw its answer away, and "Verifying" then span forever whether the user signed or cancelled.
  //
  // It also meant MiniPay was asked for accounts twice on every load, and Farcaster likewise got
  // a fresh client and a repeat setAddress/setClient on each pass.
  //
  // Detection is a once-per-page-load question, so it is now guarded by a ref and no longer
  // depends on its own output. The 2-second LOADING fallback reads `environment` through a ref
  // for the same reason — it needs the current value without making that value a trigger.
  const environmentDetectionStarted = useRef(false);
  const environmentRef = useRef(environment);
  environmentRef.current = environment;

  useEffect(() => {
    if (environmentDetectionStarted.current) return;
    environmentDetectionStarted.current = true;

    let timeoutId: NodeJS.Timeout;

    const detectAndConnect = async () => {
      try {
        // Option 1: Farcaster SDK
        const context = await sdk.context;
        if (context && context.client) {
          setEnvironment('FARCASTER');
          const targetChain = isMainnet ? base : baseSepolia;
          setActiveChain(targetChain);

          const farcasterClient = createWalletClient({ 
              chain: targetChain, 
              transport: custom(sdk.wallet.ethProvider) 
          }).extend(eip5792Actions());

          try {
             // ⚡ THE FIX: We use getAddresses() for a SILENT check. 
             // This absolutely prevents the automatic popup on load!
             const addresses = await farcasterClient.getAddresses();

             if (addresses && addresses.length > 0) {
                 const currentChainId = await farcasterClient.getChainId();
                 if (currentChainId !== targetChain.id) {
                     await farcasterClient.switchChain({ id: targetChain.id }).catch(()=>{});
                 }
                 setAddress(addresses[0]); 
                 setClient(farcasterClient);
             }
          } catch(e) {
             console.log("Silent check returned empty. Waiting for user to click Connect.");
          }
          return;
        }

        // Option 2: Opera MiniPay — connectMiniPay() is the same sequence a Connect-button
        // retry uses, factored out so there is exactly one place this logic lives.
        if (typeof window !== "undefined" && (window as any).ethereum && (window as any).ethereum.isMiniPay) {
          setEnvironment('MINIPAY');
          await connectMiniPay();
          return;
        }

        // Option 3: Wagmi Web Bridge
        setEnvironment('WEB');

      } catch (error) {
        setEnvironment('WEB');
      }
    };

    timeoutId = setTimeout(() => {
        if (environmentRef.current === 'LOADING') setEnvironment('WEB');
    }, 2000);

    detectAndConnect();

    return () => clearTimeout(timeoutId);
    // `environment` is deliberately NOT a dependency — this effect sets it, and depending on it is
    // what made detection re-enter and reconnect the wallet mid-verification (see above). The two
    // remaining deps are stable for the life of the page (`isMainnet` comes from an env var,
    // `connectMiniPay` is a useCallback over it), so with the ref guard this runs exactly once.
  }, [isMainnet, connectMiniPay]);

  useEffect(() => {
    fetch('https://open.er-api.com/v6/latest/USD')
      .then(res => res.json())
      .then(data => { if(data && data.rates) setGlobalFiatRates(data.rates); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!address) { setTransactions([]); return; }
    // 🔴 CACHED HISTORY IS STILL HISTORY. This restored the last-seen rows from localStorage
    // BEFORE any ownership check, so cancelling the verification left the previous session's
    // payments on screen — "I cancel the verify wallet pop up and I am still seeing my history".
    // Proof first, then anything that reveals what this wallet has paid for.
    if (!walletProofHeaders()) { setTransactions([]); return; }
    try { const savedLocalHistory = localStorage.getItem(`abapay_history_${address}`); if (savedLocalHistory) setTransactions(JSON.parse(savedLocalHistory)); } catch (e) {}

    async function fetchCloudHistory() {
      try {
        // 🔴 READ THROUGH THE SERVER, AGAINST A PROVEN ADDRESS.
        //
        // This used to query Supabase straight from the browser with the anon key, scoped only
        // by `.ilike('wallet_address', address)` — a filter written by the client, which is not
        // a permission. Any address the page believed it held returned that address's payments:
        // phone numbers, meter numbers, amounts. GET /api/history takes the address from the
        // SIGNATURE instead (see walletProof), so there is no parameter left to point at someone
        // else's records, and migration 025 removes the anon policies that allowed the old read.
        //
        // No proof yet means no history — not an error. The signature may still be sitting in
        // the user's wallet, and this effect re-runs when it lands.
        const headers = walletProofHeaders();
        if (!headers) return;

        const res = await fetch('/api/history', { headers });
        if (!res.ok) {
          // 401 here means the proof expired or was never valid — drop it so the effect above
          // asks for a fresh signature rather than retrying a dead one forever.
          if (res.status === 401) {
            try { sessionStorage.removeItem(`abapay_wallet_proof_${address!.toLowerCase()}`); } catch { /* private mode */ }
            setWalletProof(null);
          }
          return;
        }
        const { transactions: data } = await res.json() as { transactions: any[] };
        if (data && data.length > 0) {
          const cloudHistory = data.map((tx: any) => ({ 
             id: tx.tx_hash.slice(0, 8), date: new Date(tx.created_at).toLocaleString(), status: tx.status, 
             // ⚡ International transactions were saved with a formatted display_amount (e.g. "GHS 2.50") — use it instead of the NGN equivalent
             amountNaira: (tx.country_code && tx.display_amount) ? tx.display_amount : tx.amount_naira.toString(), amountCrypto: tx.amount_usdt.toString(), 
             tokenUsed: tx.token_used || "USD₮", service: tx.service_category, network: tx.network, 
             blockchain: tx.blockchain || 'CELO', country_code: tx.country_code || null,
             txHash: tx.tx_hash, account: tx.account_number, refund_hash: tx.refund_hash,
             purchased_code: tx.purchased_code, request_id: tx.request_id, units: tx.units,
             customerName: tx.customer_name || null,
             // ⚡ service_id drives the provider logo on the history row and the receipt
             // (logoForServiceId). customerAddress is the verified meter address — it was
             // already reaching the EMAIL receipt but was dropped on the way to the in-app one,
             // so the same payment showed the address in your inbox and not in the app.
             serviceId: tx.service_id || null,
             customerAddress: tx.customer_address || null,
             // 'prepaid' | 'postpaid' — the receipt uses it to say why a postpaid purchase has
             // no meter token, instead of just omitting the row and leaving the customer to guess.
             variationCode: tx.variation_code || null,
          }));
          setTransactions(cloudHistory); localStorage.setItem(`abapay_history_${address}`, JSON.stringify(cloudHistory));
        }
      } catch (e) {}
    }
    fetchCloudHistory();
  }, [address, walletProofHeaders]);

  useEffect(() => {
    if (!address) { setBeneficiaries({}); return; }
    try { const saved = localStorage.getItem(`abapay_beneficiaries_${address}`); if (saved) setBeneficiaries(JSON.parse(saved)); else setBeneficiaries({}); } catch (e) {}
  }, [address]);

  // 🔴 THE SAME STALE-AFTER-DISCONNECT CLASS AS THE BALANCE BELOW, FOUND WHILE AUDITING FOR IT.
  //
  // `agentAllowance` is only ever cleared by checkAgentAllowanceFor, and that runs from the Agent
  // Hub — nothing calls it when the wallet leaves. So opening the Agent Hub, disconnecting, and
  // looking again showed the previous wallet's "Agent can spend up to…" figure, which is both
  // wrong and reads as though the departed wallet still has a live approval. Not reported yet;
  // it is the identical shape of bug and cheap to close now rather than after someone hits it.
  useEffect(() => { if (!address) setAgentAllowance(null); }, [address]);

  useEffect(() => {
    // 🔴 DISCONNECTING MUST ZERO THE BALANCE — IT USED TO LEAVE THE LAST ONE ON SCREEN.
    //
    // "When I exit the wallet the balance is not turning to zero in MiniPay." This effect re-runs
    // when `address` goes null, and `fetchBalance` then bailed on its own `if (!address) return`
    // WITHOUT touching `walletBalance` — so the last figure fetched for the wallet that just left
    // stayed rendered, and `isFetchingBalance` kept whatever value it had. Every sibling effect
    // already gets this right (`if (!address) { setTransactions([]); return; }` and the
    // beneficiaries one directly above); this was the one that only guarded and never cleared.
    //
    // Not MiniPay-specific despite where it was noticed — it is keyed on `address`, so any
    // disconnect in any environment left a stale balance behind.
    if (!address || !activeChain) {
      setWalletBalance("0.00");
      setIsFetchingBalance(false);
      return;
    }

    async function fetchBalance() {
      if (!address || !activeChain) return;
      setIsFetchingBalance(true);

      try {
        // ⚡ THE MINIPAY FIX: Force Wagmi to use rock-solid public RPCs for reading balances!
        let rpcUrl = activeChain.rpcUrls.default.http[0];
        if (activeChain.id === celo.id) rpcUrl = "https://forno.celo.org";
        if (activeChain.id === base.id) rpcUrl = "https://mainnet.base.org";

        // We use http(rpcUrl) instead of MiniPay's custom injected provider for reads
        const publicClient = createPublicClient({ chain: activeChain, transport: http(rpcUrl) });

        // ⚡ DYNAMIC TOKEN SELECTION
        let tokenAddress;
        if (activeChain.id === base.id) {
            tokenAddress = (selectedToken as any).baseMainnet || selectedToken.mainnet;
        } else if (activeChain.id === baseSepolia.id) {
            tokenAddress = (selectedToken as any).baseSepolia || selectedToken.sepolia;
        } else if (activeChain.id === celo.id) {
            tokenAddress = (selectedToken as any).celoMainnet || selectedToken.mainnet;
        } else {
            tokenAddress = (selectedToken as any).celoSepolia || selectedToken.sepolia;
        }

        if (!tokenAddress) {
            setWalletBalance("0.00");
            setIsFetchingBalance(false);
            return;
        }

        const balanceWei = await publicClient.readContract({ address: tokenAddress as `0x${string}`, abi: ERC20_ABI, functionName: 'balanceOf', args: [address] });
        setWalletBalance(parseFloat(formatUnits(balanceWei as bigint, selectedToken.decimals)).toFixed(4));
      } catch (error) { 
        console.error("Balance fetch error:", error);
        setWalletBalance("0.00"); 
      }
      setIsFetchingBalance(false);
    }
    fetchBalance();
  }, [address, selectedToken, activeChain, environment]);

  useEffect(() => { fetchBanksManual(); }, []);

  useEffect(() => {
    fetch('/api/intl?action=countries')
      .then(res => res.json())
      .then(data => {
          const countriesArr = extractVtpassArray(data);
          if (countriesArr && countriesArr.length > 0) {
              // ⚡ `flag` is VTpass's own flag image URL. It was being DROPPED here, so the
              // picker fell back to a third-party flag CDN (flagcdn.com) for every country —
              // an extra external dependency for artwork VTpass already hands us in the same
              // response. Carried through now; flagcdn stays as the fallback in SelectionModal.
              const fetched = countriesArr.map((c: any) => ({
                  code: c.code || c.country_code || c.id,
                  name: c.name || c.country || c.title,
                  currency: c.currency || c.currency_code || c.Currency,
                  flag: c.flag
              })).filter((c:any) => c.code && c.name);
              const merged = [...SUPPORTED_COUNTRIES.filter(c=>!c.disabled), ...fetched.filter((c:any) => c.code !== "NG")];
              setIntlCountries(merged);
          } else {
              setIntlCountries(SUPPORTED_COUNTRIES.filter(c=>!c.disabled));
          }
      })
      .catch(()=>setIntlCountries(SUPPORTED_COUNTRIES.filter(c=>!c.disabled)));
  }, []);

  useEffect(() => {
    if (isInternational) {
        setIsIntlLoading(true);
        fetch(`/api/intl?action=products&code=${activeCountry.code}`)
          .then(res => res.json())
          .then(data => {
              const arr = extractVtpassArray(data);
              if (arr && arr.length > 0) setIntlProductTypes(arr);
              else setIntlProductTypes([]);
          })
          .catch(()=>setIntlProductTypes([]))
          .finally(()=>setIsIntlLoading(false));
    }
  }, [activeCountry, isInternational]);

  useEffect(() => {
    if (isInternational && selectedIntlProduct) {
        const typeId = selectedIntlProduct.product_type_id || selectedIntlProduct.id;
        setIsIntlLoading(true); setIntlOperators([]); setIntlVariations([]); setSelectedIntlOperator(null); setSelectedIntlVariation(null);
        fetch(`/api/intl?action=operators&code=${activeCountry.code}&type_id=${typeId}`)
          .then(res => res.json())
          .then(data => {
              const arr = extractVtpassArray(data);
              if (arr && arr.length > 0) setIntlOperators(arr);
          })
          .catch(()=>setIntlOperators([]))
          .finally(()=>setIsIntlLoading(false));
    }
  }, [selectedIntlProduct, activeCountry, isInternational]);

  useEffect(() => {
    if (isInternational && selectedIntlOperator && selectedIntlProduct) {
        const operatorId = selectedIntlOperator.operator_id || selectedIntlOperator.id;
        const typeId = selectedIntlProduct.product_type_id || selectedIntlProduct.id;
        setIsIntlLoading(true); setIntlVariations([]); setSelectedIntlVariation(null); setIntlCurrency("");

        fetch(`/api/intl?action=variations&operator_id=${operatorId}&type_id=${typeId}`)
          .then(res => res.json())
          .then(data => {
              if (data?.content?.Currency || data?.content?.currency) {
                  setIntlCurrency(data.content.Currency || data.content.currency);
              } else if (data?.Currency || data?.currency) {
                  setIntlCurrency(data.Currency || data.currency);
              }
              const arr = extractVtpassArray(data);
              if (arr && arr.length > 0) setIntlVariations(arr);
          })
          .catch(()=>setIntlVariations([]))
          .finally(()=>setIsIntlLoading(false));
    }
  }, [selectedIntlOperator, selectedIntlProduct, isInternational]);

  useEffect(() => {
    if (activeTab === "education" && !isInternational) {
      const fetchEducation = async () => {
        setEducationVariations([]);
        try {
          const res = await fetch(`/api/variations?serviceID=${educationProvider}`);
          const data = await res.json();
          if (data.code === '011') setEducationVariations([]); 
          else setEducationVariations(extractVtpassArray(data) || []);
        } catch (e) { setEducationVariations([]); }
      };
      fetchEducation();
    }
  }, [activeTab, educationProvider, isInternational]);

  useEffect(() => {
    if (activeTab !== "pay" || isInternational) return;
    if (activeService.id === "CABLE") {
      const fetchVariations = async () => { 
        try { 
          const res = await fetch(`/api/variations?serviceID=${cableProvider}`); 
          const data = await res.json(); 
          if (data.code === '011') setCableVariations([]); 
          else setCableVariations(extractVtpassArray(data) || []); 
        } catch (e) { setCableVariations([]); } 
      }; 
      fetchVariations();
    } else if (activeService.id === "INTERNET") {
      const fetchInternetVariations = async () => { 
        setInternetVariations([]); 
        try { 
          const res = await fetch(`/api/variations?serviceID=${internetProvider}`); 
          const data = await res.json(); 
          if (data.code === '011' || data.error) setInternetVariations([]); 
          else setInternetVariations(extractVtpassArray(data) || []); 
        } catch (e) { setInternetVariations([]); } 
      }; 
      fetchInternetVariations();
    }
  }, [activeTab, activeService.id, cableProvider, internetProvider, isInternational]);

  useEffect(() => {
    if (activeTab === "pay" && !isInternational) {
      if (activeService.id === "AIRTIME" && accountNumber.length >= 4) {
        const prefix = accountNumber.substring(0, 4);
        if (["0803","0806","0810","0813","0814","0816","0903","0906","0913","0916","0703","0706"].includes(prefix)) setTelecomProvider("mtn");
        else if (["0802","0808","0812","0902","0907","0912","0701","0708"].includes(prefix)) setTelecomProvider("airtel");
        else if (["0805","0807","0811","0905","0705","0915"].includes(prefix)) setTelecomProvider("glo");
        else if (["0809","0817","0818","0908","0909"].includes(prefix)) setTelecomProvider("etisalat");
      }
      if (activeService.id === "INTERNET" && internetProvider.includes("-data") && accountNumber.length >= 4) {
        const prefix = accountNumber.substring(0, 4);
        let detected: string | null = null;
        if (["0803","0806","0810","0813","0814","0816","0903","0906","0913","0916","0703","0706"].includes(prefix)) detected = "mtn-data";
        else if (["0802","0808","0812","0902","0907","0912","0701","0708"].includes(prefix)) detected = "airtel-data";
        else if (["0805","0807","0811","0905","0705","0915"].includes(prefix)) detected = "glo-data";
        else if (["0809","0817","0818","0908","0909"].includes(prefix)) detected = "etisalat-data";

        // 🔴 THE STALE-PLAN BUG: if the number's prefix flips the network (e.g. user picked
        // MTN, chose an MTN plan, then typed a Glo number), the previously-selected plan
        // belongs to the OLD network and can't be vended under the new one — VTpass rejects
        // it. The manual provider dropdown already clears the plan on change (see handleProvider
        // change); the auto-detect never did, so the mismatched plan sailed through to a failed
        // payment. Clear the plan (and its amount) whenever auto-detect actually switches the
        // network, forcing the user to pick a plan that belongs to the detected network.
        if (detected && detected !== internetProvider) {
          setInternetProvider(detected);
          setSelectedInternetPlan(null);
          setNairaAmount("");
          setInternetVariations([]);
        }
      }
    }
  }, [accountNumber, activeService.id, activeTab, internetProvider, isInternational]);

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      if (activeTab === "bank") {
          // 🔴 THE BUG THIS FIXES: this always ran the full auto-detect sweep (~25 banks in
          // parallel) regardless of whether a bank was ALREADY manually selected — so picking
          // a bank first, then typing the account number, ran the slow multi-bank resolve
          // instead of a single fast verify against the bank already chosen. That's exactly
          // backwards: a manual pick is the user telling us which bank it is, so there's
          // nothing left to detect. Only run the full sweep when no bank is selected yet.
          if (accountNumber.length === 10) {
            if (selectedBank?.variation_code) verifyBankAccount(selectedBank.variation_code);
            else resolveBankAccount();
          }
          else {
            setCustomerName(null); setBankSuggestions([]); setMeterAddress(null); setDynamicElecMin(1000); setMeterAccountType(null);
            // 🔴 THE BUG THIS FIXES: clearing the account number left `selectedBank` (auto-
            // detected or manually picked) untouched — so retyping a fresh number routed to
            // verifyBankAccount() against the STALE bank instead of re-running auto-detect,
            // and the "Select Bank" button kept showing the old bank as if the user had
            // chosen it again. Only reset on a full clear (not mid-edit backspacing), so a
            // manual pick made before typing digits still survives a typo correction.
            if (accountNumber.length === 0) setSelectedBank(null);
          }
      }
      else if (activeTab === "education" && educationProvider === "jamb") {
         if (accountNumber.length >= 10 && selectedEducationPlan) verifyMerchant(); 
         else { setCustomerName(null); setMeterAddress(null); setDynamicElecMin(1000); setMeterAccountType(null); }
      }
      else if (activeTab === "pay" && !isInternational) {
         if (activeService.id === "ELECTRICITY" && accountNumber.length >= 10) verifyMerchant();
         else if (activeService.id === "CABLE" && cableProvider !== "showmax" && accountNumber.length >= 10) verifyMerchant();
         else if (activeService.id === "INTERNET" && internetProvider === "smile-direct" && accountNumber.includes('@') && accountNumber.includes('.')) verifyMerchant(); 
         else { setCustomerName(null); setMeterAddress(null); setDynamicElecMin(1000); setMeterAccountType(null); }
      }
    }, 800); 
    return () => clearTimeout(timeoutId);
  }, [accountNumber, elecProvider, cableProvider, activeService.id, meterType, internetProvider, activeTab, educationProvider, selectedEducationPlan, isInternational]);

  const getCurrentModalValue = () => {
    if (modalType === 'country') return activeCountry.code;
    if (modalType === 'bank') return selectedBank?.variation_code;
    if (modalType === 'token') return selectedToken.symbol;
    if (modalType === 'provider') {
      if (activeTab === 'education') return educationProvider;
      if (activeService.id === 'ELECTRICITY') return elecProvider;
      if (activeService.id === 'INTERNET') return internetProvider;
      if (activeService.id === 'CABLE') return cableProvider;
    }
    if (modalType === 'standard') return telecomProvider;
    return null;
  };

  return (
    // ⚡ 1. UPDATED MAIN TAG: Centers vertically on PC and adds padding + Dark Mode Base
    // overflow-hidden is md: only — it exists purely to clip the decorative PC-only glow
    // blobs below. Applied unconditionally, it clips `position: fixed` descendants (the
    // AIChat bubble, the header agent badge) on mobile WebKit, hiding them entirely.
    <main className="min-h-screen bg-slate-50 dark:bg-black text-slate-900 dark:text-slate-100 font-sans p-4 md:p-8 lg:p-12 flex flex-col items-center justify-start md:justify-center pb-20 md:pb-12 relative md:overflow-hidden transition-colors">
      <style>{`.no-scrollbar::-webkit-scrollbar { display: none; } .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }`}</style>

      {/* ⚡ 2. NEW: Premium Ambient Web3 Glows (Only visible on PC) ⚡ */}
      <div className="hidden md:block absolute top-[-10%] left-[-5%] w-[40%] h-[40%] rounded-full bg-emerald-500/10 dark:bg-emerald-500/5 blur-[120px] pointer-events-none"></div>
      <div className="hidden md:block absolute bottom-[-10%] right-[-5%] w-[40%] h-[40%] rounded-full bg-blue-500/10 dark:bg-blue-500/5 blur-[120px] pointer-events-none"></div>

      {isConfirmModalOpen && (
        <div className="fixed inset-0 z-[300] flex items-end sm:items-center justify-center bg-slate-900/60 dark:bg-black/80 backdrop-blur-md animate-in fade-in duration-200 transition-colors">
           <div className="bg-white dark:bg-[#111114] w-full max-w-md rounded-t-[2.5rem] sm:rounded-[2.5rem] p-6 pb-10 sm:pb-6 shadow-2xl dark:shadow-black/50 relative animate-in slide-in-from-bottom-10 sm:zoom-in-95 duration-300 transition-colors">
              <div className="w-12 h-1.5 bg-slate-200 dark:bg-slate-800 rounded-full mx-auto mb-6 sm:hidden"></div>

              <div className="flex justify-between items-center mb-6">
                 <h3 className="text-xl font-black text-slate-900 dark:text-white tracking-tight">Confirm Payment</h3>
                 <button onClick={() => setIsConfirmModalOpen(false)} className="bg-slate-100 dark:bg-slate-800 p-2 rounded-full text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"><XCircle size={20}/></button>
              </div>

              {hasPendingDuplicate && (
                 <div className="bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800/50 p-4 rounded-2xl mb-6 flex items-start gap-3 animate-in slide-in-from-top-2 transition-colors">
                    <AlertTriangle className="text-orange-500 dark:text-orange-400 shrink-0 mt-0.5" size={20} />
                    <div>
                       <p className="text-sm font-black text-orange-800 dark:text-orange-300 tracking-tight">Pending Transaction Detected</p>
                       <p className="text-xs font-bold text-orange-600 dark:text-orange-400 leading-snug mt-1">
                          You already have a processing transaction for this exact amount and number. Proceed only if you intend to pay twice.
                       </p>
                    </div>
                 </div>
              )}

              <div className="text-center mb-8">
                 <p className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-2">Total Payable</p>

                 {discountNgn > 0 && (
                    <p className="text-sm font-bold text-slate-400 dark:text-slate-500 line-through mb-0.5">
                       {isInternational
                         ? `${intlCurrency || activeCountry.currency || activeCountry.code} ${displayForeignAmount}`
                         : `₦${(parseFloat(calculatedNairaAmount || "0") + currentFee).toLocaleString()}`}
                    </p>
                 )}

                 <h2 className="text-4xl font-black text-slate-900 dark:text-white mb-2">
                    {isInternational
                      ? `${intlCurrency || activeCountry.currency || activeCountry.code} ${(Math.max(0, (parseFloat(String(displayForeignAmount).replace(/,/g, '')) || 0) - (foreignDiscountAmount || 0))).toLocaleString()}`
                      : `₦${(parseFloat(calculatedNairaAmount || "0") + currentFee - discountNgn).toLocaleString()}`}
                 </h2>

                 {discountNgn > 0 && (
                    <p className="text-xs font-black text-emerald-600 dark:text-emerald-400 mb-2">
                       🎉 {activeDiscount?.name || "Discount"} applied: -{isInternational
                         ? `${intlCurrency || activeCountry.currency || activeCountry.code} ${(foreignDiscountAmount || 0).toLocaleString()}`
                         : `₦${discountNgn.toLocaleString()}`}
                    </p>
                 )}

                 <div className="flex items-center justify-center gap-1.5 text-emerald-600 dark:text-emerald-400 font-bold bg-emerald-50 dark:bg-emerald-900/20 w-max mx-auto px-4 py-1.5 rounded-full text-sm shadow-inner transition-colors">
                    <img src={selectedToken.logo} alt="token" className="w-4 h-4 rounded-full"/>
                    {cryptoToCharge} {selectedToken.symbol}
                 </div>
              </div>

              <div className="bg-slate-50 dark:bg-[#1a1a1f] border border-slate-100 dark:border-slate-800/60 rounded-3xl p-5 space-y-4 mb-8 shadow-sm transition-colors">
                 <div className="flex justify-between items-center">
                    <span className="text-xs font-bold text-slate-500 dark:text-slate-400">Service</span>
                    <span className="text-sm font-black text-slate-900 dark:text-white text-right">{checkoutDetails.title}</span>
                 </div>
                 <div className="flex justify-between items-center">
                    <span className="text-xs font-bold text-slate-500 dark:text-slate-400">{checkoutDetails.recipientLabel}</span>
                    <span className="text-sm font-black text-slate-900 dark:text-white text-right">{checkoutDetails.recipient}</span>
                 </div>
                 {customerName && (
                     <div className="flex justify-between items-center">
                        <span className="text-xs font-bold text-slate-500 dark:text-slate-400">Customer</span>
                        <span className="text-sm font-black text-slate-900 dark:text-white truncate max-w-[180px] text-right">{customerName}</span>
                     </div>
                 )}
                 <div className="flex justify-between items-center pt-4 border-t border-slate-200/60 dark:border-slate-800/80 mt-2">
                    <span className="text-xs font-bold text-slate-500 dark:text-slate-400">Processing Fee</span>
                    <span className={`text-sm font-black ${currentFee > 0 ? 'text-orange-500 dark:text-orange-400' : 'text-emerald-500 dark:text-emerald-400'}`}>
                       {currentFee > 0 ? `₦${currentFee}` : 'Free'}
                    </span>
                 </div>
              </div>

              <button
                  onClick={() => {
                      setIsConfirmModalOpen(false);
                      // ⚡ x402 is the automatic settlement rail — no user-facing toggle:
                      //   • Celo + USDC/USD₮ (both have EIP-3009) → Celo facilitator
                      //   • Base + USDC (Base USD₮ has no transferWithAuthorization) → Coinbase
                      //     CDP facilitator, ONLY when NEXT_PUBLIC_BASE_X402_ENABLED === 'true'
                      //     (server-side CDP creds must be configured too — see route.ts).
                      // Everything else (cUSD/USDm, Base while x402 disabled, x402 unconfigured)
                      // uses the normal contract-call flow, unchanged. See README "x402 settlement".
                      // ⚡ x402 IS THE DEFAULT RAIL ON BOTH CHAINS — Celo (USDC/USD₮) and Base
                      // (USDC) — so payments are genuinely indexed on x402scan rather than
                      // being relabeled contract calls.
                      //
                      // ⚠️ A NOTE ON THE WALLET WARNING, since it will come up again. x402
                      // settles via an EIP-3009 `transferWithAuthorization` signature, which is
                      // structurally the same request a token-drainer makes, so some wallet
                      // security scanners flag it — Zerion has shown AbaPay's own request as
                      // "Malicious Request. Approving this may risk total asset loss." on a
                      // routine bill payment, while the same payment via the contract call
                      // reads as an ordinary Send. This is inherent to x402, not a bug in the
                      // request, and it is a deliberate, owner-made trade for x402scan
                      // visibility. Set NEXT_PUBLIC_X402_ENABLED=false (or
                      // NEXT_PUBLIC_BASE_X402_ENABLED=false for Base alone) to fall back to the
                      // contract-call rail, which behaves identically for the user otherwise.
                      const x402Enabled = process.env.NEXT_PUBLIC_X402_ENABLED !== 'false';
                      // 🔴 THE REMAINING LIMIT IS THE TOKEN, NOT THE CHAIN AND NOT THE WALLET.
                      // x402 settles on an EIP-3009 `transferWithAuthorization` signature, so it
                      // only works on tokens that actually implement one. Celo's USDC and USD₮
                      // both do; on Base, USDC does and Tether's USD₮ does NOT — there is no
                      // such function on that contract to sign against, so routing it through
                      // x402 would fail at settlement rather than fall back gracefully.
                      //
                      // That is why the chain's LEAD stablecoin matters so much: Base leads with
                      // USDC (constants/TOKEN_ORDER_BY_CHAIN), so the default path on Base is
                      // x402. Until the token-reset effect above was keyed on chain ID, arriving
                      // on Base kept USD₮ selected from Celo and quietly demoted every Base user
                      // to the contract call — which is exactly what was reported.
                      // celoSepolia included so a testnet run exercises the SAME rail the
                      // live one uses — it was mainnet-only here while processX402Payment below
                      // already accepted both, so testing on Celo Sepolia silently rehearsed the
                      // contract call and proved nothing about x402.
                      // USA₮ settles on x402 exactly like Celo USD₮ — it implements EIP-3009 and
                      // its EIP-712 domain is verified against the contract's own
                      // DOMAIN_SEPARATOR (see X402_DOMAINS_BY_CHAIN.CELO). Leaving it out of this
                      // list is what would quietly demote it to the contract call — the same way
                      // arriving on Base with USD₮ selected used to.
                      const celoX402 = (activeChain?.id === celo.id || activeChain?.id === celoSepolia.id)
                        && CELO_X402_TOKENS.includes(selectedToken.symbol);
                      const baseX402 = (activeChain?.id === base.id || activeChain?.id === baseSepolia.id) && selectedToken.symbol === "USDC" && process.env.NEXT_PUBLIC_BASE_X402_ENABLED !== 'false';

                      // ⚠️ IT BRANCHES ON THE WALLET'S CAPABILITY — NOT ON A WALLET BLOCKLIST,
                      // AND NOT ON THE HOST PAGE. Two earlier versions got this wrong in the
                      // same direction: one restricted x402 to in-browser wallets, and one named
                      // Valora and sent it straight to the contract call on BOTH chains. The
                      // second is the "the Base and Celo x402 route are both ignored in Valora"
                      // report, and it was self-fulfilling — a wallet routed off the rail can
                      // never demonstrate it works on it.
                      //
                      // walletSupportsX402 now asks only what the SESSION can answer: was
                      // signTypedData negotiated at all? A wallet that never negotiated it drops
                      // the request silently, so asking buys nothing. Every other wallet is
                      // ASKED, and its own answer decides. When the answer never comes — Valora
                      // announcing "Connection to AbaPay was successful!" and returning no
                      // signature is the known case — the signature times out, nothing has been
                      // sent to settle (see src/lib/x402Pay.ts), and processX402Payment's catch
                      // hands the bill to the contract call automatically. That is the
                      // "otherwise fall back to the initial contract call" behaviour, arrived at
                      // by evidence instead of by name. See walletCanSignTypedData.
                      // ⚠️ A HEADROOM GUARD LIVED HERE AND WAS REMOVED — the theory behind it was
                      // wrong, and a guard that diverts real payments must not rest on a guess.
                      //
                      // Two Base failures both sat at ~99.99% of the payer's balance, which looked
                      // like the facilitator needing room for a fee on top of the transfer. The
                      // receipt of a SUCCESSFUL settlement settles it: exactly one Transfer event,
                      // payer -> vault, for exactly the authorized value. CDP takes nothing from
                      // the payer, so there is no fee to leave room for — and the operator reports
                      // paying full balance on this rail for a week without trouble.
                      // Also eliminated, each against CDP or the chain rather than by reasoning:
                      // the signature (verified server-side before settling, and it passes), the
                      // payload shape, the network/scheme/version combination, a minimum-window
                      // rule (a deliberately short window still reached the contract call), the
                      // spent-nonce and blacklist and paused-token conditions, and the
                      // facilitator's own gas (its sender holds ETH and is settling constantly).
                      const useX402 = x402Enabled && walletSupportsX402 && (celoX402 || baseX402);
                      if (useX402) processX402Payment(); else processBlockchainPayment();
                  }}
                  className={`w-full text-white dark:text-slate-900 font-black py-5 rounded-2xl flex items-center justify-center gap-2.5 transition-all active:scale-95 shadow-xl text-lg tracking-tight ${hasPendingDuplicate ? 'bg-orange-500 dark:bg-orange-500 hover:bg-orange-600 dark:hover:bg-orange-600 text-white shadow-orange-500/20' : 'bg-slate-900 dark:bg-white hover:bg-black dark:hover:bg-slate-200 shadow-slate-900/20 dark:shadow-white/10'}`}
              >
                  {hasPendingDuplicate ? <AlertTriangle size={22} className="text-white" /> : <ShieldCheck size={22} className="text-emerald-400 dark:text-emerald-600" />}
                  {hasPendingDuplicate ? 'PROCEED ANYWAY' : 'CONFIRM & PAY'}
              </button>
           </div>
        </div>
      )}

            {isSupportOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-slate-900/50 dark:bg-black/80 backdrop-blur-sm animate-in fade-in transition-colors">
           <div className="bg-white dark:bg-[#111114] w-full max-w-md rounded-[2rem] p-6 shadow-2xl dark:shadow-black/50 relative animate-in zoom-in-95 transition-colors">
              <button onClick={() => { setIsSupportOpen(false); setSupportFile(null); setSupportMessage(""); setSupportEmail(""); }} className="absolute top-4 right-4 bg-slate-100 dark:bg-slate-800 p-2 rounded-full text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"><XCircle size={20}/></button>
              <h3 className="text-xl font-black text-slate-900 dark:text-white mb-2">Need Help?</h3>
              {supportTxHash && <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">Transaction Ref: <span className="font-mono bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded text-slate-700 dark:text-slate-300">{supportTxHash.slice(0, 15)}...</span></p>}

              {/* ⚡ NEW COMPULSORY EMAIL FIELD ⚡ */}
              <input 
                  type="email"
                  placeholder="Your Email Address"
                  className="w-full bg-slate-50 dark:bg-[#1a1a1f] border border-slate-200 dark:border-slate-800/80 p-4 rounded-xl text-sm outline-none focus:border-emerald-500 dark:focus:border-emerald-500 text-slate-900 dark:text-white font-bold mb-3 transition-colors"
                  value={supportEmail}
                  onChange={(e) => setSupportEmail(e.target.value)}
              />

              <textarea 
                  className="w-full bg-slate-50 dark:bg-[#1a1a1f] border border-slate-200 dark:border-slate-800/80 p-4 rounded-xl text-sm outline-none focus:border-emerald-500 dark:focus:border-emerald-500 text-slate-900 dark:text-white min-h-[100px] mb-4 font-medium transition-colors" 
                  placeholder="Describe your issue so our admins can assist you..." 
                  value={supportMessage} 
                  onChange={(e) => setSupportMessage(e.target.value)} 
              />

              <div className="mb-4">
                 <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 mb-2">Attach Screenshot (Optional)</label>
                 <input 
                    type="file" 
                    accept="image/*"
                    onChange={(e) => setSupportFile(e.target.files ? e.target.files[0] : null)}
                    className="w-full text-sm text-slate-500 dark:text-slate-400 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-xs file:font-bold file:bg-emerald-50 dark:file:bg-emerald-900/20 file:text-emerald-700 dark:file:text-emerald-400 hover:file:bg-emerald-100 dark:hover:file:bg-emerald-900/40 transition-colors cursor-pointer"
                 />
              </div>

              <button 
                  onClick={handleSendSupport}
                  disabled={isSendingSupport || !supportMessage.trim() || !supportEmail.trim()}
                  className="w-full bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 disabled:bg-slate-300 dark:disabled:bg-slate-800 text-white font-black py-4 rounded-xl transition-colors tracking-tight flex justify-center items-center gap-2"
              >
                  {isSendingSupport ? <><Loader2 size={18} className="animate-spin"/> SENDING...</> : "SEND TICKET"}
              </button>
           </div>
        </div>
      )}

                  <ReceiptModal 
          receipt={selectedReceipt} 
          isMainnet={isMainnet} 
          onClose={() => setSelectedReceipt(null)} 
          onShare={handleShareReceipt} 
          onSupport={() => { 
              setSupportTxHash(selectedReceipt.txHash); 
              setSupportChain(selectedReceipt.blockchain); // ⚡ ADD THIS TO GRAB THE CHAIN
              setSupportMessage(""); 
              setSupportEmail(customerEmail || ""); 
              setSelectedReceipt(null); 
              setIsSupportOpen(true); 
          }} 
      />
      <SelectionModal 
        isOpen={isSelectionModalOpen} 
        onClose={() => setIsSelectionModalOpen(false)} 
        title={modalTitle} 
        type={modalType} 
        options={modalOptions} 
        onSelect={modalCallback} 
        isFetchingBanks={isFetchingBanks} 
        selectedValue={getCurrentModalValue()} 
        onRetryBanks={fetchBanksManual} 
      />

      {/* ⚡ WHICH BROWSER WALLET? — only ever shown when MORE THAN ONE injected wallet
          answered. A single wallet is connected straight away (it pops its own approval, which
          is the whole point of being in a web3 browser), and a browser with none goes to
          WalletConnect. So this appears exactly when the app genuinely cannot know the answer.
          Backdrop click and Cancel both resolve null, which ends the attempt quietly rather
          than falling through to a QR code the user didn't ask for. */}
      {/* ⚡ THE WALLET CHOOSER — the first screen a new user meets, so it is built like one.
          Rows carry the wallet's OWN logo (EIP-6963 hands us one per wallet) and a status badge,
          because "which of these is the one I already use" is the only question being asked here.
          Base Account and WalletConnect get drawn marks rather than being left as bare letters —
          they have no EIP-6963 icon to offer, and a chooser where two rows look unfinished reads
          as a chooser that does not know what it is offering. */}
      {walletChoice && (
        <div
          className="fixed inset-0 z-[110] bg-slate-900/80 dark:bg-black/90 backdrop-blur-md flex justify-center items-center p-6 animate-in fade-in"
          onClick={() => walletChoice.resolve(null)}
        >
          <div
            className="bg-white dark:bg-[#0e0e11] w-full max-w-sm rounded-[2rem] p-5 shadow-2xl ring-1 ring-slate-200/70 dark:ring-white/10 animate-in zoom-in-95 transition-colors"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <button
                onClick={() => walletChoice.resolve(null)}
                aria-label="Cancel"
                className="w-9 h-9 rounded-full bg-slate-100 dark:bg-white/5 hover:bg-slate-200 dark:hover:bg-white/10 flex items-center justify-center transition-colors shrink-0"
              >
                <ChevronDown size={16} className="rotate-90 text-slate-500 dark:text-slate-400" />
              </button>
              <h3 className="flex-1 text-center text-base font-black text-slate-900 dark:text-white tracking-tight pr-9">
                Choose a wallet
              </h3>
            </div>

            <div className="mt-4 flex flex-col gap-2">
              {walletChoice.options.map((option) => {
                const isWalletConnect = /walletconnect/i.test(option.connector?.id || option.name);
                const isBaseAccount = /baseaccount/i.test(option.connector?.id || '') || /base account/i.test(option.name);
                // "Recent" for a wallet that already approved this site — picking it reconnects
                // with no prompt at all, which is exactly what someone returning wants to know.
                const badge = option.status === 'authorized'
                  ? 'Recent'
                  : isWalletConnect ? 'Scan or link'
                  : isBaseAccount ? 'Sign in'
                  : 'Installed';
                return (
                  <button
                    key={option.connector.uid || option.connector.id}
                    onClick={() => walletChoice.resolve(option)}
                    className="group flex items-center gap-3 p-3 rounded-2xl bg-slate-50 dark:bg-white/[0.04] border border-slate-100 dark:border-white/5 hover:bg-emerald-50 dark:hover:bg-white/[0.08] hover:border-emerald-200 dark:hover:border-white/10 transition-all active:scale-[0.98] text-left"
                  >
                    {option.icon ? (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img src={option.icon} alt="" className="w-9 h-9 rounded-xl object-contain shrink-0" />
                    ) : isWalletConnect ? (
                      <span className="w-9 h-9 rounded-xl bg-[#3396FF]/15 flex items-center justify-center shrink-0">
                        <svg width="20" height="14" viewBox="0 0 32 20" fill="none" aria-hidden="true">
                          <path d="M6.6 5.3c5.2-5.1 13.6-5.1 18.8 0l.6.6c.3.3.3.7 0 1l-2.1 2.1c-.1.1-.4.1-.5 0l-.9-.9c-3.6-3.5-9.5-3.5-13.1 0l-1 1c-.1.1-.4.1-.5 0L5.8 7c-.3-.3-.3-.7 0-1l.8-.7Zm23.2 4.4 1.9 1.8c.3.3.3.7 0 1l-8.4 8.2c-.3.3-.7.3-1 0l-6-5.8c-.1-.1-.2-.1-.3 0l-6 5.8c-.3.3-.7.3-1 0L.6 12.5c-.3-.3-.3-.7 0-1l1.9-1.8c.3-.3.7-.3 1 0l6 5.8c.1.1.2.1.3 0l6-5.8c.3-.3.7-.3 1 0l6 5.8c.1.1.2.1.3 0l6-5.8c.2-.3.7-.3.9 0Z" fill="#3396FF"/>
                        </svg>
                      </span>
                    ) : isBaseAccount ? (
                      <span className="w-9 h-9 rounded-xl bg-[#0052FF] flex items-center justify-center shrink-0">
                        <span className="w-3.5 h-3.5 rounded-full bg-white" />
                      </span>
                    ) : (
                      <span className="w-9 h-9 rounded-xl bg-slate-200 dark:bg-white/10 flex items-center justify-center text-xs font-black text-slate-500 dark:text-slate-300 shrink-0">
                        {option.name.slice(0, 1).toUpperCase()}
                      </span>
                    )}

                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-black text-slate-900 dark:text-slate-100 truncate">{option.name}</span>
                    </span>

                    <span className="shrink-0 text-[9px] font-black uppercase tracking-widest px-2 py-1 rounded-lg bg-white dark:bg-white/10 text-slate-400 dark:text-slate-400 border border-slate-100 dark:border-transparent">
                      {badge}
                    </span>
                  </button>
                );
              })}
            </div>

            <p className="mt-4 text-center text-[10px] font-medium text-slate-400 dark:text-slate-500 leading-relaxed">
              By continuing, you agree to our{' '}
              <Link href="/privacy" className="font-bold text-slate-500 dark:text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400">Privacy Policy</Link>
              {' '}and{' '}
              <Link href="/terms" className="font-bold text-slate-500 dark:text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400">Terms of use</Link>
            </p>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed top-4 right-4 sm:top-6 sm:right-6 z-[100] animate-in slide-in-from-top-8 fade-in duration-300">
          <div className="bg-[#111114] dark:bg-slate-800 border border-slate-800 dark:border-slate-700 shadow-2xl rounded-2xl p-4 flex items-start gap-3 w-[300px]">
            <div className={`p-2 rounded-full shrink-0 ${toast.type === 'success' ? 'bg-emerald-500/10' : 'bg-red-500/10'}`}>
              {toast.type === 'success' ? <CheckCircle2 className="text-emerald-500" size={20} /> : <AlertTriangle className="text-red-500" size={20} />}
            </div>
            <div className="flex-1">
              <h4 className="text-white font-black text-sm tracking-tight">{toast.title}</h4>
              <p className="text-slate-400 text-xs mt-0.5 leading-snug">{toast.message}</p>
            </div>
            <button onClick={() => setToast(null)} className="shrink-0 text-slate-500 hover:text-slate-300"><XCircle size={16} /></button>
          </div>
        </div>
      )}

      {/* ⚡ 3. UPDATED WRAPPER: Intelligently expands to max-w-lg and max-w-xl on PC ⚡ */}
      <div className="w-full max-w-md md:max-w-lg lg:max-w-xl transition-all duration-500 relative z-10">

        {/* ⚡ HEADER: Increased padding and border radius on PC. flex-wrap + gap-y lets the
             right-side pill cluster drop to its own line instead of overlapping the title
             on narrow screens or larger system display-scale settings. ⚡ */}
        <div className="flex flex-wrap justify-between items-center gap-y-3 bg-white dark:bg-[#111114] p-4 md:p-5 rounded-3xl md:rounded-[2rem] shadow-sm border border-slate-100 dark:border-slate-800/60 mb-6 md:mb-8 transition-colors">
          <div className="flex items-center gap-3 min-w-0">
            <img src="/logo.png" alt="AbaPay" className="h-10 md:h-12 w-auto object-contain transition-all shrink-0" />
            <div className="flex flex-col min-w-0">
              <span className="text-xl md:text-2xl font-black text-slate-900 dark:text-white leading-none tracking-tight transition-colors truncate">AbaPay<span className="text-emerald-500">.</span></span>
              <span className="text-[8px] md:text-[9px] font-black uppercase text-slate-400 dark:text-slate-500 tracking-widest mt-1 truncate">Seamless Payments.</span>
            </div>

            {/* ⚡ AGENT quick-access — sits right beside the logo so it's always visible
                 (the AGENT tab lives at the end of a horizontally-scrolling tab row below,
                 which pushes it off-screen on narrow phones with no visible scrollbar hint). */}
            <button
              onClick={() => handleTabSwitch("agent")}
              className="relative shrink-0 flex items-center gap-1.5 bg-slate-50 dark:bg-[#1a1a1f] border border-slate-100 dark:border-slate-800/80 hover:border-emerald-200 dark:hover:border-emerald-700 px-2.5 py-1.5 rounded-xl transition-all shadow-sm active:scale-95"
              title="DeAI Agent — let AbaPay pay bills for you from chat"
            >
              <Sparkles size={14} className="text-emerald-500" />
              <span className="text-[9px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300">Agent</span>
              <span className="absolute -top-1.5 -right-1.5 flex h-4 items-center rounded-full bg-red-600 px-1 text-[6px] font-black uppercase tracking-wider text-white shadow-md">
                <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-red-500 animate-ping"></span>
                <span className="relative">New</span>
              </span>
            </button>
          </div>
          <div className="flex items-center flex-wrap justify-end gap-2" data-tour="wallet-connect">

            {address && (() => {
              // 🔴 INTERACTIVE ONLY WHEN NOTHING LOCKS THE CHAIN — NOT MERELY "environment IS WEB."
              //
              // Base App used to read as plain WEB here, so it got the full interactive switcher
              // — Celo included, on a wallet that never runs on Celo. `chainLock` is the one
              // source of truth for whether there is anything to switch between at all; `menuInteractive`
              // collapses to exactly the old `environment === 'WEB'` check for ordinary WEB (chainLock
              // is null there), so nothing changes for the case this always worked for.
              const menuInteractive = environment === 'WEB' && !chainLock;
              return (
              <div className="relative shrink-0" ref={chainMenuRef}>
                <button
                  onClick={() => { if (menuInteractive && !isProcessing) setChainMenuOpen((open) => !open); }}
                  disabled={!menuInteractive || isProcessing}
                  aria-haspopup="menu"
                  aria-expanded={chainMenuOpen}
                  title={menuInteractive ? 'Network and wallet' : `Locked to ${activeChain?.name}`}
                  className={`flex w-full px-2.5 py-1.5 rounded-xl border items-center gap-1.5 shadow-sm transition-all ${
                     activeChain?.name?.toLowerCase().includes('base')
                        ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800/50 text-blue-700 dark:text-blue-400'
                        : 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800/50 text-emerald-700 dark:text-emerald-400'
                  } ${menuInteractive ? 'cursor-pointer hover:scale-105 active:scale-95' : 'cursor-default opacity-80'}`}
                >
                    {isProcessing ? (
                        <Loader2 size={10} className="animate-spin" />
                    ) : (
                        <div className={`w-1.5 h-1.5 rounded-full animate-pulse ${activeChain?.name?.toLowerCase().includes('base') ? 'bg-blue-500' : 'bg-emerald-500'}`}></div>
                    )}
                    <span className="text-[9px] font-black uppercase tracking-widest">{activeNetworkDisplay}</span>
                    {menuInteractive && !isProcessing && (
                      <ChevronDown size={10} className={`opacity-60 ml-0.5 transition-transform ${chainMenuOpen ? 'rotate-180' : ''}`} />
                    )}
                </button>

                {/* Only on demand, and gone the moment something is chosen. */}
                {chainMenuOpen && menuInteractive && (
                  // 🔴 ANCHORED LEFT, NOT RIGHT — THE MENU WAS FALLING OFF THE SCREEN.
                  //
                  // The badge sits at the START of a right-aligned header row, so `right-0`
                  // measured from the badge's own right edge and pushed the 12rem panel back
                  // across — and straight off the left of the viewport on a phone, where it was
                  // clipped by the card and unreadable. Screenshotted: the network options and
                  // Disconnect were half off-screen.
                  //
                  // `left-0` opens it INTO the row instead of away from it, and the width caps
                  // against the viewport so it can never be wider than the screen it is on.
                  <div
                    role="menu"
                    className="absolute left-0 top-full mt-1.5 z-50 w-48 max-w-[calc(100vw-2rem)] rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131317] shadow-xl overflow-hidden"
                  >
                    <div className="px-3 pt-2 pb-1 text-[8px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500">
                      Network
                    </div>
                    {(isMainnet ? [base, celo] : [baseSepolia, celoSepolia]).map((chain) => {
                      const isActive = activeChain?.id === chain.id;
                      const isBaseChain = chain.name.toLowerCase().includes('base');
                      return (
                        <button
                          key={chain.id}
                          role="menuitem"
                          onClick={() => { void switchToChain(chain); }}
                          className={`w-full flex items-center gap-2 px-3 py-2 text-left text-[11px] font-bold transition-colors ${
                            isActive
                              ? 'text-slate-900 dark:text-white bg-slate-50 dark:bg-slate-800/50'
                              : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/50'
                          }`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full ${isBaseChain ? 'bg-blue-500' : 'bg-emerald-500'}`} />
                          <span className="flex-1 truncate">{chain.name}</span>
                          {isActive && <Check size={12} className="text-emerald-500 shrink-0" />}
                        </button>
                      );
                    })}

                    <div className="h-px bg-slate-100 dark:bg-slate-800" />

                    <button
                      role="menuitem"
                      onClick={handleDisconnect}
                      className="w-full flex items-center gap-2 px-3 py-2 text-left text-[11px] font-bold text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-colors"
                    >
                      <LogOut size={12} className="shrink-0" />
                      Disconnect
                    </button>
                  </div>
                )}
              </div>
              );
            })()}

            {/* ⚡ THE EXIT BUTTON — FARCASTER AND BASE APP GET ONE TOO, NOW.
                Both are chain-locked (chainLock='BASE') exactly like MiniPay is locked to Celo,
                but only MiniPay ever had a way to disconnect and start over. `handleDisconnect`
                already exists and already does the right thing for a wagmi-backed connection —
                both Farcaster and Base App connect through it — so this is the same control
                MiniPay gets, offered wherever chainLock says the environment is a single-chain
                one, standing alone rather than inside a menu that has nothing else to offer. */}
            {address && chainLock && environment !== 'MINIPAY' && (
              <button
                onClick={handleDisconnect}
                title="Disconnect"
                className="p-1.5 rounded-lg bg-rose-50 dark:bg-rose-900/20 hover:bg-rose-100 dark:hover:bg-rose-900/40 border border-rose-200 dark:border-rose-800/50 text-rose-700 dark:text-rose-400 transition-all active:scale-95 shrink-0"
              >
                <LogOut size={12} />
              </button>
            )}

                                    {/* ⚡ NEW: Dynamic Connect Button / Smart Environment Routing ⚡ */}
            {!address && (environment === 'WEB' || environment === 'MINIPAY') ? (() => {
                // ⚡ CONNECTING DOES NOT END AT THE HANDSHAKE — IT ENDS AT THE SIGNATURE.
                //
                // 🔴 The button used to return to "Connect" as soon as wagmi reported a
                // connector, while the ownership signature was still sitting in the wallet. The
                // whole flow then read as finished-but-broken: an idle Connect button, nothing on
                // screen, and a prompt the user had no reason to associate with it.
                //
                // `awaitingProof` keeps the spinner running through the part that actually
                // matters. Paired with the bridge, which publishes nothing until the proof lands,
                // pressing Connect is one continuous act: spinner → one signature → the app fills
                // in. Refuse, and it returns to Connect with nothing half-shown.
                //
                // 🔴 MINIPAY GETS THIS BUTTON TOO, NOW — IT DIDN'T BEFORE. Declining the
                // ownership signature there left `address` unset with no button anywhere to
                // press: no Connect (WEB-only), and the automatic retry alone had no way to
                // distinguish "still waiting" from "genuinely stuck." This is the same button,
                // routed to connectMiniPay() instead of the wagmi chooser — a real, explicit way
                // back in rather than only an automatic retry.
                //
                // 🔴 AND `awaitingProof` MUST NOT DISABLE IT AFTER A MINIPAY DECLINE. On the web
                // a decline disconnects entirely (proofAddress goes away with it), so
                // `awaitingProof` there only ever means "genuinely still waiting." MiniPay never
                // clears `minipayPending` on decline — the whole point of holding it is a clean
                // retry — so `awaitingProof` stays true afterward too, and disabling the button
                // on it would lock out the exact tap meant to recover from that state.
                const minipayShowingFailure = environment === 'MINIPAY' && minipayVerifyFailed;
                const spinning = isProcessing || isConnecting || (awaitingProof && !minipayShowingFailure);
                return (
                  <button
                    onClick={() => { void (environment === 'MINIPAY' ? connectMiniPay() : handleConnectClick()); }}
                    disabled={spinning}
                    className="bg-emerald-50 dark:bg-emerald-900/20 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 border border-emerald-200 dark:border-emerald-800/50 text-emerald-700 dark:text-emerald-400 font-black text-[10px] px-3 py-1.5 rounded-xl transition-all shadow-sm active:scale-95 disabled:opacity-50 flex shrink-0 items-center gap-1.5 uppercase tracking-widest"
                  >
                    {spinning ? <Loader2 size={12} className="animate-spin"/> : <Zap size={12}/>}
                    {isProcessing ? "Wait" : spinning && awaitingProof ? "Verifying" : isConnecting ? "Connecting" : "Connect"}
                  </button>
                );
              })() : (
                <div className="flex shrink-0 items-center gap-2">
                  <PointsBadge walletAddress={address || undefined} />
                  {/* ⚡ MINIPAY GETS A REAL DISCONNECT TOO, SCOPED TO MINIPAY ONLY.
                      The network menu (Disconnect's usual home) never renders outside
                      `environment === 'WEB'` — MiniPay has no chain to switch between (Celo
                      only) and was never meant to see that dropdown. This sits beside the
                      points badge rather than replacing it: same "start over cleanly"
                      guarantee, without losing the points display or offering a Base option
                      that was never real for this wallet. */}
                  {address && environment === 'MINIPAY' && (
                    <button
                      onClick={handleMiniPayDisconnect}
                      title="Disconnect"
                      className="p-1.5 rounded-lg bg-rose-50 dark:bg-rose-900/20 hover:bg-rose-100 dark:hover:bg-rose-900/40 border border-rose-200 dark:border-rose-800/50 text-rose-700 dark:text-rose-400 transition-all active:scale-95"
                    >
                      <LogOut size={12} />
                    </button>
                  )}
                </div>
            )}

            <button 
              onClick={() => openSelectionModal('country', "Select Region", intlCountries.length ? intlCountries : SUPPORTED_COUNTRIES, handleCountryChange)}
              className="bg-slate-50 dark:bg-[#1a1a1f] border border-slate-100 dark:border-slate-800/80 hover:border-emerald-200 dark:hover:border-emerald-700 px-3 py-1.5 rounded-xl flex shrink-0 items-center gap-2 transition-all shadow-sm active:scale-95"
            >
              <img 
                src={`https://flagcdn.com/w40/${activeCountry.code.toLowerCase()}.png`} 
                alt={activeCountry.code} 
                className="w-5 h-auto rounded-[2px] shadow-sm" 
                onError={(e) => { e.currentTarget.style.display = 'none'; }} 
              />
              <span className="text-[10px] font-black text-slate-700 dark:text-slate-300 uppercase tracking-widest">{activeCountry.code}</span>
              <ChevronDown size={14} className="text-slate-400 dark:text-slate-500" />
            </button>

          </div>
        </div>

        {/* ⚡ CONNECT FAILURE BANNER ⚡
            A failed connection used to be completely invisible — the button just sat there.
            When the cause is a filtered WalletConnect relay (MTN and other Nigerian
            networks), the user needs to know it's their network and not the app, and needs
            a route that works right now: MiniPay touches none of the blocked hosts. */}
        {connectError && !address && (
          <div className="mb-4 rounded-2xl border border-amber-300 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-900/20 p-4 shadow-sm">
            <div className="flex items-start gap-2.5">
              <AlertTriangle size={16} className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-[11px] font-bold text-amber-900 dark:text-amber-200 leading-relaxed">
                  {connectError}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <button
                    onClick={() => { void handleConnectClick(); }}
                    className="text-[10px] font-black uppercase tracking-widest text-amber-800 dark:text-amber-300 underline underline-offset-2"
                  >
                    Try again
                  </button>
                  <Link
                    href="/network-check"
                    className="text-[10px] font-black uppercase tracking-widest text-amber-800 dark:text-amber-300 underline underline-offset-2"
                  >
                    Check my network
                  </Link>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ⚡ MINIPAY'S WAY BACK IN AFTER A DECLINE ⚡
            🔴 THE "AUTO-CONNECTS AND TRANSACTS DESPITE DECLINING" BUG. MiniPay's environment
            detector used to publish `address`/`client` directly, before any ownership signature —
            so declining the verification prompt did nothing, because the app was already usable.
            It is now held back until the signature succeeds, exactly like the web.

            Says WHY nothing is showing — the header's Connect button (which routes to the same
            connectMiniPay() this one does, not the weaker signature-only retry) is the actual
            escape hatch; this banner is what explains it needs pressing at all, since a MiniPay
            user has no reason to expect a decline to have gone anywhere. */}
        {environment === 'MINIPAY' && awaitingProof && minipayVerifyFailed && (
          <div className="mb-4 rounded-2xl border border-amber-300 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-900/20 p-4 shadow-sm">
            <div className="flex items-start gap-2.5">
              <AlertTriangle size={16} className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-[11px] font-bold text-amber-900 dark:text-amber-200 leading-relaxed">
                  Verifying your wallet was declined. AbaPay needs that signature to show your balance and history — it approves no payment.
                </p>
                <button
                  onClick={() => { void connectMiniPay(); }}
                  className="mt-2 text-[10px] font-black uppercase tracking-widest text-amber-800 dark:text-amber-300 underline underline-offset-2"
                >
                  Try again
                </button>
              </div>
            </div>
          </div>
        )}

        {/* THE TABS */}
        <div data-tour="tabs-bar" className="flex gap-2 bg-slate-200/50 dark:bg-[#1a1a1f] p-1.5 rounded-2xl md:rounded-[1.25rem] mb-6 shadow-inner overflow-x-auto no-scrollbar transition-colors">
            <button onClick={() => handleTabSwitch("pay")} className={`flex-1 min-w-[75px] py-3 rounded-xl text-[10px] sm:text-xs font-black transition-all ${activeTab === 'pay' ? 'bg-white dark:bg-[#111114] text-emerald-600 dark:text-emerald-400 shadow-xl' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}`}>BILLS</button>
            <button onClick={() => handleTabSwitch("bank")} disabled={isInternational} className={`flex-1 min-w-[75px] py-3 rounded-xl text-[10px] sm:text-xs font-black transition-all ${isInternational ? 'opacity-30 cursor-not-allowed' : activeTab === 'bank' ? 'bg-white dark:bg-[#111114] text-emerald-600 dark:text-emerald-400 shadow-xl' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}`}>TRANSFER</button>
            <button onClick={() => handleTabSwitch("education")} disabled={isInternational} className={`flex-1 min-w-[75px] py-3 rounded-xl text-[10px] sm:text-xs font-black transition-all ${isInternational ? 'opacity-30 cursor-not-allowed' : activeTab === 'education' ? 'bg-white dark:bg-[#111114] text-emerald-600 dark:text-emerald-400 shadow-xl' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}`}>EDUCATION</button>
            <button onClick={() => handleTabSwitch("history")} className={`flex-1 min-w-[75px] py-3 rounded-xl text-[10px] sm:text-xs font-black transition-all ${activeTab === 'history' ? 'bg-white dark:bg-[#111114] text-emerald-600 dark:text-emerald-400 shadow-xl' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}`}>HISTORY</button>
            <button onClick={() => handleTabSwitch("agent")} className={`flex-1 min-w-[75px] py-3 rounded-xl text-[10px] sm:text-xs font-black transition-all ${activeTab === 'agent' ? 'bg-white dark:bg-[#111114] text-emerald-600 dark:text-emerald-400 shadow-xl' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}`}>AGENT</button>
        </div>

        {/* ======================================= */}
        {/* BANK BLOCK */}
        {/* ======================================= */}
        {activeTab === 'bank' && (
          <div data-tour="bank-tab" className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2.5rem] md:rounded-[3rem] p-8 md:p-10 shadow-2xl shadow-emerald-900/10 dark:shadow-black/50 animate-in fade-in zoom-in-95 transition-colors">
            <div className="space-y-5">
                <div className="bg-slate-50 dark:bg-[#1a1a1f] border border-slate-100 dark:border-slate-800/80 p-4 rounded-2xl flex justify-between items-center animate-in fade-in transition-colors">
                  <div 
                    className="flex items-center gap-2 cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800/50 p-2 -ml-2 rounded-xl transition-colors" 
                    onClick={() => openSelectionModal('token', "Select Token", availableTokens, (symbol) => setSelectedToken(SUPPORTED_TOKENS.find(t => t.symbol === symbol)!))}
                  >
                     <img src={selectedToken.logo} alt={selectedToken.symbol} className="w-7 h-7 object-contain rounded-full shadow-sm bg-white dark:bg-slate-800 p-0.5" />
                     <span className="font-black text-slate-800 dark:text-slate-200 text-sm tracking-tight">{selectedToken.symbol}</span>
                     <ChevronDown size={14} className="text-slate-400 dark:text-slate-500"/>
                  </div>
                  <div className="text-right">
                    <p className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-0.5">Balance</p>
                    <div className="flex items-center justify-end gap-1.5">
                      {isFetchingBalance ? <Loader2 size={14} className="animate-spin text-emerald-500 dark:text-emerald-400"/> : <Coins size={14} className="text-emerald-500 dark:text-emerald-400"/>}
                      <div className="flex flex-col items-end">
                        <p className="font-mono font-black text-sm text-slate-800 dark:text-white leading-none">{walletBalance}</p>
                        {!isFetchingBalance && <p className="text-[9px] font-bold text-slate-400 dark:text-slate-500 mt-1 tracking-tight">≈ {walletFiatDisplay}</p>}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="animate-in slide-in-from-left-2 mb-2">
                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase mb-3 block">Bank</label>
                    <button 
                        onClick={() => openSelectionModal('bank', "Select Destination Bank", bankVariations, (val: any) => {
                            const foundBank = bankVariations.find(b => b.variation_code === val);
                            handleProviderChange(foundBank, 'bank');
                        })}
                        className="w-full bg-white dark:bg-[#1a1a1f] border border-slate-200 dark:border-slate-800/80 p-4 rounded-2xl flex justify-between items-center hover:border-blue-400 dark:hover:border-blue-600 transition-colors shadow-sm active:scale-[0.98]"
                    >
                        <div className="flex items-center gap-4">
                            <div className="w-12 h-12 shrink-0 rounded-full border border-slate-100 dark:border-slate-800/50 bg-blue-50 dark:bg-blue-900/20 flex items-center justify-center shadow-inner transition-colors">
                                <Landmark className="text-blue-500 dark:text-blue-400" size={20} />
                            </div>
                            <span className="text-sm font-black text-slate-900 dark:text-white tracking-tight">{selectedBank ? selectedBank.name : 'Select Bank'}</span>
                        </div>
                        <ChevronDown size={18} className="text-slate-400 dark:text-slate-500"/>
                    </button>
                    {!selectedBank && (
                        <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 mt-2">Or just type the account number below — we'll detect the bank automatically.</p>
                    )}
                </div>

                <div>
                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase mb-2 flex justify-between">
                      <span>Account No</span>
                      <span className={accountNumber.length === 10 ? "text-emerald-500 dark:text-emerald-400" : "text-slate-400 dark:text-slate-500"}>{accountNumber.length}/10</span>
                    </label>
                    <input 
                        type="tel" placeholder="1234567890"
                        maxLength={10}
                        className={`w-full bg-slate-50 dark:bg-[#1a1a1f] border p-5 rounded-2xl font-black text-xl text-slate-800 dark:text-white outline-none transition-all ${
                          accountNumber.length > 0 && accountNumber.length < 10 ? "border-red-300 dark:border-red-500/50 focus:border-red-500" : "border-slate-100 dark:border-slate-800/80 focus:border-emerald-500 dark:focus:border-emerald-500"
                        }`}
                        value={accountNumber}
                        onChange={(e) => setAccountNumber(e.target.value.replace(/[^0-9]/g, ''))}
                    />
                    {isVerifying && <p className="text-[10px] text-blue-500 dark:text-blue-400 font-bold mt-2 animate-pulse flex items-center gap-1.5"><Loader2 size={12} className="animate-spin"/> Verifying...</p>}

                    {(() => {
                        const key = getCurrentProviderKey();
                        const list = key ? beneficiaries[key] : [];
                        if (!list || list.length === 0) return null;
                        return (
                            <div className="flex gap-2 overflow-x-auto no-scrollbar mt-3 animate-in fade-in items-center">
                                <span className="text-[9px] font-black uppercase text-slate-400 dark:text-slate-500 shrink-0">Recent:</span>
                                {list.map((ben, idx) => (
                                    <button 
                                        key={idx}
                                        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
                                        style={{ WebkitTouchCallout: 'none', WebkitUserSelect: 'none', userSelect: 'none' }}
                                        onTouchStart={() => {
                                            isLongPress.current = false;
                                            pressTimer.current = setTimeout(() => {
                                                isLongPress.current = true;
                                                setActiveDeleteAccount(ben.account);
                                                if (navigator.vibrate) navigator.vibrate(50);
                                                setTimeout(() => setActiveDeleteAccount(null), 4000);
                                            }, 500); 
                                        }}
                                        onTouchEnd={() => { if (pressTimer.current) clearTimeout(pressTimer.current); }}
                                        onTouchMove={() => { if (pressTimer.current) clearTimeout(pressTimer.current); }}
                                        onMouseDown={() => {
                                            isLongPress.current = false;
                                            pressTimer.current = setTimeout(() => {
                                                isLongPress.current = true;
                                                setActiveDeleteAccount(ben.account);
                                                setTimeout(() => setActiveDeleteAccount(null), 4000);
                                            }, 500); 
                                        }}
                                        onMouseUp={() => { if (pressTimer.current) clearTimeout(pressTimer.current); }}
                                        onMouseLeave={() => { if (pressTimer.current) clearTimeout(pressTimer.current); }}
                                        onClick={(e) => {
                                            e.preventDefault();
                                            if (isLongPress.current) {
                                                isLongPress.current = false;
                                                return;
                                            }
                                            if (activeDeleteAccount === ben.account) {
                                                removeBeneficiary(ben.account);
                                                setActiveDeleteAccount(null);
                                            } else {
                                                setAccountNumber(ben.account);
                                                if (ben.name) setCustomerName(ben.name);
                                                setActiveDeleteAccount(null); 
                                            }
                                        }}
                                        className={`shrink-0 text-[10px] font-black py-1.5 px-3 rounded-full flex items-center gap-1.5 transition-all border outline-none select-none ${
                                            activeDeleteAccount === ben.account 
                                            ? 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 border-red-200 dark:border-red-800/50' 
                                            : 'bg-slate-100 dark:bg-[#1a1a1f] text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-800 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 hover:text-emerald-700 dark:hover:text-emerald-400 hover:border-emerald-200 dark:hover:border-emerald-800/50' 
                                        }`}
                                    >
                                        {activeDeleteAccount === ben.account ? (
                                            <><XCircle size={12} className="animate-pulse" /> Delete</>
                                        ) : (
                                            <span>{ben.name ? ben.name.split(' ')[0] : ben.account}</span>
                                        )}
                                    </button>
                                ))}
                            </div>
                        );
                    })()}

                    {/* ⚡ AUTO-DETECT RESULTS — always requires a tap to confirm, even a single
                        match (see resolveBankAccount's own comment on why silent auto-select
                        was removed): the account name is shown so the user can catch a
                        coincidental wrong match before committing to it. */}
                    {bankSuggestions.length > 0 && (
                        <div className="mt-3 bg-blue-500/5 dark:bg-blue-900/10 p-4 rounded-xl border border-blue-500/20 dark:border-blue-800/50 animate-in fade-in transition-colors">
                            <p className="text-[10px] font-black text-blue-600 dark:text-blue-400 uppercase mb-3">
                                {bankSuggestions.length === 1 ? 'Is this you?' : `Found ${bankSuggestions.length} accounts — which is yours?`}
                            </p>
                            <div className="flex flex-col gap-2">
                                {bankSuggestions.map((m: any) => (
                                    <button
                                        key={m.bankCode}
                                        onClick={() => {
                                            setSelectedBank({ variation_code: m.bankCode, name: m.bankName });
                                            setCustomerName(m.accountName);
                                            setBankSuggestions([]);
                                        }}
                                        className="w-full text-left bg-white dark:bg-[#1a1a1f] border border-slate-200 dark:border-slate-800 p-3 rounded-xl hover:border-blue-400 dark:hover:border-blue-600 transition-colors active:scale-[0.98]"
                                    >
                                        <span className="block text-xs font-black text-slate-900 dark:text-white">{m.accountName}</span>
                                        <span className="block text-[10px] font-bold text-slate-400 dark:text-slate-500 mt-0.5">{m.bankName}</span>
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    {customerName && (
                        <div className="mt-2 bg-emerald-500/10 dark:bg-emerald-900/20 p-4 rounded-xl border border-emerald-500/20 dark:border-emerald-800/50 flex items-center gap-3 animate-in fade-in transition-colors">
                            <CheckCircle2 size={18} className="text-emerald-600 dark:text-emerald-500 shrink-0" />
                            <div className="flex-1">
                                <span className="text-sm font-black text-emerald-800 dark:text-emerald-100 line-clamp-1">{customerName}</span>
                                <p className="text-[10px] font-black text-emerald-600 dark:text-emerald-500 uppercase mt-0.5">{selectedBank?.name ? `Verified · ${selectedBank.name}` : 'Verified'}</p>
                            </div>
                        </div>
                    )}
                </div>

                <div>
                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase mb-2 flex justify-between items-center">
                       <span>Amount</span>
                       <span className="text-emerald-500 dark:text-emerald-400 font-black">MIN ₦{dynamicMinAmount.toLocaleString()}</span>
                    </label>
                    <div className="relative mb-3">
                        <input 
                            type="number" 
                            placeholder="Amount" 
                            className="w-full bg-slate-50 dark:bg-[#1a1a1f] border border-slate-100 dark:border-slate-800/80 p-6 rounded-2xl font-black text-3xl text-slate-800 dark:text-white outline-none shadow-inner transition-colors focus:border-emerald-500 dark:focus:border-emerald-500"
                            value={nairaAmount}
                            onChange={(e) => setNairaAmount(e.target.value)}
                        />
                        <div className="absolute right-5 top-1/2 -translate-y-1/2 text-right">
                            <p className="text-sm font-black text-emerald-600 dark:text-emerald-400">{cryptoToCharge} {selectedToken.symbol}</p>
                            {currentFee > 0 && <p className="text-[9px] font-black text-orange-500 dark:text-orange-400">+₦{currentFee} FEE</p>}
                        </div>
                    </div>
                    {nairaAmount && (parseFloat(nairaAmount) < dynamicMinAmount || parseFloat(nairaAmount) > dynamicMaxAmount) && (
                        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50 p-3 rounded-xl mt-2 flex items-center gap-2 animate-in fade-in transition-colors">
                            <AlertTriangle size={16} className="text-red-500 dark:text-red-400 shrink-0" />
                            <p className="text-xs font-black text-red-600 dark:text-red-400">
                                {parseFloat(nairaAmount) < dynamicMinAmount ? `Amount is below the minimum of ₦${dynamicMinAmount.toLocaleString()}` : `Amount exceeds the maximum of ₦${dynamicMaxAmount.toLocaleString()}`}
                            </p>
                        </div>
                    )}
                    {/* ⚡ CBN STAMP DUTY NOTICE — informational only, shown here in the transfer
                        form so the user isn't surprised by the crypto total; never repeated in
                        the checkout fee line, receipt, or history (see cryptoToCharge's own
                        comment for why it's folded silently into the charged amount instead). */}
                    {nairaAmount && parseFloat(nairaAmount) >= 10000 && (
                        <div className="bg-slate-50 dark:bg-slate-800/30 border border-slate-200 dark:border-slate-700/50 p-3 rounded-xl mt-2 flex items-center gap-2 animate-in fade-in transition-colors">
                            <Landmark size={14} className="text-slate-400 dark:text-slate-500 shrink-0" />
                            <p className="text-[10px] font-bold text-slate-500 dark:text-slate-400">
                                A ₦50 CBN stamp duty applies to transfers of ₦10,000 and above — already included in the amount above.
                            </p>
                        </div>
                    )}
                </div>

                <div className="animate-in fade-in">
                     <input
                        type="tel" placeholder="Sender's Phone (Receipt)"
                        maxLength={11}
                        className="w-full bg-slate-50 dark:bg-[#1a1a1f] border border-slate-100 dark:border-slate-800/80 p-5 rounded-2xl font-bold text-slate-700 dark:text-white outline-none focus:border-emerald-500 dark:focus:border-emerald-500 transition-colors"
                        value={customerPhone}
                        onChange={(e) => setCustomerPhone(e.target.value.replace(/[^0-9]/g, ''))}
                    />
                </div>

                <div className="animate-in fade-in mt-3">
                     <input
                        type="email" placeholder="Email Address (Required for Receipt)"
                        className={`w-full bg-slate-50 dark:bg-[#1a1a1f] border p-5 rounded-2xl font-bold text-slate-700 dark:text-white outline-none transition-colors ${
                          customerEmail.length > 0 && !(customerEmail.includes('@') && customerEmail.includes('.')) ? "border-red-300 dark:border-red-500/50 focus:border-red-500" : "border-slate-100 dark:border-slate-800/80 focus:border-emerald-500 dark:focus:border-emerald-500"
                        }`}
                        value={customerEmail}
                        onChange={(e) => setCustomerEmail(e.target.value)}
                    />
                </div>

                {/* ⚡ Early discount visibility — shown in the main form as soon as an amount
                     exists, not just at the final confirm modal, so the user sees the saving
                     before they even reach checkout. */}
                {discountNgn > 0 && (
                    <div className="bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800/50 p-4 rounded-2xl flex items-center gap-3 animate-in fade-in transition-colors">
                        <span className="text-2xl">🎉</span>
                        <div>
                            <p className="text-xs font-black text-emerald-700 dark:text-emerald-400">{activeDiscount?.name || 'Discount'} applied</p>
                            <p className="text-[10px] font-bold text-emerald-600 dark:text-emerald-500">You save ₦{discountNgn.toLocaleString()} on this payment</p>
                        </div>
                    </div>
                )}

                {status && (
                    <div className={`p-5 rounded-2xl border flex items-center gap-4 animate-in fade-in transition-colors ${status.includes('Success') ? 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-100 dark:border-emerald-800/50 text-emerald-800 dark:text-emerald-400' : 'bg-blue-50 dark:bg-blue-900/20 border-blue-100 dark:border-blue-800/50 text-blue-800 dark:text-blue-400'}`}>
                        {status.includes('Success') ? <CheckCircle2 size={24}/> : <Loader2 size={24} className="animate-spin"/>}
                        <p className="text-sm font-black tracking-tight flex-1">{status}</p>
                        {isProcessing && canStopWaiting && (
                            <button onClick={stopWaitingForWallet} className="shrink-0 text-[11px] font-black tracking-tight underline underline-offset-2 opacity-70 hover:opacity-100">
                                STOP WAITING
                            </button>
                        )}
                    </div>
                )}

                <button
                    onClick={() => setIsConfirmModalOpen(true)}
                    disabled={isVerifying || !isFormValid || isProcessing || isCurrentServiceDisabled}
                    className={`w-full text-white dark:text-slate-900 font-black py-6 rounded-3xl flex items-center justify-center gap-3.5 transition-all active:scale-95 shadow-xl text-lg tracking-tight ${isCurrentServiceDisabled ? 'bg-slate-300 dark:bg-slate-800 opacity-50 cursor-not-allowed text-slate-500 dark:text-slate-500 shadow-none' : 'bg-slate-900 dark:bg-white hover:bg-black dark:hover:bg-slate-200 disabled:opacity-30 shadow-slate-900/20 dark:shadow-white/10'}`}
                >
                    {isProcessing ? <Loader2 size={24} className="animate-spin text-emerald-400 dark:text-emerald-600"/> : <ShieldCheck size={24} className={isCurrentServiceDisabled ? 'text-slate-400 dark:text-slate-500' : 'text-emerald-400 dark:text-emerald-600'} />}
                    {isCurrentServiceDisabled ? 'TEMPORARILY OFFLINE' : isProcessing ? 'PROCESSING...' : `TRANSFER ${cryptoToCharge} ${selectedToken.symbol}`}
                </button>
            </div>
          </div>
        )}

        {/* ======================================= */}
        {/* EDUCATION BLOCK */}
        {/* ======================================= */}
        {activeTab === 'education' && (
          <div data-tour="education-tab" className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2.5rem] md:rounded-[3rem] p-8 md:p-10 shadow-2xl shadow-emerald-900/10 dark:shadow-black/50 animate-in fade-in zoom-in-95 transition-colors">
            <div className="space-y-5">
                <div className="bg-slate-50 dark:bg-[#1a1a1f] border border-slate-100 dark:border-slate-800/80 p-4 rounded-2xl flex justify-between items-center animate-in fade-in transition-colors">
                  <div 
                    className="flex items-center gap-2 cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800/50 p-2 -ml-2 rounded-xl transition-colors" 
                    onClick={() => openSelectionModal('token', "Select Token", availableTokens, (symbol) => setSelectedToken(SUPPORTED_TOKENS.find(t => t.symbol === symbol)!))}
                  >
                     <img src={selectedToken.logo} alt={selectedToken.symbol} className="w-7 h-7 object-contain rounded-full shadow-sm bg-white dark:bg-slate-800 p-0.5" />
                     <span className="font-black text-slate-800 dark:text-slate-200 text-sm tracking-tight">{selectedToken.symbol}</span>
                     <ChevronDown size={14} className="text-slate-400 dark:text-slate-500"/>
                  </div>
                  <div className="text-right">
                    <p className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-0.5">Balance</p>
                    <div className="flex items-center justify-end gap-1.5">
                      {isFetchingBalance ? <Loader2 size={14} className="animate-spin text-emerald-500 dark:text-emerald-400"/> : <Coins size={14} className="text-emerald-500 dark:text-emerald-400"/>}
                      <div className="flex flex-col items-end">
                        <p className="font-mono font-black text-sm text-slate-800 dark:text-white leading-none">{walletBalance}</p>
                        {!isFetchingBalance && <p className="text-[9px] font-bold text-slate-400 dark:text-slate-500 mt-1 tracking-tight">≈ {walletFiatDisplay}</p>}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="animate-in slide-in-from-left-2 mb-2">
                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase mb-3 block">Service</label>
                    <button 
                        onClick={() => {
                            const optionsWithStatus = educationProviders.map(p => {
                                const isMasterOff = killSwitches['MASTER_EDUCATION'] === false;
                                const isProviderOff = killSwitches[`EDU_${p.serviceID}`] === false;
                                return { ...p, disabled: isMasterOff || isProviderOff };
                            });
                            openSelectionModal('provider', "Select Education Service", optionsWithStatus, (val) => handleProviderChange(val, 'education'));
                        }}
                        className="w-full bg-white dark:bg-[#1a1a1f] border border-slate-200 dark:border-slate-800/80 p-4 rounded-2xl flex justify-between items-center hover:border-emerald-400 dark:hover:border-emerald-600 transition-colors shadow-sm active:scale-[0.98]"
                    >
                        <div className="flex items-center gap-4">
                            <div className="w-12 h-12 shrink-0 rounded-full border border-slate-100 dark:border-slate-800/50 bg-emerald-50 dark:bg-emerald-900/20 flex items-center justify-center shadow-inner overflow-hidden transition-colors">
                                <GraduationCap className="text-emerald-500 dark:text-emerald-400" size={24} />
                            </div>
                            <div>
                                <span className="text-sm font-black text-slate-900 dark:text-white tracking-tight uppercase">
                                  {currentEducation?.displayName || 'Select Service'}
                                </span>
                            </div>
                        </div>
                        <ChevronDown size={18} className="text-slate-400 dark:text-slate-500"/>
                    </button>
                </div>

                {educationProvider === "jamb" && (
                    <div className="animate-in fade-in slide-in-from-top-2">
                        <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase mb-2 flex justify-between">
                          <span>Profile ID</span>
                          <span className={accountNumber.length >= 10 ? "text-emerald-500 dark:text-emerald-400" : "text-slate-400 dark:text-slate-500"}>{accountNumber.length}/10</span>
                        </label>
                        <input 
                            type="tel" placeholder="Enter ID"
                            maxLength={15}
                            className={`w-full bg-slate-50 dark:bg-[#1a1a1f] border p-5 rounded-2xl font-black text-xl text-slate-800 dark:text-white outline-none transition-all ${
                              accountNumber.length > 0 && accountNumber.length < 10 ? "border-red-300 dark:border-red-500/50 focus:border-red-500" : "border-slate-100 dark:border-slate-800/80 focus:border-emerald-500 dark:focus:border-emerald-500"
                            }`}
                            value={accountNumber}
                            onChange={(e) => setAccountNumber(e.target.value.replace(/[^0-9]/g, ''))}
                        />
                        {isVerifying && <p className="text-[10px] text-blue-500 dark:text-blue-400 font-bold mt-2 animate-pulse flex items-center gap-1.5"><Loader2 size={12} className="animate-spin"/> Verifying...</p>}

                        {(() => {
                            const key = getCurrentProviderKey();
                            const list = key ? beneficiaries[key] : [];
                            if (!list || list.length === 0) return null;
                            return (
                                <div className="flex gap-2 overflow-x-auto no-scrollbar mt-3 animate-in fade-in items-center">
                                    <span className="text-[9px] font-black uppercase text-slate-400 dark:text-slate-500 shrink-0">Recent:</span>
                                    {list.map((ben: any, idx: number) => (
                                        <button 
                                            key={idx}
                                            onClick={(e) => {
                                                e.preventDefault();
                                                setAccountNumber(ben.account);
                                                if (ben.name) setCustomerName(ben.name);
                                            }}
                                            className={`shrink-0 text-[10px] font-black py-1.5 px-3 rounded-full flex items-center gap-1.5 transition-all border outline-none select-none bg-slate-100 dark:bg-[#1a1a1f] text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-800 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 hover:text-emerald-700 dark:hover:text-emerald-400 hover:border-emerald-200 dark:hover:border-emerald-800/50`}
                                        >
                                            <span>{ben.name ? ben.name.split(' ')[0] : ben.account}</span>
                                        </button>
                                    ))}
                                </div>
                            );
                        })()}

                        {customerName && (
                            <div className="mt-2 bg-emerald-500/10 dark:bg-emerald-900/20 p-4 rounded-xl border border-emerald-500/20 dark:border-emerald-800/50 flex items-center gap-3 animate-in fade-in transition-colors">
                                <CheckCircle2 size={18} className="text-emerald-600 dark:text-emerald-500 shrink-0" />
                                <div className="flex-1">
                                    <span className="text-sm font-black text-emerald-800 dark:text-emerald-100 line-clamp-1">{customerName}</span>
                                    <p className="text-[10px] font-black text-emerald-600 dark:text-emerald-500 uppercase mt-0.5">Verified</p>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                <div className="bg-slate-50 dark:bg-[#1a1a1f] border border-slate-200 dark:border-slate-800/80 rounded-2xl p-4 shadow-sm animate-in fade-in slide-in-from-top-4 transition-colors">
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-2">Select Plan</p>
                  {selectedEducationPlan ? (
                      <div className="relative animate-in zoom-in-95 duration-200 mt-2">
                          <button onClick={() => { setSelectedEducationPlan(null); setNairaAmount(""); }} className="absolute -top-3 -right-3 bg-slate-200 dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-300 dark:hover:bg-slate-700 rounded-full p-1 transition-all z-10 shadow-sm border border-white dark:border-[#111114]">
                            <XCircle size={16}/>
                          </button>
                          <div className="p-4 rounded-2xl border-2 border-emerald-500 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-900/10 shadow-sm text-left transition-colors">
                            <p className="font-black text-slate-900 dark:text-white text-sm pr-2">{selectedEducationPlan.name}</p>

                            <div className="pt-2 border-t border-emerald-200/50 dark:border-emerald-800/50 flex justify-between items-end">
                                <div>
                                   <p className="font-black text-emerald-600 dark:text-emerald-400 text-xl">₦{parseFloat(selectedEducationPlan.variation_amount || "0").toLocaleString()}</p>
                                   {currentFee > 0 && <p className="text-[9px] font-black text-orange-500 dark:text-orange-400">+₦{currentFee} FEE INCLUDED</p>}
                                </div>
                                <p className="text-[10px] text-slate-500 dark:text-slate-400 font-bold">{cryptoToCharge} {selectedToken.symbol}</p>
                            </div>
                          </div>
                      </div>
                  ) : (
                      <div className="grid grid-cols-1 gap-2 max-h-[30vh] overflow-y-auto pr-1">
                        {educationVariations.length === 0 ? (
                          <p className="text-center text-xs font-bold text-slate-400 dark:text-slate-500 py-4"><Loader2 className="animate-spin inline-block mr-2" size={14}/> Loading...</p>
                        ) : (
                          educationVariations.map((plan: any) => (
                            <button 
                              key={plan.variation_code} 
                              onClick={() => { setSelectedEducationPlan(plan); setNairaAmount(plan.variation_amount ? plan.variation_amount.toString() : "0"); }} 
                              className="p-3 rounded-xl border border-slate-200 dark:border-slate-800/80 bg-white dark:bg-[#111114] hover:border-emerald-300 dark:hover:border-emerald-700 transition-all text-left flex justify-between items-center group"
                            >
                              <div className="mr-2">
                                <p className="font-black text-slate-800 dark:text-slate-200 text-xs line-clamp-2">{plan.name}</p>
                                <p className="text-[9px] text-slate-400 dark:text-slate-500 font-bold mt-1">{(parseFloat(plan.variation_amount || "0") / exchangeRate).toFixed(4)} {selectedToken.symbol}</p>
                              </div>
                              <p className="font-black text-emerald-600 dark:text-emerald-400 text-sm group-hover:scale-110 transition-transform shrink-0">₦{parseFloat(plan.variation_amount || "0").toLocaleString()}</p>
                            </button>
                          ))
                        )}
                      </div>
                  )}
                </div>

                <div className="animate-in fade-in">
                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase mb-2 flex justify-between">
                      <span>SMS Phone</span>
                      <span className={customerPhone.length >= 10 ? "text-emerald-500 dark:text-emerald-400" : "text-slate-400 dark:text-slate-500"}>{customerPhone.length}/11</span>
                    </label>
                    <input 
                        type="tel" placeholder="08000000000"
                        maxLength={11}
                        className={`w-full bg-slate-50 dark:bg-[#1a1a1f] border p-5 rounded-2xl font-black text-xl text-slate-800 dark:text-white outline-none transition-all ${
                          customerPhone.length > 0 && customerPhone.length < 10 ? "border-red-300 dark:border-red-500/50 focus:border-red-500" : "border-slate-100 dark:border-slate-800/80 focus:border-emerald-500 dark:focus:border-emerald-500"
                        }`}
                        value={customerPhone}
                        onChange={(e) => setCustomerPhone(e.target.value.replace(/[^0-9]/g, ''))}
                    />
                </div>

                <div className="animate-in fade-in mt-3">
                     <input 
                        type="email" placeholder="Email Address (Optional for Receipt)"
                        className="w-full bg-slate-50 dark:bg-[#1a1a1f] border border-slate-100 dark:border-slate-800/80 p-5 rounded-2xl font-bold text-slate-700 dark:text-white outline-none focus:border-emerald-500 dark:focus:border-emerald-500 transition-colors"
                        value={customerEmail}
                        onChange={(e) => setCustomerEmail(e.target.value)}
                    />
                </div>

                {/* ⚡ Early discount visibility — shown in the main form as soon as an amount
                     exists, not just at the final confirm modal, so the user sees the saving
                     before they even reach checkout. */}
                {discountNgn > 0 && (
                    <div className="bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800/50 p-4 rounded-2xl flex items-center gap-3 animate-in fade-in transition-colors">
                        <span className="text-2xl">🎉</span>
                        <div>
                            <p className="text-xs font-black text-emerald-700 dark:text-emerald-400">{activeDiscount?.name || 'Discount'} applied</p>
                            <p className="text-[10px] font-bold text-emerald-600 dark:text-emerald-500">You save ₦{discountNgn.toLocaleString()} on this payment</p>
                        </div>
                    </div>
                )}

                {status && (
                    <div className={`p-5 rounded-2xl border flex items-center gap-4 animate-in fade-in shadow-sm transition-colors ${status.includes('Success') || status.includes('Secured') || status.includes('Initiating') ? 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-100 dark:border-emerald-800/50 text-emerald-800 dark:text-emerald-400' : 'bg-blue-50 dark:bg-blue-900/20 border-blue-100 dark:border-blue-800/50 text-blue-800 dark:text-blue-400'}`}>
                        {status.includes('Success') ? <CheckCircle2 size={24}/> : <Loader2 size={24} className="animate-spin"/>}
                        <p className="text-sm font-black tracking-tight flex-1">{status}</p>
                        {isProcessing && canStopWaiting && (
                            <button onClick={stopWaitingForWallet} className="shrink-0 text-[11px] font-black tracking-tight underline underline-offset-2 opacity-70 hover:opacity-100">
                                STOP WAITING
                            </button>
                        )}
                    </div>
                )}

                <button
                    onClick={() => setIsConfirmModalOpen(true)}
                    disabled={!isFormValid || isProcessing || isCurrentServiceDisabled}
                    className={`w-full text-white dark:text-slate-900 font-black py-6 rounded-3xl flex items-center justify-center gap-3.5 transition-all active:scale-95 shadow-xl text-lg tracking-tight ${isCurrentServiceDisabled ? 'bg-slate-300 dark:bg-slate-800 opacity-50 cursor-not-allowed text-slate-500 dark:text-slate-500 shadow-none' : 'bg-slate-900 dark:bg-white hover:bg-black dark:hover:bg-slate-200 disabled:opacity-30 shadow-slate-900/20 dark:shadow-white/10'}`}
                >
                    {isProcessing ? <Loader2 size={24} className="animate-spin text-emerald-400 dark:text-emerald-600"/> : <ShieldCheck size={24} className={isCurrentServiceDisabled ? 'text-slate-400 dark:text-slate-500' : 'text-emerald-400 dark:text-emerald-600'} />}
                    {isCurrentServiceDisabled ? 'TEMPORARILY OFFLINE' : isProcessing ? 'PROCESSING...' : `PAY ${cryptoToCharge} ${selectedToken.symbol}`}
                </button>
            </div>
          </div>
        )}

        {/* ======================================= */}
        {/* PAY BLOCK */}
        {/* ======================================= */}
        {activeTab === 'pay' && (
          <div className="bg-white dark:bg-[#111114] border border-slate-100 dark:border-slate-800/60 rounded-[2.5rem] md:rounded-[3rem] p-8 md:p-10 shadow-2xl shadow-emerald-900/10 dark:shadow-black/50 animate-in fade-in zoom-in-95 transition-colors">

            {!isInternational && (
                <div data-tour="services" className="grid grid-cols-4 gap-2 pb-2 mb-4">
                    {SERVICES.filter(s => s.id !== 'BANK').map(s => (
                        <button 
                            key={s.id} 
                            onClick={() => handleResetService(s)}
                            className={`w-full p-2.5 rounded-xl border-2 transition-all flex flex-col items-center justify-center gap-1.5 ${
                                activeService.id === s.id ? 'border-emerald-500 dark:border-emerald-500 bg-emerald-50/50 dark:bg-emerald-900/20 scale-100 shadow-sm text-slate-900 dark:text-white' : 'border-slate-100 dark:border-slate-800/80 bg-white dark:bg-[#111114] hover:bg-slate-50 dark:hover:bg-[#1a1a1f] text-slate-500 dark:text-slate-400'
                            }`}
                        >
                            <s.icon size={18} className={s.color} />
                            <span className="text-[9px] font-black uppercase tracking-tight text-center">{s.name}</span>
                        </button>
                    ))}
                </div>
            )}

            <div className="space-y-5">
                <div className="bg-slate-50 dark:bg-[#1a1a1f] border border-slate-100 dark:border-slate-800/80 p-4 rounded-2xl flex justify-between items-center animate-in fade-in transition-colors">
                  <div 
                    className="flex items-center gap-2 cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800/50 p-2 -ml-2 rounded-xl transition-colors" 
                    onClick={() => openSelectionModal('token', "Select Token", availableTokens, (symbol) => setSelectedToken(SUPPORTED_TOKENS.find(t => t.symbol === symbol)!))}
                  >
                     <img src={selectedToken.logo} alt={selectedToken.symbol} className="w-7 h-7 object-contain rounded-full shadow-sm bg-white dark:bg-slate-800 p-0.5" />
                     <span className="font-black text-slate-800 dark:text-slate-200 text-sm tracking-tight">{selectedToken.symbol}</span>
                     <ChevronDown size={14} className="text-slate-400 dark:text-slate-500"/>
                  </div>
                  <div className="text-right">
                    <p className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-0.5">Balance</p>
                    <div className="flex items-center justify-end gap-1.5">
                      {isFetchingBalance ? <Loader2 size={14} className="animate-spin text-emerald-500 dark:text-emerald-400"/> : <Coins size={14} className="text-emerald-500 dark:text-emerald-400"/>}
                      <div className="flex flex-col items-end">
                        <p className="font-mono font-black text-sm text-slate-800 dark:text-white leading-none">{walletBalance}</p>
                        {!isFetchingBalance && <p className="text-[9px] font-bold text-slate-400 dark:text-slate-500 mt-1 tracking-tight">≈ {walletFiatDisplay}</p>}
                      </div>
                    </div>
                  </div>
                </div>

                {/* ⚡ THE PROVIDER SELECTORS (LOCAL OR INTERNATIONAL) ⚡ */}
                <div className="animate-in slide-in-from-left-2 mb-2">
                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase mb-3 block">
                        {isInternational ? "Product Type" : "Provider"}
                    </label>

                    {isInternational ? (
                        <div className="w-full space-y-4">
                            <button 
                                onClick={() => {
                                    if (intlProductTypes.length === 0) return;

                                    const getIcon = (name: string) => name.toLowerCase().includes('data') 
                                        ? "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%230ea5e9' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M5 12.55a11 11 0 0 1 14.08 0'/%3E%3Cpath d='M1.42 9a16 16 0 0 1 21.16 0'/%3E%3Cpath d='M8.53 16.11a6 6 0 0 1 6.95 0'/%3E%3Cline x1='12' y1='20' x2='12.01' y2='20'/%3E%3C/svg%3E" 
                                        : "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%2310b981' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolygon points='13 2 3 14 12 14 11 22 21 10 12 10 13 2'/%3E%3C/svg%3E";

                                    openSelectionModal('standard', "Select Type", intlProductTypes.map(p => ({
                                        serviceID: p.product_type_id || p.id || p.name, 
                                        displayName: p.name,
                                        logo: getIcon(p.name)
                                    })), (val) => {
                                        setSelectedIntlProduct(intlProductTypes.find(p => (p.product_type_id || p.id || p.name) == val));
                                    });
                                }}
                                className="w-full bg-white dark:bg-[#1a1a1f] border border-slate-200 dark:border-slate-800/80 p-4 rounded-2xl flex justify-between items-center hover:border-emerald-400 dark:hover:border-emerald-600 transition-colors shadow-sm"
                            >
                                <div className="flex items-center gap-3">
                                    {selectedIntlProduct && (
                                       <div className="w-10 h-10 shrink-0 rounded-full border border-slate-100 dark:border-slate-800/50 bg-emerald-50/50 dark:bg-emerald-900/20 flex items-center justify-center shadow-sm overflow-hidden transition-colors">
                                           <img 
                                              src={selectedIntlProduct.name.toLowerCase().includes('data') 
                                                   ? "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%230ea5e9' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M5 12.55a11 11 0 0 1 14.08 0'/%3E%3Cpath d='M1.42 9a16 16 0 0 1 21.16 0'/%3E%3Cpath d='M8.53 16.11a6 6 0 0 1 6.95 0'/%3E%3Cline x1='12' y1='20' x2='12.01' y2='20'/%3E%3C/svg%3E" 
                                                   : "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%2310b981' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolygon points='13 2 3 14 12 14 11 22 21 10 12 10 13 2'/%3E%3C/svg%3E"} 
                                              className="w-5 h-5 object-contain" 
                                              alt="type" 
                                           />
                                       </div>
                                    )}
                                    <span className="text-sm font-black text-slate-900 dark:text-white tracking-tight uppercase">
                                        {selectedIntlProduct ? selectedIntlProduct.name : (isIntlLoading ? "Loading..." : "Select Product Type")}
                                    </span>
                                </div>
                                {isIntlLoading ? <Loader2 size={16} className="animate-spin"/> : <ChevronDown size={18} className="text-slate-400 dark:text-slate-500"/>}
                            </button>

                            {selectedIntlProduct && (
                                <div className="w-full">
                                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase mb-3 block">Network Operator</label>
                                    <button 
                                        onClick={() => {
                                            if (intlOperators.length === 0) return;
                                            openSelectionModal('standard', "Select Network", intlOperators.map(p => ({
                                                serviceID: p.operator_id || p.id || p.name, 
                                                displayName: p.name,
                                                logo: p.operator_image || '/logo.png'
                                            })), (val) => {
                                                setSelectedIntlOperator(intlOperators.find(p => (p.operator_id || p.id || p.name) == val));
                                            });
                                        }}
                                        className="w-full bg-white dark:bg-[#1a1a1f] border border-slate-200 dark:border-slate-800/80 p-4 rounded-2xl flex justify-between items-center hover:border-emerald-400 dark:hover:border-emerald-600 transition-colors shadow-sm"
                                    >
                                        <div className="flex items-center gap-3">
                                            {selectedIntlOperator && (
                                                <div className="w-10 h-10 shrink-0 rounded-full border border-slate-100 dark:border-slate-800/50 bg-white dark:bg-slate-800 flex items-center justify-center shadow-sm overflow-hidden transition-colors">
                                                    <img 
                                                       src={selectedIntlOperator.operator_image || '/logo.png'} 
                                                       alt="operator" 
                                                       className="w-8 h-8 object-contain" 
                                                       onError={(e) => { e.currentTarget.src = '/logo.png'; }} 
                                                    />
                                                </div>
                                            )}
                                            <span className="text-sm font-black text-slate-900 dark:text-white tracking-tight uppercase">
                                                {selectedIntlOperator ? selectedIntlOperator.name : (isIntlLoading ? "Loading..." : "Select Operator")}
                                            </span>
                                        </div>
                                        {isIntlLoading ? <Loader2 size={16} className="animate-spin"/> : <ChevronDown size={18} className="text-slate-400 dark:text-slate-500"/>}
                                    </button>
                                </div>
                            )}
                        </div>
                    ) : (
                        activeService.id === "INTERNET" ? (
                            <button onClick={() => openSelectionModal('provider', "Select Provider", internetProviders, (val) => handleProviderChange(val, 'internet'))} className="w-full bg-white dark:bg-[#1a1a1f] border border-slate-200 dark:border-slate-800/80 p-4 rounded-2xl flex justify-between items-center hover:border-sky-400 dark:hover:border-sky-600 transition-colors shadow-sm active:scale-[0.98]">
                                <div className="flex items-center gap-4">
                                    <div className="w-12 h-12 shrink-0 rounded-full border border-slate-100 dark:border-slate-800/50 bg-sky-50 dark:bg-sky-900/20 flex items-center justify-center shadow-inner overflow-hidden transition-colors"><img src={currentInternet?.logo || '/wifi.png'} alt={currentInternet?.displayName} onError={(e) => { e.currentTarget.src = '/logo.png'; }} className="w-full h-full object-contain" /></div>
                                    <span className="text-sm font-black text-slate-900 dark:text-white tracking-tight">{currentInternet?.displayName}</span>
                                </div><ChevronDown size={18} className="text-slate-400 dark:text-slate-500"/>
                            </button>
                        ) : activeService.id === "AIRTIME" ? (
                            <button 
                                onClick={() => {
                                    // 🔴 This used to BUILD a logo path from the provider string
                                    // (`/${p}.png`, with a special case renaming etisalat ->
                                    // 9mobile) and lean on an onError handler to swap in
                                    // /logo.png when the guess was wrong. Every new network
                                    // needed both a code change and a new PNG. Name and logo now
                                    // come from VTpass with the rest of the list.
                                    const optionsWithStatus = telecomProviders.map(p => ({
                                        ...p,
                                        disabled: killSwitches['MASTER_AIRTIME'] === false
                                               || killSwitches[`AIRTIME_${p.serviceID.toLowerCase()}`] === false,
                                    }));
                                    openSelectionModal('standard', "Select Network", optionsWithStatus, (val) => handleProviderChange(val, 'telecom'));
                                }}
                                className="w-full bg-white dark:bg-[#1a1a1f] border border-slate-200 dark:border-slate-800/80 p-4 rounded-2xl flex justify-between items-center hover:border-emerald-400 dark:hover:border-emerald-600 transition-colors shadow-sm active:scale-[0.98]"
                            >
                                <div className="flex items-center gap-4">
                                    <div className="w-12 h-12 shrink-0 rounded-full border border-slate-100 dark:border-slate-800/50 bg-emerald-50 dark:bg-emerald-900/20 flex items-center justify-center shadow-inner overflow-hidden transition-colors">
                                        <img src={currentTelecom?.logo || '/logo.png'} alt={currentTelecom?.displayName || telecomProvider} className="w-full h-full object-contain" onError={(e) => { e.currentTarget.src = '/logo.png'; }} />
                                    </div>
                                    <span className="text-sm font-black text-slate-900 dark:text-white tracking-tight uppercase">
                                        {currentTelecom?.displayName || telecomProvider}
                                    </span>
                                </div>
                                <ChevronDown size={18} className="text-slate-400 dark:text-slate-500"/>
                            </button>
                        ) : activeService.id === "ELECTRICITY" ? (
                            <button onClick={() => openSelectionModal('provider', "Select Provider", electricityProviders, (val) => handleProviderChange(val, 'elec'))} className="w-full bg-white dark:bg-[#1a1a1f] border border-slate-200 dark:border-slate-800/80 p-4 rounded-2xl flex justify-between items-center hover:border-orange-400 dark:hover:border-orange-600 transition-colors shadow-sm active:scale-[0.98]">
                                <div className="flex items-center gap-4">
                                    <div className="w-12 h-12 shrink-0 rounded-full border border-slate-100 dark:border-slate-800/50 bg-white dark:bg-slate-800 p-0.5 flex items-center justify-center shadow-inner overflow-hidden transition-colors"><img src={currentDisco?.logo || '/logo.png'} alt={currentDisco?.displayName} onError={(e) => { e.currentTarget.src = '/logo.png'; }} className="w-full h-full object-contain" /></div>
                                    <span className="text-sm font-black text-slate-900 dark:text-white tracking-tight">{currentDisco?.displayName}</span>
                                </div><ChevronDown size={18} className="text-slate-400 dark:text-slate-500"/>
                            </button>
                        ) : (
                          <button onClick={() => openSelectionModal('provider', "Select Provider", cableProviders, (val) => handleProviderChange(val, 'cable'))} className="w-full bg-white dark:bg-[#1a1a1f] border border-slate-200 dark:border-slate-800/80 p-4 rounded-2xl flex justify-between items-center hover:border-pink-400 dark:hover:border-pink-600 transition-colors shadow-sm active:scale-[0.98]">
                            <div className="flex items-center gap-4">
                                <div className="w-12 h-12 shrink-0 rounded-full border border-slate-100 dark:border-slate-800/50 bg-white dark:bg-slate-800 p-0.5 flex items-center justify-center shadow-inner overflow-hidden transition-colors"><img src={currentCable?.logo || '/logo.png'} alt={currentCable?.displayName} onError={(e) => { e.currentTarget.src = '/logo.png'; }} className="w-full h-full object-contain" /></div>
                                <span className="text-sm font-black text-slate-900 dark:text-white tracking-tight">{currentCable?.displayName}</span>
                            </div><ChevronDown size={18} className="text-slate-400 dark:text-slate-500"/>
                          </button>
                        )
                    )}

                    {(!isInternational && activeService.id === "ELECTRICITY") && (
                       <div className="flex gap-2 mt-4 p-1.5 bg-slate-100 dark:bg-[#1a1a1f] rounded-2xl border border-slate-200 dark:border-slate-800/50 shadow-inner transition-colors">
                          <button onClick={() => setMeterType("prepaid")} className={`flex-1 py-3 text-[11px] font-black uppercase rounded-xl transition-all ${meterType === "prepaid" ? "bg-white dark:bg-[#111114] shadow-lg text-emerald-600 dark:text-emerald-400" : "text-slate-500 dark:text-slate-400"}`}>Prepaid</button>
                          <button onClick={() => setMeterType("postpaid")} className={`flex-1 py-3 text-[11px] font-black uppercase rounded-xl transition-all ${meterType === "postpaid" ? "bg-white dark:bg-[#111114] shadow-lg text-emerald-600 dark:text-emerald-400" : "text-slate-500 dark:text-slate-400"}`}>Postpaid</button>
                       </div>
                    )}
                </div>

                <div>
                    <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase mb-2 flex justify-between">
                      <span>{checkoutDetails.recipientLabel}</span>
                      {(activeService.id === "AIRTIME" || (activeService.id === "INTERNET" && internetProvider.includes('-data')) || isInternational) && (
                        <span className={accountNumber.length >= (isInternational ? 6 : 11) ? "text-emerald-500 dark:text-emerald-400" : "text-slate-400 dark:text-slate-500"}>
                            {isInternational ? `${accountNumber.length} digits` : `${accountNumber.length}/11`}
                        </span>
                      )}
                    </label>
                    <input 
                        type={activeService.id === "INTERNET" && internetProvider === 'smile-direct' ? "email" : "tel"} 
                        placeholder={
                            isInternational ? `Enter ${activeCountry.name} Number` :
                            activeService.id === "INTERNET" && internetProvider === 'smile-direct' ? "example@email.com" : 
                            activeService.id === "INTERNET" && internetProvider === 'spectranet' ? "Enter Spectranet ID" : 
                            "Enter Number"
                        }
                        maxLength={
                            isInternational ? 15 : 
                            activeService.id === "ELECTRICITY" ? 14 : 
                            activeService.id === "CABLE" ? 12 : 
                            (activeService.id === "INTERNET" && internetProvider === 'smile-direct') ? 50 : 
                            11 
                        }
                        className={`w-full bg-slate-50 dark:bg-[#1a1a1f] border p-5 rounded-2xl font-black text-xl text-slate-800 dark:text-white outline-none transition-all ${
                          ((activeService.id === "AIRTIME" || (activeService.id === "INTERNET" && internetProvider.includes('-data'))) && accountNumber.length > 0 && accountNumber.length < 11 && !isInternational) ? "border-red-300 dark:border-red-500/50 focus:border-red-500" : "border-slate-100 dark:border-slate-800/80 focus:border-emerald-500 dark:focus:border-emerald-500"
                        }`}
                        value={accountNumber}
                        onChange={(e) => {
                            if (activeService.id === "INTERNET" && internetProvider === 'smile-direct') setAccountNumber(e.target.value);
                            else setAccountNumber(e.target.value.replace(/[^0-9]/g, ''));
                        }}
                    />
                    {isVerifying && <p className="text-[10px] text-blue-500 dark:text-blue-400 font-bold mt-2 animate-pulse flex items-center gap-1.5"><Loader2 size={12} className="animate-spin"/> Verifying...</p>}

                    {(() => {
                        const key = getCurrentProviderKey();
                        const list = key ? beneficiaries[key] : [];
                        if (!list || list.length === 0) return null;
                        return (
                            <div className="flex gap-2 overflow-x-auto no-scrollbar mt-3 animate-in fade-in items-center">
                                <span className="text-[9px] font-black uppercase text-slate-400 dark:text-slate-500 shrink-0">Recent:</span>
                                {list.map((ben, idx) => (
                                    <button 
                                        key={idx}
                                        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
                                        style={{ WebkitTouchCallout: 'none', WebkitUserSelect: 'none', userSelect: 'none' }}
                                        onTouchStart={() => {
                                            isLongPress.current = false;
                                            pressTimer.current = setTimeout(() => {
                                                isLongPress.current = true;
                                                setActiveDeleteAccount(ben.account);
                                                if (navigator.vibrate) navigator.vibrate(50);
                                                setTimeout(() => setActiveDeleteAccount(null), 4000);
                                            }, 500); 
                                        }}
                                        onTouchEnd={() => { if (pressTimer.current) clearTimeout(pressTimer.current); }}
                                        onTouchMove={() => { if (pressTimer.current) clearTimeout(pressTimer.current); }}
                                        onMouseDown={() => {
                                            isLongPress.current = false;
                                            pressTimer.current = setTimeout(() => {
                                                isLongPress.current = true;
                                                setActiveDeleteAccount(ben.account);
                                                setTimeout(() => setActiveDeleteAccount(null), 4000);
                                            }, 500); 
                                        }}
                                        onMouseUp={() => { if (pressTimer.current) clearTimeout(pressTimer.current); }}
                                        onMouseLeave={() => { if (pressTimer.current) clearTimeout(pressTimer.current); }}
                                        onClick={(e) => {
                                            e.preventDefault();
                                            if (isLongPress.current) {
                                                isLongPress.current = false;
                                                return;
                                            }
                                            if (activeDeleteAccount === ben.account) {
                                                removeBeneficiary(ben.account);
                                                setActiveDeleteAccount(null);
                                            } else {
                                                setAccountNumber(ben.account);
                                                if (ben.name) setCustomerName(ben.name);
                                                setActiveDeleteAccount(null); 
                                            }
                                        }}
                                        className={`shrink-0 text-[10px] font-black py-1.5 px-3 rounded-full flex items-center gap-1.5 transition-all border outline-none select-none ${
                                            activeDeleteAccount === ben.account 
                                            ? 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 border-red-200 dark:border-red-800/50' 
                                            : 'bg-slate-100 dark:bg-[#1a1a1f] text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-800 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 hover:text-emerald-700 dark:hover:text-emerald-400 hover:border-emerald-200 dark:hover:border-emerald-800/50' 
                                        }`}
                                    >
                                        {activeDeleteAccount === ben.account ? (
                                            <><XCircle size={12} className="animate-pulse" /> Delete</>
                                        ) : (
                                            <span>{ben.name ? ben.name.split(' ')[0] : ben.account}</span>
                                        )}
                                    </button>
                                ))}
                            </div>
                        );
                    })()}

                    {/* ⚡ VERIFIED BLOCK WITH ADDRESS ⚡ */}
                    {customerName && (activeService.id === "ELECTRICITY" || (activeService.id === "INTERNET" && internetProvider === 'smile-direct')) && (
                        <div className="mt-2 bg-emerald-500/10 dark:bg-emerald-900/20 p-4 rounded-xl border border-emerald-500/20 dark:border-emerald-800/50 flex items-center gap-3 animate-in fade-in transition-colors">
                            <CheckCircle2 size={18} className="text-emerald-600 dark:text-emerald-500 shrink-0" />
                            <div className="flex-1">
                                <span className="text-sm font-black text-emerald-800 dark:text-emerald-100 line-clamp-1">{customerName}</span>
                                {activeService.id === "ELECTRICITY" && meterAddress && (
                                     <p className="text-[10px] font-medium text-emerald-700 dark:text-emerald-300 leading-tight mt-0.5 pr-2">{meterAddress}</p>
                                )}
                                <p className="text-[10px] font-black text-emerald-600 dark:text-emerald-500 uppercase mt-0.5">Verified</p>
                            </div>
                        </div>
                    )}
                </div>

                {/* ⚡ INTERNATIONAL VARIATIONS / AMOUNTS ⚡ */}
                {isInternational && selectedIntlOperator && (
                    <div className="bg-slate-50 dark:bg-[#1a1a1f] border border-slate-200 dark:border-slate-800/80 rounded-2xl p-4 shadow-sm animate-in fade-in slide-in-from-top-4 transition-colors">
                        {intlVariations.length === 0 ? (
                           <p className="text-center text-xs font-bold text-slate-400 dark:text-slate-500 py-4">No packages available.</p>
                        ) : (
                           selectedIntlVariation ? (
                               <div className="relative animate-in zoom-in-95 duration-200 mt-2">
                                  <button onClick={() => { setSelectedIntlVariation(null); setIntlFlexibleAmount(""); }} className="absolute -top-3 -right-3 bg-slate-200 dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-300 dark:hover:bg-slate-700 rounded-full p-1 transition-all z-10 shadow-sm border border-white dark:border-[#111114]"><XCircle size={16}/></button>
                                  <div className="p-4 rounded-2xl border-2 border-emerald-500 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-900/10 shadow-sm text-left transition-colors">
                                     <p className="font-black text-slate-900 dark:text-white text-lg">{selectedIntlVariation.name}</p>
                                     {selectedIntlVariation.fixedPrice !== "Yes" && (() => {
                                         // ⚡ MATH: Platform Exchange Rate (NGN/USD) divided by Foreign API Rate (NGN/Local)
                                         const rate = parseFloat(selectedIntlVariation.variation_rate || "1");
                                         const minLocalAmount = exchangeRate / rate;

                                         // Format to 2 decimal places (e.g., 13.64)
                                         const minFormatted = minLocalAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                                         const localSymbol = intlCurrency || activeCountry.currency || activeCountry.code;

                                         return (
                                             <div className="mt-3 border-t border-emerald-200 dark:border-emerald-800/50 pt-3 transition-colors">
                                                <div className="flex justify-between items-center mb-1">
                                                    <p className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest">Enter Amount to Send</p>
                                                    <p className="text-[9px] font-black text-emerald-500 dark:text-emerald-400">MIN {localSymbol} {minFormatted}</p>
                                                </div>
                                                <input 
                                                    type="number" 
                                                    placeholder="Amount" 
                                                    className="w-full bg-white dark:bg-[#111114] border border-emerald-200 dark:border-emerald-800/80 p-3 rounded-xl font-black text-xl text-emerald-800 dark:text-emerald-100 outline-none focus:border-emerald-500 dark:focus:border-emerald-500 transition-colors"
                                                    value={intlFlexibleAmount}
                                                    onChange={(e) => setIntlFlexibleAmount(e.target.value)}
                                                />
                                                {/* ⚡ DYNAMIC LOCAL CURRENCY MINIMUM WARNING ⚡ */}
                                                {intlFlexibleAmount && (parseFloat(intlFlexibleAmount) * rate / exchangeRate) < 1 && (
                                                    <div className="bg-red-50 dark:bg-red-900/20 p-2 rounded-lg mt-2 flex items-center gap-1.5 border border-red-100 dark:border-red-800/50 animate-in fade-in transition-colors">
                                                        <AlertTriangle size={12} className="text-red-500 dark:text-red-400 shrink-0" />
                                                        <p className="text-[9px] font-black text-red-600 dark:text-red-400 uppercase tracking-wide">
                                                            Amount must be at least {localSymbol} {minFormatted}
                                                        </p>
                                                    </div>
                                                )}
                                             </div>
                                         );
                                     })()}
                                     <div className="pt-3 mt-2 border-t border-emerald-200/50 dark:border-emerald-800/50 flex justify-between items-end transition-colors">
                                         {/* ⚡ HIDING NGN, SHOWING LOCAL CURRENCY ⚡ */}
                                         <p className="font-black text-emerald-600 dark:text-emerald-400 text-xl">{intlCurrency || activeCountry.currency || activeCountry.code} {displayForeignAmount}</p>
                                         <p className="text-[10px] text-slate-500 dark:text-slate-400 font-bold">{cryptoToCharge} {selectedToken.symbol}</p>
                                      </div>
                                  </div>
                               </div>
                           ) : (
                               <div className="grid grid-cols-1 gap-2 max-h-[30vh] overflow-y-auto pr-1">
                                  {intlVariations.map((plan) => {
                                      const rate = parseFloat(plan.variation_rate || "1");
                                      const foreignAmt = parseFloat(plan.variation_amount || "0");
                                      const isFixed = plan.fixedPrice === "Yes";

                                      let nairaEquivalent = 0;
                                      if (isFixed) {
                                          nairaEquivalent = parseFloat(plan.charged_amount || "0");
                                          if (nairaEquivalent <= 0) nairaEquivalent = foreignAmt * rate;
                                      }

                                      const cryptoCostEstimate = (nairaEquivalent / exchangeRate).toFixed(4);
                                      const cryptoRateEstimate = (rate / exchangeRate).toFixed(4);

                                      return (
                                        <button key={plan.variation_code} onClick={() => setSelectedIntlVariation(plan)} className="p-3 rounded-xl border border-slate-200 dark:border-slate-800/80 bg-white dark:bg-[#111114] hover:border-emerald-300 dark:hover:border-emerald-700 transition-all text-left flex justify-between items-center group">
                                          <div>
                                            <p className="font-black text-slate-800 dark:text-slate-200 text-xs">{plan.name}</p>
                                            <p className="text-[9px] text-slate-400 dark:text-slate-500 font-bold mt-0.5">
                                                {isFixed ? `Cost: ${cryptoCostEstimate} ${selectedToken.symbol}` : `Rate: ~${cryptoRateEstimate} ${selectedToken.symbol} per ${intlCurrency || activeCountry.currency || activeCountry.code}`}
                                            </p>
                                          </div>
                                          {/* ⚡ HIDING NGN, SHOWING LOCAL CURRENCY ⚡ */}
                                          <p className="font-black text-emerald-600 dark:text-emerald-400 text-sm group-hover:scale-110 transition-transform">
                                            {isFixed ? `${intlCurrency || activeCountry.currency || activeCountry.code} ${foreignAmt.toLocaleString()}` : "Flexible"}
                                          </p>
                                        </button>
                                      )
                                  })}
                               </div>
                           )
                        )}
                    </div>
                )}

                {/* ⚡ LOCAL VARIATIONS UI ⚡ */}
                {!isInternational && activeService.id === "INTERNET" && (
                  <div className="bg-slate-50 dark:bg-[#1a1a1f] border border-slate-200 dark:border-slate-800/80 rounded-2xl p-4 shadow-sm animate-in fade-in slide-in-from-top-4 transition-colors">
                     {selectedInternetPlan ? (
                        <div className="relative animate-in zoom-in-95 duration-200 mt-2">
                           <button onClick={() => { setSelectedInternetPlan(null); setNairaAmount(""); }} className="absolute -top-3 -right-3 bg-slate-200 dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-300 dark:hover:bg-slate-700 rounded-full p-1 transition-all z-10 shadow-sm border border-white dark:border-[#111114]">
                             <XCircle size={16}/>
                           </button>
                           <div className="p-4 rounded-2xl border-2 border-sky-500 dark:border-sky-700 bg-sky-50 dark:bg-sky-900/10 shadow-sm text-left transition-colors">
                              <p className="font-black text-slate-900 dark:text-white text-lg">{selectedInternetPlan.name}</p>
                              <div className="pt-2 border-t border-sky-200/50 dark:border-sky-800/50 flex justify-between items-end transition-colors">
                                  <p className="font-black text-sky-600 dark:text-sky-400 text-xl">₦{parseFloat(selectedInternetPlan.variation_amount || "0").toLocaleString()}</p>
                                  <p className="text-[10px] text-slate-500 dark:text-slate-400 font-bold">{(parseFloat(selectedInternetPlan.variation_amount || "0") / exchangeRate).toFixed(4)} {selectedToken.symbol}</p>
                               </div>
                           </div>
                        </div>
                     ) : (
                        <div className="mt-2">
                          {internetVariations.length === 0 ? (
                            <p className="text-center text-xs font-bold text-slate-400 dark:text-slate-500 py-4"><Loader2 className="animate-spin inline-block mr-2" size={14}/> Fetching Live Packages...</p>
                          ) : (
                             <DataVariationsUI 
                               variations={internetVariations} 
                               onSelectPlan={(plan) => {
                                 setSelectedInternetPlan(plan);
                                 setNairaAmount(plan.variation_amount ? plan.variation_amount.toString() : "0");
                               }} 
                             />
                          )}
                        </div>
                     )}
                  </div>
                )}

                {/* CABLE TV SPECIFIC LOGIC */}
                {!isInternational && activeService.id === "CABLE" && (cableProvider === "showmax" || customerName) && (
                  <div className="bg-slate-50 dark:bg-[#1a1a1f] border border-slate-200 dark:border-slate-800/80 rounded-2xl p-4 shadow-sm animate-in fade-in slide-in-from-top-4 transition-colors">
                     {cableProvider !== "showmax" && (
                         <div className="flex items-start justify-between border-b border-slate-200 dark:border-slate-800/80 pb-3 mb-3 transition-colors">
                            <div>
                              <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">Verified Customer</p>
                              <p className="font-black text-slate-800 dark:text-slate-200 text-sm">{customerName}</p>
                              {['dstv', 'gotv'].includes(cableProvider) && (
                                <p className="text-xs font-bold text-emerald-600 dark:text-emerald-400 mt-1 flex items-center gap-1"><Tv size={12}/> {cableCurrentBouquet}</p>
                              )}
                            </div>
                         </div>
                     )}

                     {['dstv', 'gotv'].includes(cableProvider) ? (
                       <>
                         <div className="flex gap-2 p-1.5 bg-slate-200/50 dark:bg-slate-800/50 rounded-xl mb-4 shadow-inner transition-colors">
                            <button 
                              onClick={() => { setCableSubscriptionType("renew"); setNairaAmount(cableRenewAmount ? cableRenewAmount.toString() : ""); setSelectedCablePlan(null); }} 
                              className={`flex-1 flex items-center justify-center gap-2 py-3 text-[11px] font-black uppercase tracking-wider rounded-xl transition-all ${cableSubscriptionType === "renew" ? "bg-white dark:bg-[#111114] text-emerald-600 dark:text-emerald-400 shadow-lg" : "text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"}`}
                            >
                              <RefreshCw size={14}/> Renew Plan
                            </button>
                            <button 
                              onClick={() => { setCableSubscriptionType("change"); setNairaAmount(""); }} 
                              className={`flex-1 flex items-center justify-center gap-2 py-3 text-[11px] font-black uppercase tracking-wider rounded-xl transition-all ${cableSubscriptionType === "change" ? "bg-white dark:bg-[#111114] text-blue-600 dark:text-blue-400 shadow-lg" : "text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"}`}
                            >
                              <ListPlus size={14}/> Change Plan
                            </button>
                         </div>

                         {cableSubscriptionType === "renew" ? (
                            <div className="bg-emerald-500/10 dark:bg-emerald-900/20 border border-emerald-500/20 dark:border-emerald-800/50 rounded-xl p-4 text-center transition-colors">
                               <p className="text-[10px] font-black text-emerald-800 dark:text-emerald-300 uppercase tracking-widest mb-1">Renewal Amount Due</p>
                               <p className="text-2xl font-black text-emerald-600 dark:text-emerald-400">₦{cableRenewAmount?.toLocaleString() || "0.00"}</p>
                               {currentFee > 0 && <p className="text-[10px] font-black text-orange-500 dark:text-orange-400 mt-1">+₦{currentFee} FEE INCLUDED</p>}
                            </div>
                         ) : (
                            selectedCablePlan ? (
                               <div className="relative animate-in zoom-in-95 duration-200 mt-2">
                                  <button onClick={() => { setSelectedCablePlan(null); setNairaAmount(""); }} className="absolute -top-3 -right-3 bg-slate-200 dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-300 dark:hover:bg-slate-700 rounded-full p-1 transition-all z-10 shadow-sm border border-white dark:border-[#111114]">
                                    <XCircle size={16}/>
                                  </button>
                                  <div className="p-4 rounded-2xl border-2 border-blue-500 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/10 shadow-sm text-left transition-colors">
                                     <p className="font-black text-slate-900 dark:text-white text-lg tracking-tight">{selectedCablePlan.name}</p>
                                     <p className="text-[10px] text-blue-500 dark:text-blue-400 font-bold uppercase tracking-wider mb-2">Selected Package</p>
                                     <div className="pt-2 border-t border-blue-200/50 dark:border-blue-800/50 flex justify-between items-end transition-colors">
                                         <div>
                                            <p className="font-black text-blue-600 dark:text-blue-400 text-xl leading-none">₦{parseFloat(selectedCablePlan.variation_amount).toLocaleString()}</p>
                                            {currentFee > 0 && <p className="text-[9px] font-black text-orange-500 dark:text-orange-400 mt-1">+₦{currentFee} FEE INCLUDED</p>}
                                         </div>
                                         <p className="text-[10px] text-slate-500 dark:text-slate-400 font-bold">{(parseFloat(selectedCablePlan.variation_amount) / exchangeRate).toFixed(4)} {selectedToken.symbol}</p>
                                     </div>
                                  </div>
                               </div>
                            ) : (
                               <div className="grid grid-cols-1 gap-2 max-h-[35vh] overflow-y-auto pr-1">
                                 {cableVariations.length === 0 ? (
                                   <p className="text-center text-xs font-bold text-slate-400 dark:text-slate-500 py-4"><Loader2 className="animate-spin inline-block mr-2" size={14}/> Fetching Live Packages...</p>
                                 ) : (
                                   cableVariations.map((plan) => {
                                     const cryptoPlanCost = (parseFloat(plan.variation_amount) / exchangeRate).toFixed(4);
                                     return (
                                       <button 
                                         key={plan.variation_code} 
                                         onClick={() => { setSelectedCablePlan(plan); setNairaAmount(plan.variation_amount); }} 
                                         className="p-3 rounded-xl border border-slate-200 dark:border-slate-800/80 bg-white dark:bg-[#111114] hover:border-slate-300 dark:hover:border-slate-700 transition-all text-left flex justify-between items-center group"
                                       >
                                         <div>
                                           <p className="font-black text-slate-800 dark:text-slate-200 text-xs">{plan.name}</p>
                                           <p className="text-[9px] text-slate-400 dark:text-slate-500 font-bold mt-0.5">{cryptoPlanCost} {selectedToken.symbol}</p>
                                         </div>
                                         <p className="font-black text-blue-600 dark:text-blue-400 text-sm group-hover:scale-110 transition-transform">₦{parseFloat(plan.variation_amount).toLocaleString()}</p>
                                       </button>
                                     );
                                   })
                                 )}
                               </div>
                            )
                         )}
                       </>
                     ) : (
                       selectedCablePlan ? (
                          <div className="relative animate-in zoom-in-95 duration-200 mt-2">
                             <button onClick={() => { setSelectedCablePlan(null); setNairaAmount(""); }} className="absolute -top-3 -right-3 bg-slate-200 dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-300 dark:hover:bg-slate-700 rounded-full p-1 transition-all z-10 shadow-sm border border-white dark:border-[#111114]">
                               <XCircle size={16}/>
                             </button>
                             <div className="p-4 rounded-2xl border-2 border-blue-500 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/10 shadow-sm text-left transition-colors">
                                <p className="font-black text-slate-900 dark:text-white text-lg tracking-tight">{selectedCablePlan.name}</p>
                                <p className="text-[10px] text-blue-500 dark:text-blue-400 font-bold uppercase tracking-wider mb-2">Selected Package</p>
                                <div className="pt-2 border-t border-blue-200/50 dark:border-blue-800/50 flex justify-between items-end transition-colors">
                                    <div>
                                       <p className="font-black text-blue-600 dark:text-blue-400 text-xl leading-none">₦{parseFloat(selectedCablePlan.variation_amount).toLocaleString()}</p>
                                       {currentFee > 0 && <p className="text-[9px] font-black text-orange-500 dark:text-orange-400 mt-1">+₦{currentFee} FEE INCLUDED</p>}
                                    </div>
                                    <p className="text-[10px] text-slate-500 dark:text-slate-400 font-bold">{(parseFloat(selectedCablePlan.variation_amount) / exchangeRate).toFixed(4)} {selectedToken.symbol}</p>
                                 </div>
                             </div>
                          </div>
                       ) : (
                          <div className="grid grid-cols-1 gap-2 max-h-[35vh] overflow-y-auto pr-1">
                            {cableVariations.length === 0 ? (
                              <p className="text-center text-xs font-bold text-slate-400 dark:text-slate-500 py-4"><Loader2 className="animate-spin inline-block mr-2" size={14}/> Fetching Live Packages...</p>
                            ) : (
                              cableVariations.map((plan) => {
                                const cryptoPlanCost = (parseFloat(plan.variation_amount) / exchangeRate).toFixed(4);
                                return (
                                  <button 
                                    key={plan.variation_code} 
                                    onClick={() => { setSelectedCablePlan(plan); setNairaAmount(plan.variation_amount); }} 
                                    className="p-3 rounded-xl border border-slate-200 dark:border-slate-800/80 bg-white dark:bg-[#111114] hover:border-slate-300 dark:hover:border-slate-700 transition-all text-left flex justify-between items-center group"
                                  >
                                    <div>
                                      <p className="font-black text-slate-800 dark:text-slate-200 text-xs">{plan.name}</p>
                                      <p className="text-[9px] text-slate-400 dark:text-slate-500 font-bold mt-0.5">{cryptoPlanCost} {selectedToken.symbol}</p>
                                    </div>
                                    <p className="font-black text-blue-600 dark:text-blue-400 text-sm group-hover:scale-110 transition-transform">₦{parseFloat(plan.variation_amount).toLocaleString()}</p>
                                  </button>
                                );
                              })
                            )}
                          </div>
                       )
                     )}
                  </div>
                )}

                {/* LOCAL AIRTIME OR ELECTRICITY INPUT */}
                {!isInternational && (activeService.id === "AIRTIME" || activeService.id === "ELECTRICITY") && (
                    <div>
                        <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase mb-2 flex justify-between items-center">
                           <span>Amount</span>
                           <span className="text-emerald-500 dark:text-emerald-400 font-black">MIN ₦{currentMinDisplay.toLocaleString()}</span>
                        </label>
                        <div className="relative mb-3">
                            <input 
                                type="number" 
                                placeholder="Amount" 
                                className="w-full bg-slate-50 dark:bg-[#1a1a1f] border border-slate-100 dark:border-slate-800/80 p-6 rounded-2xl font-black text-3xl text-slate-800 dark:text-white outline-none shadow-inner focus:border-emerald-500 dark:focus:border-emerald-500 transition-colors"
                                value={nairaAmount}
                                onChange={(e) => setNairaAmount(e.target.value)}
                            />
                            <div className="absolute right-5 top-1/2 -translate-y-1/2 text-right">
                                <p className="text-sm font-black text-emerald-600 dark:text-emerald-400">{cryptoToCharge} {selectedToken.symbol}</p>
                                {currentFee > 0 && <p className="text-[9px] font-black text-orange-500 dark:text-orange-400">+₦{currentFee} FEE</p>}
                            </div>
                        </div>

                        {nairaAmount && !isFixedPlan && (parseFloat(nairaAmount) < currentMinDisplay || parseFloat(nairaAmount) > dynamicMaxAmount) && (
                            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50 p-3 rounded-xl mt-2 flex items-center gap-2 animate-in fade-in transition-colors">
                                <AlertTriangle size={16} className="text-red-500 dark:text-red-400 shrink-0" />
                                <p className="text-xs font-black text-red-600 dark:text-red-400">
                                    {parseFloat(nairaAmount) < currentMinDisplay ? `Amount is below the minimum of ₦${currentMinDisplay.toLocaleString()}` : `Amount exceeds the maximum of ₦${dynamicMaxAmount.toLocaleString()}`}
                                </p>
                            </div>
                        )}
                        {/* ⚡ ELECTRICITY DAILY DUPLICATE WARNING ⚡ */}
                        {electricityDailyDuplicate && (
                            <div className="bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800/50 p-4 rounded-xl mt-2 flex items-start gap-3 animate-in fade-in transition-colors">
                                <AlertTriangle size={18} className="text-orange-500 dark:text-orange-400 shrink-0 mt-0.5" />
                                <div>
                                    <p className="text-sm font-black text-orange-800 dark:text-orange-300">Daily Limit Reached</p>
                                    <p className="text-xs font-bold text-orange-700 dark:text-orange-400 leading-snug mt-1">
                                        You already successfully purchased exactly ₦{parseInt(nairaAmount).toLocaleString()} for this meter today. 
                                    </p>
                                    <p className="text-[10px] font-black text-orange-600 dark:text-orange-300 bg-orange-100 dark:bg-orange-900/50 p-2 rounded-lg mt-2 uppercase transition-colors">
                                        💡 Hint: To buy more electricity today, change the amount slightly (e.g., ₦{(parseInt(nairaAmount) + 100).toLocaleString()}).
                                    </p>
                                </div>
                            </div>
                        )}
                        <div className="flex gap-2.5 overflow-x-auto py-1.5 mt-3 no-scrollbar bg-slate-100 dark:bg-[#1a1a1f] p-2 rounded-2xl shadow-inner transition-colors">
                          {(activeService.id === "AIRTIME" ? PRE_SELECT_AMOUNTS : ELEC_PRE_SELECT_AMOUNTS).map(amountStr => {
                            const amountVal = parseInt(amountStr);
                            const cryptoAmtCost = (amountVal / exchangeRate).toFixed(4);
                            const isDisabled = activeService.id === "ELECTRICITY" && amountVal < currentMinDisplay;

                            return (
                              <button 
                                 key={amountStr} 
                                 onClick={() => !isDisabled && setNairaAmount(amountStr)} 
                                 disabled={isDisabled}
                                 className={`flex-1 min-w-[70px] py-4 rounded-xl font-black transition-all whitespace-nowrap ${isDisabled ? 'bg-slate-200 dark:bg-slate-800 text-slate-400 dark:text-slate-600 opacity-50 cursor-not-allowed' : nairaAmount === amountStr ? 'bg-white dark:bg-[#111114] shadow-lg text-emerald-700 dark:text-emerald-400 scale-105' : 'bg-slate-50 dark:bg-slate-800/50 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300'}`}
                              >
                                 ₦{amountVal.toLocaleString()}
                                 <p className={`text-[8px] mt-0.5 font-bold ${isDisabled ? 'text-slate-400 dark:text-slate-600' : 'text-slate-400 dark:text-slate-500'}`}>{cryptoAmtCost} {selectedToken.symbol}</p>
                              </button>
                            );
                          })}
                       </div>
                    </div>
                )}

                {/* ⚡ RESTORED ELECTRICITY SMS FIELD ⚡ */}
                {(!isInternational && (activeService.id === "ELECTRICITY" || (activeService.id === "INTERNET" && internetProvider === 'smile-direct'))) && (
                    <div className="animate-in fade-in mt-3">
                        <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase mb-2 flex justify-between">
                          <span>SMS Phone (For Token/Receipt)</span>
                          <span className={customerPhone.length === 11 ? "text-emerald-500 dark:text-emerald-400" : "text-slate-400 dark:text-slate-500"}>{customerPhone.length}/11</span>
                        </label>
                        <input 
                            type="tel" placeholder="08000000000"
                            maxLength={11}
                            className={`w-full bg-slate-50 dark:bg-[#1a1a1f] border p-5 rounded-2xl font-black text-xl text-slate-800 dark:text-white outline-none transition-all ${
                              customerPhone.length > 0 && customerPhone.length < 11 ? "border-red-300 dark:border-red-500/50 focus:border-red-500" : "border-slate-100 dark:border-slate-800/80 focus:border-emerald-500 dark:focus:border-emerald-500"
                            }`}
                            value={customerPhone}
                            onChange={(e) => setCustomerPhone(e.target.value.replace(/[^0-9]/g, ''))}
                        />
                    </div>
                )}

                {/* ⚡ EMAIL / OPTIONAL INFO ⚡ */}
                <div className="animate-in fade-in mt-3">
                     <input 
                        type="email" 
                        placeholder={isInternational ? "Email Address (Required)" : "Email Address (Optional for Receipt)"}
                        className={`w-full bg-slate-50 dark:bg-[#1a1a1f] border p-5 rounded-2xl font-bold text-slate-700 dark:text-white outline-none transition-colors ${
                            isInternational && customerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail) ? 'border-red-300 dark:border-red-500/50 focus:border-red-500' : 'border-slate-100 dark:border-slate-800/80 focus:border-emerald-500 dark:focus:border-emerald-500'
                        }`}
                        value={customerEmail}
                        onChange={(e) => setCustomerEmail(e.target.value)}
                    />
                    {isInternational && customerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail) && (
                        <p className="text-[10px] text-red-500 dark:text-red-400 font-bold mt-1.5 ml-2">Please enter a valid email address.</p>
                    )}
                </div>

                {/* ⚡ Early discount visibility — shown in the main form as soon as an amount
                     exists, not just at the final confirm modal, so the user sees the saving
                     before they even reach checkout. Works for international requests too —
                     shown in whichever foreign currency the rest of the checkout is already
                     displaying (see foreignDiscountAmount above), not always ₦. */}
                {discountNgn > 0 && (
                    <div className="bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800/50 p-4 rounded-2xl flex items-center gap-3 animate-in fade-in transition-colors">
                        <span className="text-2xl">🎉</span>
                        <div>
                            <p className="text-xs font-black text-emerald-700 dark:text-emerald-400">{activeDiscount?.name || 'Discount'} applied</p>
                            <p className="text-[10px] font-bold text-emerald-600 dark:text-emerald-500">
                                You save {isInternational
                                    ? `${intlCurrency || activeCountry.currency || activeCountry.code} ${(foreignDiscountAmount || 0).toLocaleString()}`
                                    : `₦${discountNgn.toLocaleString()}`} on this payment
                            </p>
                        </div>
                    </div>
                )}

                {status && (
                    <div className={`p-5 rounded-2xl border flex items-center gap-4 animate-in fade-in shadow-sm transition-colors ${status.includes('Success') || status.includes('Secured') || status.includes('Initiating') ? 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-100 dark:border-emerald-800/50 text-emerald-800 dark:text-emerald-400' : status.includes('Processing') ? 'bg-orange-50 dark:bg-orange-900/20 border-orange-100 dark:border-orange-800/50 text-orange-800 dark:text-orange-400' : 'bg-blue-50 dark:bg-blue-900/20 border-blue-100 dark:border-blue-800/50 text-blue-800 dark:text-blue-400'}`}>
                        {status.includes('Success') ? <CheckCircle2 size={24}/> : <Loader2 size={24} className="animate-spin"/>}
                        <p className="text-sm font-black tracking-tight flex-1">{status}</p>
                        {isProcessing && canStopWaiting && (
                            <button onClick={stopWaitingForWallet} className="shrink-0 text-[11px] font-black tracking-tight underline underline-offset-2 opacity-70 hover:opacity-100">
                                STOP WAITING
                            </button>
                        )}
                    </div>
                )}

                <button
                    onClick={() => setIsConfirmModalOpen(true)}
                    disabled={isVerifying || !isFormValid || isProcessing || isCurrentServiceDisabled}
                    className={`w-full text-white dark:text-slate-900 font-black py-6 rounded-3xl flex items-center justify-center gap-3.5 transition-all active:scale-95 shadow-xl text-lg tracking-tight ${(!isFormValid || isCurrentServiceDisabled) ? 'bg-slate-300 dark:bg-slate-800 opacity-50 cursor-not-allowed text-slate-500 dark:text-slate-500 shadow-none' : 'bg-slate-900 dark:bg-white hover:bg-black dark:hover:bg-slate-200 disabled:opacity-30 shadow-slate-900/20 dark:shadow-white/10'}`}
                >
                    {isProcessing ? <Loader2 size={24} className="animate-spin text-emerald-400 dark:text-emerald-600"/> : <ShieldCheck size={24} className={isCurrentServiceDisabled ? 'text-slate-400 dark:text-slate-500' : 'text-emerald-400 dark:text-emerald-600'} />}
                    {isCurrentServiceDisabled ? 'TEMPORARILY OFFLINE' : isProcessing ? 'PROCESSING...' : `PAY ${cryptoToCharge} ${selectedToken.symbol}`}
                </button>
            </div>
          </div>
        )}

        {/* ======================================= */}
        {/* HISTORY BLOCK */}
        {/* ======================================= */}
        {activeTab === 'history' && (
          <div data-tour="history-tab">
            <HistoryTab
              transactions={transactions}
              currentTransactions={currentTransactions}
              currentPage={currentPage}
              totalPages={totalPages}
              setCurrentPage={setCurrentPage}
              setSelectedReceipt={setSelectedReceipt}
            />
          </div>
        )}

        {/* ======================================= */}
        {/* DeAI AGENT BLOCK */}
        {/* ======================================= */}
        {activeTab === 'agent' && (
          <div data-tour="agent-tab">
          <AgentHub
            address={address ?? undefined}
            selectedToken={selectedToken}
            activeChainName={normalizeChainName(activeChain?.name)}
            onApproveAllowance={handleApproveAgentAllowance}
            onCheckAllowance={checkAgentAllowanceFor}
            currentAllowance={agentAllowance}
            isApproving={isApprovingAgent}
            onSignMessage={signAgentMessage}
          />
          </div>
        )}

        <AppFooter network={activeNetworkDisplay} />

        {/* ⚡ In-app DeAI assistant — understands requests, fills the form. Never pays. */}
        <AIChat
          onPrefill={handleAIPrefill}
          onNavigate={handleAINavigate}
          walletConnected={!!address}
          onRequireWallet={() => showToast("Connect Your Wallet", "Connect your wallet first — the assistant fills a payment you still need to sign.", "error")}
          walletAddress={address ?? undefined}
          chain={normalizeChainName(activeChain?.name)}
          tokenSymbol={selectedToken.symbol}
        />
      </div>

      <AppTour
        active={tourActive}
        onFinish={() => setTourActive(false)}
        onTabChange={(tab: TourTab) => handleTabSwitch(tab)}
      />
    </main>
  );
}
