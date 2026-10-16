-- Orders built by the WhatsApp checkout Flow (src/lib/whatsappCheckout.ts).
--
-- The Flow's data endpoint verifies the account with VTpass and builds the order server-side,
-- then stores it here against the user's WhatsApp number. When the user submits the form, the
-- webhook asks the DeAI engine to run "the stored order for this chat": the engine claims the
-- newest unused, unexpired row (marking it used) and continues through its normal checks to the
-- PIN. Nothing the user's device sends back is trusted as order data.
--
-- Service-role only: RLS on, no policies.

create table if not exists public.whatsapp_flow_orders (
  id uuid primary key default gen_random_uuid(),
  chat_id text not null,
  flow_token text not null unique,
  intent_data jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  used_at timestamptz
);

create index if not exists whatsapp_flow_orders_chat_idx on public.whatsapp_flow_orders (chat_id, created_at desc);

alter table public.whatsapp_flow_orders enable row level security;
revoke all on table public.whatsapp_flow_orders from anon, authenticated;
