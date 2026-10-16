import 'server-only';
import { supabaseAdmin as supabase } from '@/utils/supabase';
import { getCatalog, limitsFor, type CatalogCategory } from '@/lib/vtpassCatalog';
import { fetchDataVariations, verifyAccount } from '@/lib/deai/services';
import { checkAccountNumber } from '@/lib/parity';

// ⚡ THE WHATSAPP CHECKOUT FORM — a whole purchase in one WhatsApp Flow.
//
// Every bot reply on WhatsApp is a billable message past Meta's monthly allowance, and a chat
// purchase takes 6–8 of them (service, provider, number, plan, chain, token, confirm, PIN). The
// checkout Flow collects the order in screens inside ONE message; the Flow's data endpoint
// (src/app/api/whatsapp/flow) answers each screen with live VTpass data, and those calls are not
// messages, so they are not billed. Then: one reply with the confirmation and the "Enter PIN"
// button, and the receipt.
//
// Screens: SERVICE → PROVIDER → DETAILS → CONFIRM. The DETAILS answer verifies the account
// (meter, smartcard) with VTpass, builds the order in the DeAI engine's own shape and stores it
// server-side against the user's number (whatsapp_flow_orders). Submitting the form only tells
// the engine "run the stored order for this chat" (core/route.ts, flow_order): nothing the
// device sends back is used as order data, and the engine still runs every one of its gates.

export const CHECKOUT_FLOW_TOKEN_PREFIX = 'abapay-checkout:';

type Svc = 'AIRTIME' | 'DATA' | 'ELECTRICITY' | 'CABLE' | 'EDUCATION';
const SERVICES: Record<Svc, { label: string; category: CatalogCategory; intent: string; numberLabel: string; plan: boolean; amount: boolean; phone: boolean; meter: boolean }> = {
  AIRTIME: { label: 'Airtime', category: 'airtime', intent: 'VEND_AIRTIME', numberLabel: 'Phone number to top up', plan: false, amount: true, phone: false, meter: false },
  DATA: { label: 'Data', category: 'data', intent: 'VEND_DATA', numberLabel: 'Phone number', plan: true, amount: false, phone: false, meter: false },
  ELECTRICITY: { label: 'Electricity', category: 'electricity-bill', intent: 'ELECTRICITY', numberLabel: 'Meter number', plan: false, amount: true, phone: true, meter: true },
  CABLE: { label: 'Cable TV', category: 'tv-subscription', intent: 'TV', numberLabel: 'Smartcard / IUC number', plan: true, amount: false, phone: true, meter: false },
  EDUCATION: { label: 'Exam PINs', category: 'education', intent: 'EDUCATION', numberLabel: 'Your phone number', plan: true, amount: false, phone: false, meter: false },
};
const isSvc = (s: unknown): s is Svc => typeof s === 'string' && s in SERVICES;
/** Providers the form can't complete (an extra account lookup the web app does, or not sold). */
const EXCLUDED = new Set(['smile-direct', 'spectranet', 'jamb', 'showmax']);

const ngn = (n: number) => `₦${n.toLocaleString('en-NG')}`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const digits = (s: unknown) => String(s ?? '').replace(/[^\d]/g, '');

/** The WhatsApp number a checkout flow_token was issued to (abapay-checkout:<wa_id>:<nonce>). */
export function chatFromToken(token: unknown): string | null {
  const m = /^abapay-checkout:(\d{6,15}):[\w-]+$/.exec(String(token ?? ''));
  return m ? m[1] : null;
}

export type FlowRequest = { action?: string; screen?: string; data?: Record<string, unknown>; flow_token?: string; version?: string };
export type FlowResponse = { screen?: string; data: Record<string, unknown> };

/** Answer one decrypted data-endpoint request. */
export async function handleCheckoutRequest(req: FlowRequest): Promise<FlowResponse> {
  if (req.action === 'ping') return { data: { status: 'active' } };
  // WhatsApp reports a client-side error in a response we sent: acknowledge it.
  if (req.data && 'error' in req.data) return { data: { acknowledged: true } };
  if (req.action === 'INIT') return serviceScreen();

  const chat = chatFromToken(req.flow_token);
  if (!chat) return serviceScreen('This form has expired. Close it and send *menu* again.');
  const data = req.data || {};

  switch (req.screen) {
    case 'SERVICE': return providerScreen(data.service);
    case 'PROVIDER': return detailsScreen(data.service, data.provider);
    case 'DETAILS': return confirmOrRetry(chat, String(req.flow_token), data);
    default: return serviceScreen();
  }
}

function serviceScreen(error = ''): FlowResponse {
  return { screen: 'SERVICE', data: { error_message: error, has_error: !!error } };
}

