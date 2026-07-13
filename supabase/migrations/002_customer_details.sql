-- ============================================================
-- AbaPay — customer details on receipts
-- Run this once in the Supabase SQL editor.
-- ============================================================
--
-- VTpass's merchant-verify endpoint returns the registered Customer_Name and Address for
-- electricity meters (and the account name for bank transfers). The frontend already
-- fetched and displayed these during verification, but they were never persisted — so the
-- receipt email couldn't show them.
--
-- These columns let the receipt include the customer's name and service address, which is
-- what people expect on a utility bill receipt.
--
-- Safe to run on an existing table: both columns are nullable, so historical rows and
-- non-electricity services (airtime, data) simply leave them NULL, and the receipt template
-- omits the rows when they're absent.

alter table public.transactions
  add column if not exists customer_name text,
  add column if not exists customer_address text;
