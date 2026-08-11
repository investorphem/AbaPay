-- ═══════════════════════════════════════════════════════════════════════════════
-- AbaPay — Base chain payments  (ROOT QUERY of the Base-only dashboard)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- One row per AbaPay bill payment on **Base mainnet only**. Every other query in this
-- dashboard reads this one via `query_<id>`, so this is the only query that ever
-- touches the raw chain tables — which is what keeps the other eight cheap and fast.
--
-- ⚡ TWO SETTLEMENT RAILS, BOTH COUNTED. A payment reaches the vault two different ways:
--
--   1. `payBill` / `payBillFor` on the contract  → emits PaymentReceived
--   2. **x402** (docs.cdp.coinbase.com/x402)     → a BARE ERC-20 transfer to the vault,
--      settled by the CDP facilitator. It never calls payBill, so it emits NO
--      PaymentReceived and is invisible to anything that only reads that event.
--
-- Reading only PaymentReceived silently drops every x402 payment. This query counts both.
--
-- ⚠️ NO AMOUNT FILTER, DELIBERATELY. This is an on-chain dashboard: it reports what the
-- chain actually recorded. Small values are legitimate — AbaPay prices in several national
-- currencies against a USD peg — and whether a payment was ultimately delivered, refunded
-- or failed is a question for the backend database, not for the chain. Do not add a
-- minimum-amount floor here to make the numbers look tidier; it would make this query
-- disagree with the ledger it is supposed to mirror.
--
-- WHY A SEPARATE DASHBOARD: the original AbaPay dashboard unions Celo and Base and
-- then splits by chain, so the Base numbers are always a slice of something else.
-- This one is scoped to Base at the source, so the Base team / Base grants reviewers
-- see Base activity without a chain filter and without Celo rows inflating the
-- denominators (user counts, DAU, new-vs-returning are all per-chain here).
--
-- TWO CONTRACTS, ON PURPOSE: AbaPay has been deployed to Base more than once. Both
-- deployments are tracked so history doesn't restart at the redeploy — `contract`
-- keeps them distinguishable, and 14_by_contract.sql charts the migration.
--
-- ⚠️ `accountNumber` (the meter / phone / bill account the user paid) IS DELIBERATELY
-- NOT DECODED. It is customer PII and this dashboard is public. It stays in the raw
-- log where it always was; it does not get lifted into a queryable column here.
--
-- Placeholders below are filled in by `scripts/dune-base-setup.mjs`; do not hand-edit
-- the deployed copy on dune.com — edit this file and re-run the script.
-- ═══════════════════════════════════════════════════════════════════════════════

WITH abapay_logs AS (
    SELECT
        block_time,
        block_date,
        block_number,
        tx_hash,
        index,
        contract_address,
        topic0,
        topic1,
        topic2,
        data
    FROM base.logs
    WHERE contract_address IN (__CONTRACT_LIST__)
      AND topic0 IN (
          0x8c69ba65ac630960f1d90c9a12eb143096fa71019450181b7fb5c299f03a6357, -- PaymentReceived(address,address,string,string,uint256)
          0x90619b8207d57f0cc87c98e7c2fdb86c6f12683d8a29412b02d558b3be68e6cd  -- AgentPayment(address,address,uint256,uint256)
      )
),

-- AgentPayment is emitted *in addition to* PaymentReceived in the same transaction
-- when the relayer spent a user's allowance, so its presence is what separates the
-- agent rail (Telegram / WhatsApp / X bot) from a wallet-signed payment.
agent_txs AS (
    SELECT DISTINCT tx_hash
    FROM abapay_logs
    WHERE topic0 = 0x90619b8207d57f0cc87c98e7c2fdb86c6f12683d8a29412b02d558b3be68e6cd
),

-- PaymentReceived non-indexed data is (string serviceType, string accountNumber,
-- uint256 amount). The two strings are dynamic, so the head holds their byte offsets
-- and only `amount` sits inline, at head word 2 → bytes 65..96 (1-based).
payment_raw AS (
    SELECT
        block_time,
        block_date,
        tx_hash,
        index AS log_index,
        contract_address,
        bytearray_substring(topic1, 13, 20) AS user_address,
        bytearray_substring(topic2, 13, 20) AS token_address,
        bytearray_to_uint256(bytearray_substring(data, 65, 32)) AS raw_amount,
        CAST(bytearray_to_uint256(bytearray_substring(data, 1, 32)) AS BIGINT) AS service_offset,
        data
    FROM abapay_logs
    WHERE topic0 = 0x8c69ba65ac630960f1d90c9a12eb143096fa71019450181b7fb5c299f03a6357
),