async function providerScreen(service: unknown): Promise<FlowResponse> {
  if (!isSvc(service)) return serviceScreen('Choose what you want to pay for.');
  const s = SERVICES[service];
  const { providers } = await getCatalog(s.category);
  const list = providers.filter((p) => !EXCLUDED.has(p.serviceID)).map((p) => ({ id: p.serviceID, title: clip(p.displayName, 30) }));
  if (!list.length) return serviceScreen(`${s.label} is unavailable right now. Please try again shortly.`);
  return { screen: 'PROVIDER', data: { service, service_label: s.label, providers: list } };
}

async function detailsScreen(service: unknown, provider: unknown, error = '', keep: Record<string, unknown> = {}): Promise<FlowResponse> {
  if (!isSvc(service)) return serviceScreen('Choose what you want to pay for.');
  const s = SERVICES[service];
  const serviceID = String(provider || '');
  const { providers } = await getCatalog(s.category);
  const p = providers.find((x) => x.serviceID === serviceID);
  if (!p) return providerScreen(service);

  let plans: { id: string; title: string; description: string }[] = [];
  if (s.plan) {
    plans = (await fetchDataVariations(serviceID)).slice(0, 200).map((v) => ({
      id: v.code,
      title: clip(`${ngn(v.price)} · ${v.name.replace(/\s*-\s*N[\d,.]+$/i, '')}`, 30),
      description: clip(v.name, 300),
    }));
    if (!plans.length) return providerScreen(service);
  }

  return {
    screen: 'DETAILS',
    data: {
      service, provider: serviceID, provider_label: p.displayName,
      number_label: s.numberLabel,
      show_plan: s.plan, plans,
      show_amount: s.amount, amount_label: p.minAmount ? `Amount in naira (min ${ngn(p.minAmount)})` : 'Amount in naira',
      show_meter_type: s.meter,
      show_phone: s.phone,
      show_email: service === 'ELECTRICITY' || service === 'EDUCATION',
      error_message: error, has_error: !!error,
      ...keep,
    },
  };
}

async function confirmOrRetry(chat: string, flowToken: string, d: Record<string, unknown>): Promise<FlowResponse> {
  const service = d.service;
  if (!isSvc(service)) return serviceScreen('Choose what you want to pay for.');
  const s = SERVICES[service];
  const serviceID = String(d.provider || '');
  const retry = (msg: string) => detailsScreen(service, serviceID, msg);

  const { providers } = await getCatalog(s.category);
  const p = providers.find((x) => x.serviceID === serviceID);
  if (!p) return retry('That provider is unavailable right now. Close the form and try again.');

  // The number: a phone for airtime/data/exam PINs (local format), a meter or smartcard otherwise.
  let account = digits(d.number);
  if (account.startsWith('234') && account.length === 13) account = `0${account.slice(3)}`;
  const acct = checkAccountNumber(s.intent, account, serviceID);
  if (!acct.valid) return retry(acct.error || `Check the ${s.numberLabel.toLowerCase()}.`);

  let phone = s.phone ? digits(d.phone) : account;
  if (phone.startsWith('234') && phone.length === 13) phone = `0${phone.slice(3)}`;
  if (!/^0[789][01]\d{8}$/.test(phone)) return retry('Enter a valid Nigerian phone number, e.g. 08012345678.');

  const email = String(d.email || '').trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return retry('That email address doesn’t look right.');

  const order: Record<string, unknown> = {
    intent: s.intent, provider: serviceID, provider_label: p.displayName,
    destination_account: account, phone, email: email || null, email_choice_made: true,
    pin_attempts: 0, source: 'whatsapp_flow',
  };

  let amount = 0;
  let what = '';
  if (s.plan) {
    const plan = (await fetchDataVariations(serviceID)).find((v) => v.code === d.plan);
    if (!plan) return retry('Choose a plan.');
    amount = plan.price;
    what = plan.name;
    Object.assign(order, { variation_code: plan.code, variation_label: plan.name, amount_ngn: amount });
    if (service === 'CABLE') order.cable_action = 'change';
  } else {
    amount = Number(digits(d.amount));
    const lim = await limitsFor(s.category, serviceID);
    if (!amount) return retry('Enter an amount.');
    if (lim.min && amount < lim.min) return retry(`The minimum for ${p.displayName} is ${ngn(lim.min)}.`);
    if (lim.max && amount > lim.max) return retry(`The maximum for ${p.displayName} is ${ngn(lim.max)}.`);
    order.amount_ngn = amount;
  }

  // Verify the meter or smartcard with VTpass now, so the confirm screen shows whose it is.
  let who = '';
  if (service === 'ELECTRICITY' || service === 'CABLE') {
    const meterType = service === 'ELECTRICITY' ? (d.meter_type === 'postpaid' ? 'postpaid' : 'prepaid') : undefined;
    const v = await verifyAccount(serviceID, account, meterType);
    if (!v.success) return retry(v.message || `We couldn't verify that ${s.numberLabel.toLowerCase()}.`);
    if (service === 'ELECTRICITY' && v.min_amount && amount < v.min_amount) return retry(`This meter's minimum purchase is ${ngn(v.min_amount)}.`);
    Object.assign(order, { meter_type: meterType, verified_name: v.customer_name, customer_name: v.customer_name, customer_address: v.customer_address, verified_min: v.min_amount });
    who = v.customer_name || '';
  }

  // Pay from the chain and token this wallet approved for the agent, so the chat doesn't ask.
  const { data: link } = await supabase.from('agent_links')
    .select('approved_chain, approved_token').eq('channel', 'WHATSAPP').eq('channel_user_id', chat)
    .eq('is_active', true).eq('link_verified', true).maybeSingle();
  if (link?.approved_chain) order.chain = String(link.approved_chain).toUpperCase();
  if (link?.approved_token) order.selected_token = link.approved_token;

  const { error } = await supabase.from('whatsapp_flow_orders').upsert(
    { chat_id: chat, flow_token: flowToken, intent_data: order, expires_at: new Date(Date.now() + 15 * 60_000).toISOString(), used_at: null },
    { onConflict: 'flow_token' },
  );
  if (error) return retry('Something went wrong saving your order. Please try again.');

  const lines = [
    `${p.displayName}`,
    what ? `Plan: ${what}` : null,
    `${s.numberLabel}: ${account}`,
    who ? `Name: ${who}` : null,
    order.meter_type ? `Meter type: ${order.meter_type}` : null,
    `Amount: ${ngn(amount)}`,
  ].filter(Boolean).join('\n');
  return { screen: 'CONFIRM', data: { summary: lines, footer_note: 'Tap Confirm, then approve with your PIN in the chat. Fees are shown before you pay.' } };
}

