-- AbaPay on Base — DAU / WAU / MAU
-- Reads the root query's materialized view; never touches base.logs. See 00_events.sql.
--
-- Because this dashboard is Base-scoped at the source, a wallet that pays on Celo
-- does NOT inflate these counts — which is exactly why the Base numbers are worth
-- reading separately from the combined dashboard.

WITH activity AS (
    SELECT DISTINCT block_date AS day, user_address
    FROM __ROOT_TABLE__
),

days AS (
    SELECT DISTINCT day FROM activity
)

SELECT
    d.day,
    COUNT(DISTINCT CASE WHEN a.day = d.day THEN a.user_address END)                                  AS dau,
    COUNT(DISTINCT CASE WHEN a.day > DATE_ADD('day', -7,  d.day) THEN a.user_address END)            AS wau,
    COUNT(DISTINCT a.user_address)                                                                   AS mau
FROM days d
-- 30-day trailing join window: wide enough for MAU, bounded so this stays cheap.
JOIN activity a
  ON a.day <= d.day
 AND a.day > DATE_ADD('day', -30, d.day)
GROUP BY 1
ORDER BY 1
