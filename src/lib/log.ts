// 📋 STRUCTURED LOGGING + METRICS (M5).
//
// Money-path code used to log free-form `console.*` lines: nothing tied the four or five lines
// one payment produced together, nothing could be counted, and a stray `console.log(payload)`
// could print a signature or a PIN. Every line written through here is:
//   • one JSON object (so a Vercel log drain can index it): ts, level, event, then fields;
//   • tied together by `request_id` (the payment intent id) and `tx_hash` where known;
//   • REDACTED before it is written (see SECRET_KEYS / maskEmail / maskPhone below).
//
// Metrics are log lines too (`event: "metric"`, `metric`, `value`, `labels`), so counting them
// needs no extra service: a drain or a `vercel logs | jq` can aggregate. OpenTelemetry can be
// added behind `metric()` later without touching callers.
//
// Rollback: LOG_FORMAT=plain writes the same content as readable text (still redacted).

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// Keys whose VALUE is never written, at any depth. Matched case-insensitively on the key name.
const SECRET_KEYS = /^(pin|new_pin|pin_hash|api_?key|x-api-key|apikey|signature|sig|x-wallet-signature|x-wallet-siwe|x-payment|payment(_|-)?header|authorization|cookie|set-cookie|secret|client_secret|private_?key|otp|password|token_secret|access_token|refresh_token|purchased_code|deai_pin)$/i;
const EMAIL_KEYS = /^(email|customer_email|notify_email|user_email)$/i;
const PHONE_KEYS = /^(phone|phone_number|msisdn|whatsapp_number)$/i;

function minLevel(): Level {
  const l = String(process.env.LOG_LEVEL || 'info').toLowerCase() as Level;
  return l in ORDER ? l : 'info';
}

export function maskEmail(v: string): string {
  const [user, domain] = String(v).split('@');
  if (!domain) return '[redacted]';
  return `${user.slice(0, 1)}***@${domain.slice(0, 1)}***${domain.includes('.') ? domain.slice(domain.lastIndexOf('.')) : ''}`;
}

export function maskPhone(v: string): string {
  const digits = String(v).replace(/\D/g, '');
  return digits.length >= 4 ? `***${digits.slice(-4)}` : '[redacted]';
}

/** Deep copy with secrets removed and contact details masked. Safe on cycles and errors. */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value == null || typeof value !== 'object') return value;
  if (depth > 6) return '[depth]';
  if (seen.has(value as object)) return '[cycle]';
  seen.add(value as object);
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.test(k)) out[k] = v == null || v === '' ? v : '[redacted]';
    else if (EMAIL_KEYS.test(k) && typeof v === 'string') out[k] = maskEmail(v);
    else if (PHONE_KEYS.test(k) && typeof v === 'string') out[k] = maskPhone(v);
    else out[k] = redact(v, depth + 1, seen);
  }
  return out;
}

export interface LogFields {
  request_id?: string | null;
  tx_hash?: string | null;
  rail?: string;
  channel?: string;
  duration_ms?: number;
  [k: string]: unknown;
}

function write(level: Level, event: string, fields: LogFields = {}) {
  if (ORDER[level] < ORDER[minLevel()]) return;
  const safe = redact(fields) as Record<string, unknown>;
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (process.env.LOG_FORMAT === 'plain') {
    sink(`[${level}] ${event}`, safe);
    return;
  }
  try {
    sink(JSON.stringify({ ts: new Date().toISOString(), level, event, ...safe }));
  } catch {
    sink(`[${level}] ${event} (unserializable fields)`);
  }
}

export const log = {
  debug: (event: string, fields?: LogFields) => write('debug', event, fields),
  info: (event: string, fields?: LogFields) => write('info', event, fields),
  warn: (event: string, fields?: LogFields) => write('warn', event, fields),
  error: (event: string, fields?: LogFields) => write('error', event, fields),
};

/**
 * Emit a metric as a structured line. Counters pass the default value 1; gauges and latencies
 * pass the measurement. Labels are low-cardinality strings (rail, chain, provider, outcome).
 */
export function metric(name: string, value = 1, labels: Record<string, string | number | boolean | null | undefined> = {}) {
  write('info', 'metric', { metric: name, value, labels });
}

/** Time an async operation and emit `<name>` (ms) with the given labels. */
export async function timed<T>(name: string, labels: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    metric(name, Date.now() - start, labels);
  }
}
