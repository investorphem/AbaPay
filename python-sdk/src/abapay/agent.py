"""AbaPayAgent — mirrors sdk/src/agent.ts. Links a wallet ONCE (a signature, not a deposit)
and then calls the fuller MCP tool catalog with an api_key + a PIN on every payment. See
https://agents.abapays.com/a2a for why this and x402.py have genuinely different trust models.
"""

from __future__ import annotations

import base64
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from eth_utils import to_checksum_address

from .types import AbaPayError, LinkParams
from .x402 import DEFAULT_BASE_URL

_PIN_RE = re.compile(r"^\d{6}$")

_LINK_STATEMENT = (
    "Link an AI agent or chat account to this wallet, protected by the PIN you chose. "
    "It does not move any money by itself."
)


def _iso(dt: datetime) -> str:
    """ISO-8601 UTC with milliseconds and a Z, the exact form viem/AbaPay's server writes."""
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def build_siwe_message(
    *,
    domain: str,
    uri: str,
    address: str,
    chain_id: int,
    nonce: str,
    issued_at: datetime,
    expiration_time: datetime,
    statement: str,
    resources: list,
) -> str:
    """An EIP-4361 (Sign-In with Ethereum) message, byte-for-byte what viem's createSiweMessage
    produces for the same fields, which is what AbaPay's server parses (src/lib/siwe.ts)."""
    lines = [
        f"{domain} wants you to sign in with your Ethereum account:",
        to_checksum_address(address),
        "",
        statement,
        "",
        f"URI: {uri}",
        "Version: 1",
        f"Chain ID: {chain_id}",
        f"Nonce: {nonce}",
        f"Issued At: {_iso(issued_at)}",
        f"Expiration Time: {_iso(expiration_time)}",
        "Resources:",
        *[f"- {r}" for r in resources],
    ]
    return "\n".join(lines)


def _http_json(url: str, method: str, body: Optional[dict] = None, headers: Optional[dict] = None) -> dict:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    all_headers = {"Content-Type": "application/json"}
    if headers:
        all_headers.update(headers)
    req = urllib.request.Request(url, data=data, headers=all_headers, method=method)
    try:
        with urllib.request.urlopen(req) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8")
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            raise AbaPayError(f"AbaPay returned a non-JSON response (HTTP {e.code}): {raw[:300]}")


