-- Lets the autonomous scheduler report a run's outcome back on whatever channel created the
-- schedule. Previously scheduled_bills only had notify_telegram/notify_email, so a schedule
-- created from WhatsApp or X had no way to be notified — the payment ran (or failed) silently.

alter table public.scheduled_bills
  add column if not exists notify_channel text,          -- 'TELEGRAM' | 'WHATSAPP' | 'X'
  add column if not exists notify_channel_id text;        -- the chat id / wa_id / x user id to DM
