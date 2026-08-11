-- AbaPay on Base — new vs returning payers, daily
-- Reads the root query; never touches base.logs. See 00_events.sql.
--
-- "New" is first-ever payment ON BASE. A wallet that has paid on Celo before but is
-- paying on Base for the first time counts as new here, which is the right reading
-- for a Base-scoped dashboard.

WITH activity AS (
    SELECT DISTINCT block_date AS day, user_address
    FROM query___ROOT_QUERY_ID__
),

first_seen AS (
    SELECT user_address, MIN(day) AS first_day
    FROM activity
    GROUP BY 1
)

SELECT
    a.day,
    COUNT(DISTINCT CASE WHEN f.first_day = a.day THEN a.user_address END) AS new_payers,
    COUNT(DISTINCT CASE WHEN f.first_day < a.day THEN a.user_address END) AS returning_payers,
    COUNT(DISTINCT a.user_address)                                        AS total_payers,
    100.0 * COUNT(DISTINCT CASE WHEN f.first_day < a.day THEN a.user_address END)
          / NULLIF(COUNT(DISTINCT a.user_address), 0)                     AS returning_share_pct
FROM activity a
JOIN first_seen f ON f.user_address = a.user_address
GROUP BY 1
ORDER BY 1
