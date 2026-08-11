-- AbaPay on Base — activity split across the two deployed contracts
-- Reads the root query; never touches base.logs. See 00_events.sql.
--
-- This is the query that justifies tracking both addresses instead of only the
-- current one: without it a redeploy looks like the product died and a new one
-- appeared. Here the old contract's history stays attached to the same dashboard,
-- and the daily series shows traffic moving from one to the other.

WITH totals AS (
    SELECT
        contract,
        contract_address,
        COUNT(*)                        AS payments,
        SUM(amount_usd)                 AS volume_usd,
        COUNT(DISTINCT user_address)    AS unique_payers,
        MIN(block_date)                 AS first_activity,
        MAX(block_date)                 AS last_activity
    FROM query___ROOT_QUERY_ID__
    GROUP BY 1, 2
)

SELECT
    contract,
    contract_address,
    payments,
    volume_usd,
    unique_payers,
    first_activity,
    last_activity,
    DATE_DIFF('day', last_activity, CURRENT_DATE) AS days_since_last_activity,
    100.0 * volume_usd / NULLIF(SUM(volume_usd) OVER (), 0) AS share_of_volume_pct
FROM totals
ORDER BY volume_usd DESC
