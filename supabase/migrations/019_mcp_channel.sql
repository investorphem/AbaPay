-- Adds 'MCP' as a valid agent_links channel so AI agents (Claude, or any MCP-speaking
-- client) can link a wallet the same way Telegram/WhatsApp/X do, via /api/mcp.
--
-- Unlike the chat channels, there's no bot to "claim" a link code with — the credential
-- IS the API key, delivered once at creation. channel_user_id stores a SHA-256 hash of
-- that key (never the raw key), which is also how the (channel, channel_user_id) unique
-- constraint continues to do its job of preventing collisions.
--
-- mcp_key_label lets a user tell multiple MCP keys apart in the AgentHub UI (e.g. "Claude
-- Desktop", "My agent") since channel_user_id is just an opaque hash, not a readable id
-- the way a phone number or @handle is for the chat channels.

alter table public.agent_links drop constraint if exists agent_links_channel_check;
alter table public.agent_links add constraint agent_links_channel_check
  check (channel in ('TELEGRAM','WHATSAPP','X','MCP'));

alter table public.agent_links add column if not exists mcp_key_label text;
