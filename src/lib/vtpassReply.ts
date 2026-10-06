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
