-- AbaPay on Base — what people actually paid for (airtime, data, electricity, TV, …)
-- Reads the root query's materialized view; never touches base.logs. See 00_events.sql.
--
-- `service_type` is the string the contract recorded at payment time, so this is the
-- on-chain record of demand rather than anything the backend could restate later.

SELECT
    service_type,
    COUNT(*)                        AS payments,
    SUM(amount_usd)                 AS volume_usd,
    COUNT(DISTINCT user_address)    AS unique_payers,
    AVG(amount_usd)                 AS avg_payment_usd,
    MIN(block_date)                 AS first_seen,
    MAX(block_date)                 AS last_seen,
    100.0 * SUM(amount_usd) / NULLIF(SUM(SUM(amount_usd)) OVER (), 0) AS share_of_volume_pct
FROM __ROOT_TABLE__
GROUP BY 1
ORDER BY volume_usd DESC
