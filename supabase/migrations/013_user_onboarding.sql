-- Tracks whether a chat has ever seen the first-contact feature tour, independent of whether
-- it's linked to a wallet (agent_links) or still a guest — guests have no other durable
-- identity row, so without this every "hi" from a guest looked identical to their very first
-- message ever, and a returning user's own earlier decision to finish/skip the tour couldn't
-- be remembered — they'd get re-interrupted by it on every conversation.
create table if not exists public.user_onboarding (
  platform text not null,
  channel_id text not null,
  current_step int not null default 0,
  completed boolean not null default false,
  dismissed boolean not null default false,
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (platform, channel_id)
);
