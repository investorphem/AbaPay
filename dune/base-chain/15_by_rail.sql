-- AbaPay on Base — agent rail vs direct wallet payments, daily
-- Reads the root query; never touches base.logs. See 00_events.sql.
--
-- "Agent (relayer)" means the transaction also carried an AgentPayment event, i.e.
-- the relayer spent a spending allowance the user had granted — a payment made from
-- Telegram / WhatsApp / X without the user opening a wallet. Everything else was
-- signed by the user's own wallet.

SELECT
    block_date                      AS day,
    rail,
    COUNT(*)                        AS payments,
    SUM(amount_usd)                 AS volume_usd,
    COUNT(DISTINCT user_address)    AS unique_payers
FROM query___ROOT_QUERY_ID__
GROUP BY 1, 2
ORDER BY 1, 2
