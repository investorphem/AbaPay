-- AbaPay — Agent Page Live Stats (Celo + Base combined)
-- Live on Dune as query 8690659: https://dune.com/queries/8690659
--
-- Feeds the four hero numbers on agents.abapays.com (src/app/agents/page.tsx), via
-- src/lib/dune/agentStats.ts, which reads this query's cached results through the Dune API
-- (GET /query/8690659/results — read-only, no execution, so the page never spends credits).
--
-- UNIONs the Base and Celo ROOT events queries directly (query_8284395, query_8683489 — see
-- dune/base-chain/00_events.sql and dune/celo-chain/00_events.sql) rather than re-deriving the
-- rail classification here: both root queries already compute `amount_usd` and `rail`
-- identically, so this only re-reads what they already did.
--
-- Kept OUT of src/app/api/cron/dune-refresh's shared `main`/`base`/`celo` PERFORMANCE tier
-- deliberately — see the "agents-stats" branch in that route for why this needs its own
-- execution path instead of joining the other dashboards' daily loop.

WITH combined AS (
    SELECT * FROM query_8284395
    UNION ALL
    SELECT * FROM query_8683489
)
SELECT
    SUM(amount_usd)                                                                      AS volume_usd,
    100.0 * SUM(CASE WHEN rail IN ('Agent (relayer)', 'x402') THEN amount_usd ELSE 0 END)
        / NULLIF(SUM(amount_usd), 0)                                                     AS agent_native_pct,
    COUNT(DISTINCT user_address)                                                          AS unique_wallets,
    COUNT(*)                                                                              AS transactions
FROM combined
