-- Lifetime cap per VERIFIED phone number (abapay_users.verified_phone, resolved via
-- wallet_links.user_id) — a much stronger identity signal than a wallet address, since a
-- Nigerian SIM costs money and requires registration, unlike a free, instant wallet. When set
-- on a campaign, a wallet with no verified phone is denied the discount outright rather than
-- risk over-granting it — meaning enabling this cap also effectively requires phone
-- verification to participate in that campaign.
alter table public.discount_campaigns
  add column if not exists max_discount_per_phone_ngn numeric;

-- Snapshot of the verified phone a discount was attributed to at grant time (not the service
-- recipient's number — that's the existing `phone`/`account_number` columns). Stored rather
-- than re-resolved later so a subsequent phone-verification change on the account can't alter
-- historical accounting.
alter table public.transactions
  add column if not exists discount_phone text;

-- Master on/off switch for the IP-based suspicious-cluster panel in the admin Discounts tab —
-- separate from any individual campaign's caps, since it's a detection/visibility feature, not
-- a per-campaign rule. Mirrors platform_settings' existing single-row pattern (ai_chat_enabled,
-- agent_enabled, ...).
alter table public.platform_settings
  add column if not exists discount_fraud_flagging_enabled boolean not null default true;
