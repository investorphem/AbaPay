-- AbaPay on Base — volume & transactions by token (USDC vs USDT)
-- Reads the root query's materialized view; never touches base.logs. See 00_events.sql.

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
