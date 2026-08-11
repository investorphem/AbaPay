-- AbaPay on Base — KPI summary (all-time)
-- Reads the root query; never touches base.logs. See 00_events.sql.

SELECT
    COUNT(*)                             AS payments,
    COUNT(DISTINCT user_address)         AS unique_payers,
    SUM(amount_usd)                      AS volume_usd,
    AVG(amount_usd)                      AS avg_payment_usd,
    APPROX_PERCENTILE(amount_usd, 0.5)   AS median_payment_usd,
    MAX(amount_usd)                      AS largest_payment_usd,
    COUNT(DISTINCT service_type)         AS services_used,
    MIN(block_date)                      AS first_payment_date,
    MAX(block_date)                      AS latest_payment_date,
    COUNT(DISTINCT block_date)           AS active_days
FROM query___ROOT_QUERY_ID__
