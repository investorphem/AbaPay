-- AbaPay on Celo — volume & transactions by token (USD₮ / USDC / USA₮ / legacy USDm)
-- Reads the root query's materialized view; never touches celo.logs. See 00_events.sql.
--
-- Up to four rows here — the three currently-offered stablecoins (Celo also accepts
-- USA₮, which Base does not offer; see TOKEN_ORDER_BY_CHAIN.CELO in
-- src/constants/index.ts) plus USDm if any legacy contract-call payments in it exist
-- in the window this dashboard covers.

SELECT
    token,
    COUNT(*)                        AS payments,
    SUM(amount_usd)                 AS volume_usd,
    COUNT(DISTINCT user_address)    AS unique_payers,
    AVG(amount_usd)                 AS avg_payment_usd,
    100.0 * SUM(amount_usd) / NULLIF(SUM(SUM(amount_usd)) OVER (), 0) AS share_of_volume_pct
FROM __ROOT_TABLE__
GROUP BY 1
ORDER BY volume_usd DESC
