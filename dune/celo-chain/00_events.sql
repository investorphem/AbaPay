-- ═══════════════════════════════════════════════════════════════════════════════
-- AbaPay — Celo chain payments  (ROOT QUERY of the Celo-only dashboard)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- One row per AbaPay bill payment on **Celo mainnet only**. This is the only query that
-- ever touches the raw chain tables; the other dependents read its **materialized view**
-- (`dune.abapay.result_abapay_celo_events`), which is what keeps them cheap and fast.
--
-- 🔴 THEY MUST NOT READ IT VIA `query_<id>`. That syntax is a view, not a cached
-- result: Dune re-executes this entire query inline for every dependent that uses it.
-- See dune/base-chain/README.md for the concrete cost story (~41 credits per run
-- instead of ~0.07) that made this the rule for every dashboard here, not just Base's.
--
-- ⚡ TWO SETTLEMENT RAILS, BOTH COUNTED. A payment reaches the vault two different ways:
--
--   1. `payBill` / `payBillFor` on the contract  → emits PaymentReceived
--   2. **x402** (docs.cdp.coinbase.com/x402)     → a BARE ERC-20 transfer to the vault,
--      settled by a facilitator. It never calls payBill, so it emits NO
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
-- then splits by chain, so the Celo numbers are always a slice of something else.
-- This one is scoped to Celo at the source, so Celo activity is visible without a
-- chain filter and without Base rows inflating the denominators (user counts, DAU,
-- new-vs-returning are all per-chain here) — mirrors dune/base-chain/00_events.sql,
-- built the same way for the same reason.
--
-- TWO CONTRACTS, ON PURPOSE: AbaPay is Celo-first — it launched here before Base —
-- and has been redeployed once already (V3 → V4, to pick up an owner-adjustable
-- withdrawal timelock; see README.md's AbaPayV4 section). Both deployments are
-- tracked so history doesn't restart at the redeploy — `contract` keeps them
-- distinguishable, and 14_by_contract.sql charts the migration.
--
-- ⚠️ `accountNumber` (the meter / phone / bill account the user paid) IS DELIBERATELY
-- NOT DECODED. It is customer PII and this dashboard is public. It stays in the raw
-- log where it always was; it does not get lifted into a queryable column here.
--
-- ⚠️ FOUR TOKENS, NOT TWO OR THREE. USD₮, USDC, USA₮ are what's currently OFFERED for
-- new payments (Base only ever offered USDC/USD₮) — see TOKEN_ORDER_BY_CHAIN.CELO in
-- src/constants/index.ts. But the contract-call rail (payBill/payBillFor) accepts
-- whatever ERC20 the contract has ever whitelisted, which STILL INCLUDES USDm — that
-- module keeps it around specifically because "the admin vault still holds, displays
-- and withdraws USDm, and historical transactions rows name it." USDm is 18-decimal,
-- not 6. Leaving it out of the `tokens` CTE below isn't a missing row, it's a WRONG
-- one: those payments still match (their token_address just fails to join), fall back
-- to 6 decimals via COALESCE, and inflate by ~10^12x. Caught live on this dashboard's
-- first deployment — a "token: UNKNOWN, volume_usd: 9.01e14" row was the tell. Worth
-- remembering if another legacy token surfaces the same way later: an UNKNOWN token
-- with an implausible amount means "decimals mismatch," not "harmless unclassified row."
--
-- ⚠️ THE DATE FLOOR IS TIGHTER THAN BASE'S, AND VERIFIED, NOT GUESSED. A probe query
-- against celo.logs for these two contract addresses (no date floor at all) timed out
-- at the free tier's 2-minute ceiling — Celo's chain history predates AbaPay by a lot
-- more than Base's does, so an unfloored scan is far more expensive here. Re-run with
-- `block_date >= '2026-01-01'` found the real first contract-call payment at
-- 2026-07-18 09:55:06 UTC (85 logs total as of 2026-09-11). 2026-07-01 is that verified
-- date minus ~17 days of buffer — not a guess, and not the '2026-04-01' Base uses,
-- which would still be correct but would cost more for no benefit. If this ever looks
-- like it's clipping real x402 history from before the contract-call rail existed,
-- re-verify with the same probe rather than assuming the floor is still right.
--
-- Placeholders below are filled in by `scripts/dune-celo-setup.mjs`; do not hand-edit
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
    FROM celo.logs
    WHERE contract_address IN (__CONTRACT_LIST__)
      AND topic0 IN (
          0x8c69ba65ac630960f1d90c9a12eb143096fa71019450181b7fb5c299f03a6357, -- PaymentReceived(address,address,string,string,uint256)
          0x90619b8207d57f0cc87c98e7c2fdb86c6f12683d8a29412b02d558b3be68e6cd  -- AgentPayment(address,address,uint256,uint256)
      )
      AND block_time >= TIMESTAMP '2026-07-01 00:00:00'
),

-- AgentPayment is emitted *in addition to* PaymentReceived in the same transaction
-- when the relayer spent a user's allowance, so its presence is what separates the
-- agent rail (Telegram / WhatsApp / X bot / MCP) from a wallet-signed payment.
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
    FROM erc20_celo.evt_transfer t
    WHERE t."to" IN (__CONTRACT_LIST__)
      AND t.contract_address IN (
          0xceba9300f2b948710d2653dd7b07f33a8b32118c, -- USDC (Celo)
          0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e, -- USD₮ (Celo)
          0xd2ab3c9a02dbbab236bfec45d1d755df4267f771, -- USA₮ (Celo)
          0x765de816845861e75a25fca122bb6898b8b1282a  -- USDm (Celo, legacy)
      )
      -- 🔴 WITHOUT THIS FLOOR THIS SCAN READS EVERY TRANSFER OF THESE THREE TOKENS ON
      -- CELO SINCE GENESIS before narrowing to the vault — the token contracts are used
      -- by the entire chain, not just AbaPay. See the header note above for how
      -- 2026-07-01 was verified rather than guessed.
      AND t.evt_block_time >= TIMESTAMP '2026-07-01 00:00:00'
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

-- Every token AbaPay has ever accepted on Celo. The three currently offered are
-- 6-decimal and dollar-pegged, so `amount_usd` is a straight scale for them, not a
-- priced conversion. USDm is 18-decimal — its own dollar peg is looser and older, but
-- it's included here purely so historical/legacy contract-call payments in it don't
-- fall through to the wrong decimals (see the header note above); it is NOT offered
-- for new payments (see TOKEN_ORDER_BY_CHAIN.CELO).
tokens AS (
    SELECT * FROM (VALUES
        (0xceba9300f2b948710d2653dd7b07f33a8b32118c, 'USDC', 6),
        (0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e, 'USD₮', 6),
        (0xd2ab3c9a02dbbab236bfec45d1d755df4267f771, 'USA₮', 6),
        (0x765de816845861e75a25fca122bb6898b8b1282a, 'USDm', 18)
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
