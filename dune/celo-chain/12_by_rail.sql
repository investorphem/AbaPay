-- AbaPay on Celo — agent rail vs direct wallet vs x402, daily
-- Reads the root query's materialized view; never touches celo.logs. See 00_events.sql.
--
-- ⚡ NUMBERED AHEAD OF by_token / by_service / by_contract, AND KEPT LIVE ON THE
-- DASHBOARD — unlike dune/base-chain/15_by_rail.sql, which was retired/hidden there as
-- "too internal for the audience that dashboard is published for." This is the metric
-- that actually answers "how much of this is agents, not humans clicking Pay":
--
--   • "Direct (wallet)"  — the user signed the transaction themselves, in the app.
--   • "Agent (relayer)"  — the transaction also carried an AgentPayment event, i.e. the
--     relayer spent a spending allowance the user had granted: a payment made from
--     Telegram / WhatsApp / X / MCP without the user opening a wallet for that payment.
--   • "x402"              — a bare stablecoin transfer settled by a facilitator, the
--     rail built specifically for agent-to-agent / machine payment (see
--     docs/AGENT_INTEGRATION.md) — no AbaPay account or human wallet interaction
--     required at all.
--
-- Both "Agent (relayer)" and "x402" are non-human-initiated by construction; "Direct
-- (wallet)" is not. Summing the first two against the total is the honest agent-share
-- number — see dune/base-chain/README.md's own "x402 is most of the money, not most of
-- the transactions" finding, which held on Base and is worth checking here too rather
-- than assumed to transfer.

SELECT
    block_date                      AS day,
    rail,
    COUNT(*)                        AS payments,
    SUM(amount_usd)                 AS volume_usd,
    COUNT(DISTINCT user_address)    AS unique_payers
FROM __ROOT_TABLE__
GROUP BY 1, 2
ORDER BY 1, 2
