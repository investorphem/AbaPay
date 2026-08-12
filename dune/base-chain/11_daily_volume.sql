-- AbaPay on Base — daily volume & transaction count
-- Reads the root query's materialized view; never touches base.logs. See 00_events.sql.

SELECT
    block_date                                              AS day,
    COUNT(*)                                                AS payments,
    SUM(amount_usd)                                         AS volume_usd,
    COUNT(DISTINCT user_address)                            AS payers,
    AVG(amount_usd)                                         AS avg_payment_usd,
    -- Running total so the dashboard can show a cumulative-volume line without a
    -- second query over the same rows.
    SUM(SUM(amount_usd)) OVER (ORDER BY block_date)         AS cumulative_volume_usd
FROM __ROOT_TABLE__
GROUP BY 1
ORDER BY 1
