#!/usr/bin/env python3
"""abapay-cli (Python) — pay real-world bills from a Celo wallet, no browser required.
Mirrors sdk/src/cli.ts's abapay command-for-command; see that file's own header comment for
why this exists as a thin argparse wrapper over the library, not a second implementation.
"""

from __future__ import annotations

import argparse
import os
import sys

from .agent import AbaPayAgent
from .types import AbaPayError, BillDetails, LinkParams
from .x402 import pay_bill_via_x402


def _fail(message: str) -> None:
    print(f"abapay: {message}", file=sys.stderr)
    sys.exit(1)


def _require_private_key() -> str:
    pk = os.environ.get("PRIVATE_KEY")
    if not pk:
        _fail("PRIVATE_KEY env var is required (a 0x-prefixed hex private key).")
    return pk  # type: ignore[return-value]


def _account(pk: str):
    from eth_account import Account

    return Account.from_key(pk)


def cmd_pay(args: argparse.Namespace) -> None:
    account = _account(_require_private_key())
    print(f"Paying as {account.address} — {args.service} {args.amount} NGN to {args.to}…")
    bill = BillDetails(
        serviceID=(args.provider or args.service).lower(),
        serviceCategory=args.service,
        network=args.network or (args.provider.upper() if args.provider else args.service),
        billersCode=args.to,
        nairaAmount=float(args.amount),
        token=args.token,
    )
    try:
        result = pay_bill_via_x402(account, bill)
        print(f"✓ {result.status} — tx: {result.tx_hash or '(pending)'}")
    except AbaPayError as e:
        _fail(f"{e.message}" + (f"\n{e.response}" if e.response else ""))


def cmd_link(args: argparse.Namespace) -> None:
    account = _account(_require_private_key())
    print(f"Linking {account.address}…")
    try:
        agent = AbaPayAgent.link(
            LinkParams(signer=account, pin=args.pin, approved_chain=args.chain, approved_token=args.token, label=args.label or "abapay-cli-py")
        )
        print(f"✓ Linked. api_key: {agent.api_key}")
        print("  This does NOT grant a spending allowance by itself — see agents.abapays.com/agents/developers/quickstart.")
    except AbaPayError as e:
        _fail(e.message)


def cmd_balance(args: argparse.Namespace) -> None:
    agent = AbaPayAgent.from_api_key(args.api_key, args.wallet or "")
    try:
        print(agent.check_balance(args.chain))
    except AbaPayError as e:
        _fail(e.message)


def cmd_history(args: argparse.Namespace) -> None:
    agent = AbaPayAgent.from_api_key(args.api_key, args.wallet or "")
    try:
        print(agent.transaction_history(limit=args.limit, offset=args.offset))
    except AbaPayError as e:
        _fail(e.message)


def main() -> None:
    parser = argparse.ArgumentParser(prog="abapay", description="Pay real-world bills from a Celo wallet.")
    sub = parser.add_subparsers(dest="command")

    p_pay = sub.add_parser("pay", help="Pay a bill via x402 — zero setup.")
    p_pay.add_argument("--service", required=True)
    p_pay.add_argument("--provider")
    p_pay.add_argument("--to", required=True)
    p_pay.add_argument("--amount", required=True)
    p_pay.add_argument("--token", default="USDT")
    p_pay.add_argument("--network")
    p_pay.set_defaults(func=cmd_pay)

    p_link = sub.add_parser("link", help="Link a wallet, mint an api_key.")
    p_link.add_argument("--pin", required=True)
    p_link.add_argument("--chain", default="CELO")
    p_link.add_argument("--token")
    p_link.add_argument("--label")
    p_link.set_defaults(func=cmd_link)

    p_bal = sub.add_parser("balance", help="Check a linked wallet's balance.")
    p_bal.add_argument("--api-key", required=True)
    p_bal.add_argument("--wallet")
    p_bal.add_argument("--chain", default="CELO")
    p_bal.set_defaults(func=cmd_balance)

    p_hist = sub.add_parser("history", help="Recent transactions for a linked wallet.")
    p_hist.add_argument("--api-key", required=True)
    p_hist.add_argument("--wallet")
    p_hist.add_argument("--limit", type=int)
    p_hist.add_argument("--offset", type=int)
    p_hist.set_defaults(func=cmd_history)

    args = parser.parse_args()
    if not getattr(args, "command", None):
        parser.print_help()
        return
    args.func(args)


if __name__ == "__main__":
    main()