/**
 * The newest unused, unexpired checkout order for this chat, marked used so it runs once.
 * Called by the DeAI engine when the form is submitted.
 */
export async function claimFlowOrder(chatId: string): Promise<Record<string, unknown> | null> {
  const { data } = await supabase.from('whatsapp_flow_orders')
    .select('id, intent_data, expires_at, used_at').eq('chat_id', chatId).is('used_at', null)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (!data || new Date(String(data.expires_at)).getTime() < Date.now()) return null;
  const { data: claimed } = await supabase.from('whatsapp_flow_orders')
    .update({ used_at: new Date().toISOString() }).eq('id', data.id).is('used_at', null).select('id').maybeSingle();
  return claimed ? (data.intent_data as Record<string, unknown>) : null;
}

// ── Messages ─────────────────────────────────────────────────────────────────────────────────

export function checkoutFlowId(): string | null {
  const id = process.env.WHATSAPP_CHECKOUT_FLOW_ID;
  return id && /^\d+$/.test(id) ? id : null;
}

/** The "Start a payment" button that opens the checkout form. The token binds it to this chat. */
export function checkoutFlowMessage(to: string, bodyText: string, flowId: string, nonce: string) {
  return {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'flow',
      header: { type: 'text', text: 'AbaPay' },
      body: { text: bodyText.slice(0, 1024) },
      footer: { text: 'Airtime · Data · Electricity · Cable · Exam PINs' },
      action: {
        name: 'flow',
        parameters: {
          flow_message_version: '3',
          flow_token: `${CHECKOUT_FLOW_TOKEN_PREFIX}${to}:${nonce}`,
          flow_id: flowId,
          flow_cta: 'Start a payment',
          flow_action: 'navigate',
          flow_action_payload: { screen: 'SERVICE', data: { error_message: '', has_error: false } },
          ...(process.env.WHATSAPP_CHECKOUT_FLOW_MODE === 'draft' ? { mode: 'draft' } : {}),
        },
      },
    },
  };
}

/**
 * Is this message a submitted checkout form from the chat it was issued to? Returns that chat, or
 * null. A token issued to another number is refused, so a form can only ever place its own order.
 */
export function checkoutCompletion(message: { type?: string; interactive?: { type?: string; nfm_reply?: { response_json?: string } } }, sender: string): string | null {
  if (message?.type !== 'interactive' || message.interactive?.type !== 'nfm_reply') return null;
  try {
    const data = JSON.parse(message.interactive.nfm_reply?.response_json || '{}');
    const chat = chatFromToken(data.flow_token);
    return chat && chat === sender ? chat : null;
  } catch {
    return null;
  }
}

/** Typed words that open the checkout form instead of a chat conversation. */
export const CHECKOUT_TRIGGER_RE = /^\s*(menu|buy|pay|checkout|hi|hello|hey)\s*[!.]*\s*$/i;

/** Any checkout-form reply, whoever it was issued to (used to ignore one that isn't this chat's). */
export function isCheckoutReply(message: { type?: string; interactive?: { type?: string; nfm_reply?: { response_json?: string } } }): boolean {
  if (message?.type !== 'interactive' || message.interactive?.type !== 'nfm_reply') return false;
  try {
    return String(JSON.parse(message.interactive.nfm_reply?.response_json || '{}').flow_token || '').startsWith(CHECKOUT_FLOW_TOKEN_PREFIX);
  } catch {
    return false;
  }
}