contract_payments AS (
    SELECT
        block_time,
        block_date,
        tx_hash,
        log_index,
        contract_address,
        user_address,
        token_address,
        raw_amount,
        -- At `service_offset` sits the string's length word, then its bytes.
        from_utf8(
            bytearray_substring(
                data,
                service_offset + 33,
                CAST(bytearray_to_uint256(bytearray_substring(data, service_offset + 1, 32)) AS BIGINT)
            )
        ) AS service_type
    FROM payment_raw
),

-- ─── Rail 2: x402 ──────────────────────────────────────────────────────────────
--
-- Every token transfer INTO a vault. This deliberately includes the transferFrom that
-- `payBill` itself performs, which is why the next CTE subtracts those out — matching on
-- tx_hash rather than trying to recognise x402 by shape.
vault_inflows AS (
    SELECT
        t.evt_block_time                AS block_time,
        CAST(t.evt_block_time AS DATE)  AS block_date,
        t.evt_tx_hash                   AS tx_hash,
        t.evt_index                     AS log_index,
        -- "from" and "to" are reserved words in Trino; they must stay quoted.
        t."to"                          AS contract_address,
        t."from"                        AS user_address,
        t.contract_address              AS token_address,
        t.value                         AS raw_amount
    FROM erc20_base.evt_Transfer t
    WHERE t."to" IN (__CONTRACT_LIST__)
      AND t.contract_address IN (
          0x833589fcd6edb6e08f4c7c32d4f71b54bda02913, -- USDC
          0xfde4c96c8593536e31f229ea8f37b2ada2699bb2  -- USDT
      )
),

-- A transaction that emitted PaymentReceived is already counted by rail 1; its inbound
-- transfer is the same money, so counting both would double every contract payment.
payment_tx_hashes AS (
    SELECT DISTINCT tx_hash FROM payment_raw
),

x402_payments AS (
    SELECT
        v.block_time,
        v.block_date,
        v.tx_hash,
        v.log_index,
        v.contract_address,
        v.user_address,
        v.token_address,
        v.raw_amount,
        -- x402 carries no serviceType on-chain — the item paid for lives in the off-chain
        -- payment requirements, not in any event. Naming it honestly beats guessing.
        'unknown (x402)' AS service_type
    FROM vault_inflows v
    WHERE v.tx_hash NOT IN (SELECT tx_hash FROM payment_tx_hashes)
),

payments AS (
    SELECT *, false AS is_x402 FROM contract_payments
    UNION ALL
    SELECT *, true  AS is_x402 FROM x402_payments
),

-- The only two tokens AbaPay accepts on Base. Both are 6-decimal and both are
-- dollar-pegged, so `amount_usd` is a straight scale, not a priced conversion —
-- no dependency on a price feed, and no NULLs on days a feed is missing.
tokens AS (
    SELECT * FROM (VALUES
        (0x833589fcd6edb6e08f4c7c32d4f71b54bda02913, 'USDC', 6),
        (0xfde4c96c8593536e31f229ea8f37b2ada2699bb2, 'USDT', 6)
    ) AS t (token_address, token_symbol, token_decimals)
)

SELECT
    p.block_time,
    p.block_date,
    p.tx_hash,
    p.log_index,
    p.contract_address,
    __CONTRACT_LABEL_CASE__ AS contract,
    p.user_address,
    COALESCE(t.token_symbol, 'UNKNOWN') AS token,
    p.token_address,
    CAST(p.raw_amount AS DOUBLE) / POWER(10, COALESCE(t.token_decimals, 6)) AS amount_usd,
    p.service_type,
    CASE
        WHEN p.is_x402            THEN 'x402'
        WHEN a.tx_hash IS NOT NULL THEN 'Agent (relayer)'
        ELSE 'Direct (wallet)'
    END AS rail
FROM payments p
LEFT JOIN tokens t ON t.token_address = p.token_address
LEFT JOIN agent_txs a ON a.tx_hash = p.tx_hash
ORDER BY p.block_time DESC
