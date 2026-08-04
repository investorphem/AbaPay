-- Lightweight rolling log of group messages the Telegram bot has seen (Group Privacy is off,
-- so every message in a group the bot is a member of reaches the webhook now, not just @mentions).
-- Powers "recharge 5 random numbers from the last 30 minutes" — there is no Bot API endpoint to
-- fetch group history on demand, so it has to be captured as it arrives.
create table if not exists telegram_group_messages (
  id bigserial primary key,
  chat_id text not null,
  sender_id text not null,
  sender_name text,
  text text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_telegram_group_messages_chat_created
  on telegram_group_messages (chat_id, created_at desc);

-- Supports the opportunistic prune (delete anything older than 48h) without a full table scan.
create index if not exists idx_telegram_group_messages_created
  on telegram_group_messages (created_at);