class AbaPayAgent:
    """A linked AbaPay agent session — one api_key, reusable across as many tool calls as
    needed. Get one via `AbaPayAgent.link(...)`."""

    def __init__(self, api_key: str, wallet_address: str, base_url: str = DEFAULT_BASE_URL):
        self.api_key = api_key
        self.wallet_address = wallet_address
        self._base_url = base_url

    @staticmethod
    def link(params: LinkParams) -> "AbaPayAgent":
        """Prove ownership of a wallet with a plain signed message (no OAuth, no browser) and
        mint an Agent Hub api_key. This does NOT grant AbaPay any spending allowance by
        itself — that's a separate on-chain step (approve + setSpendingAllowance), left to the
        caller since it moves the caller's own funds.

        Raises AbaPayError if the signature is rejected or the PIN is malformed.
        """
        if not _PIN_RE.match(params.pin):
            raise AbaPayError("PIN must be 6 digits.")

        # Sign-In with Ethereum (EIP-4361): names AbaPay's domain, carries a single-use nonce from
        # /api/auth/nonce, and states what's being approved, so the signature can't be replayed
        # or reused on another site.
        root = params.base_url.rstrip("/")
        nonce_data = _http_json(f"{root}/api/auth/nonce?purpose=action", "GET")
        nonce = nonce_data.get("nonce")
        if not nonce:
            raise AbaPayError(nonce_data.get("message") or "Could not start wallet verification.", response=nonce_data)
        origin = urllib.parse.urlsplit(root)
        now = datetime.now(timezone.utc)
        message = build_siwe_message(
            domain=origin.netloc,
            uri=f"{origin.scheme}://{origin.netloc}",
            address=params.signer.address,
            chain_id=8453 if params.approved_chain == "BASE" else 42220,
            nonce=nonce,
            issued_at=now,
            expiration_time=now + timedelta(minutes=5),
            statement=_LINK_STATEMENT,
            resources=["abapay:action:POST:/api/agent/link"],
        )
        signed = params.signer.sign_message(_personal_sign_message(message))
        signature = signed.signature.hex()
        if not signature.startswith("0x"):
            signature = "0x" + signature

        data = _http_json(
            f"{root}/api/agent/link",
            "POST",
            body={
                "wallet_address": params.signer.address,
                "channel": "MCP",
                "pin": params.pin,
                "approved_chain": params.approved_chain,
                "approved_token": params.approved_token,
                "mcp_key_label": params.label,
            },
            headers={
                "x-wallet-address": params.signer.address,
                "x-wallet-signature": signature,
                # base64 because a header can't carry the message's newlines.
                "x-wallet-siwe": base64.b64encode(message.encode("utf-8")).decode("ascii"),
            },
        )
        if not data.get("success") or not data.get("api_key"):
            raise AbaPayError(data.get("message") or "Link failed.", response=data)
        return AbaPayAgent(data["api_key"], params.signer.address, params.base_url)

    @staticmethod
    def from_api_key(api_key: str, wallet_address: str, base_url: str = DEFAULT_BASE_URL) -> "AbaPayAgent":
        """Reattach to an api_key minted earlier — no new signature needed."""
        return AbaPayAgent(api_key, wallet_address, base_url)

    def call_tool(self, name: str, args: Optional[dict] = None) -> str:
        """Low-level: call any MCP tool by name. check_balance/pay_bill/etc below cover the
        common ones with typed args."""
        body = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": name, "arguments": {"api_key": self.api_key, **(args or {})}},
        }
        data = _http_json(f"{self._base_url.rstrip('/')}/api/mcp", "POST", body=body)
        if data.get("error"):
            raise AbaPayError(data["error"].get("message") or "MCP tool call failed.", response=data)
        content = (data.get("result") or {}).get("content") or []
        text = next((c.get("text") for c in content if c.get("type") == "text"), None)
        if text is None:
            raise AbaPayError("MCP tool returned no text content.", response=data)
        return text

    def check_balance(self, chain: str = "CELO") -> str:
        return self.call_tool("check_balance", {"chain": chain})

    def pay_bill(
        self,
        pin: str,
        service: str,
        provider: str,
        account_number: str,
        amount_ngn: float,
        chain: Optional[str] = None,
        token: Optional[str] = None,
        variation_code: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> str:
        """idempotency_key: a unique id for THIS payment (8-128 chars, e.g. str(uuid.uuid4())).
        Retrying with the same key returns the first result instead of paying twice."""
        args: dict[str, Any] = {
            "pin": pin,
            "service": service,
            "provider": provider,
            "account_number": account_number,
            "amount_ngn": amount_ngn,
        }
        if chain:
            args["chain"] = chain
        if token:
            args["token"] = token
        if variation_code:
            args["variation_code"] = variation_code
        if idempotency_key:
            args["idempotency_key"] = idempotency_key
        return self.call_tool("pay_bill", args)

    def schedule_bill(self, **args: Any) -> str:
        return self.call_tool("schedule_bill", args)

    def get_payment_status(self, reference: str) -> str:
        """One payment's status by tx hash or request id: delivered, still confirming, failed or refunded."""
        return self.call_tool("get_payment_status", {"reference": reference})

    def transaction_history(self, limit: Optional[int] = None, offset: Optional[int] = None) -> str:
        args: dict[str, Any] = {}
        if limit is not None:
            args["limit"] = limit
        if offset is not None:
            args["offset"] = offset
        return self.call_tool("transaction_history", args)


def _personal_sign_message(message: str):
    from eth_account.messages import encode_defunct

    return encode_defunct(text=message)
