// The parts of a VTpass /pay or /requery reply that AbaPay reads. VTpass is inconsistent about
// where a delivered token lives (top level as `purchased_code` / `token` / `tokens` / `Pin`, or
// inside `content.transactions`), so every location is optional and readers try them in turn.
export interface VtpassTransaction {
  status?: string;
  token?: string;
  purchased_code?: string;
  units?: string | number;
  unit?: string | number;
  transactionId?: string;
  [key: string]: unknown;
}

export interface VtpassReply {
  code?: string;
  response_description?: string;
  purchased_code?: string;
  token?: string;
  tokens?: string;
  Pin?: string;
  units?: string | number;
  content?: { transactions?: VtpassTransaction; [key: string]: unknown };
  [key: string]: unknown;
}

/** A VTpass push notification: sometimes wrapped in `data`, sometimes not. */
export interface VtpassPush {
  data?: VtpassPush;
  requestId?: string;
  [key: string]: unknown;
}

/**
 * A /requery reply meaning VTpass never received this request_id: nothing was vended and nothing
 * can be later, so the payment is safe to refund. VTpass says it as code 015 ("INVALID REQUEST
 * ID"), not as an empty reply — and treating 015 as "still processing" left a payment whose /pay
 * call got an HTML error page PROCESSING forever (2026-10-16, an x402 USA₮ airtime payment).
 */
export function vtpassHasNoRecord(reply: VtpassReply | null | undefined): boolean {
  if (!reply || typeof reply !== 'object') return false;
  if (reply.content?.transactions?.status) return false; // it knows the transaction
  if (String(reply.code ?? '') === '015') return true;
  if (/invalid request id|does not exist|no (such )?transaction|not found/i.test(String(reply.response_description ?? ''))) return true;
  return !reply.content && !reply.response_description;
}
