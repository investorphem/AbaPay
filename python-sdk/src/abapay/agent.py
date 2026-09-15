"""AbaPayAgent — mirrors sdk/src/agent.ts. Links a wallet ONCE (a signature, not a deposit)
and then calls the fuller MCP tool catalog with an api_key + a PIN on every payment. See
https://agents.abapays.com/a2a for why this and x402.py have genuinely different trust models.
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
from typing import Any, Optional

from .types import AbaPayError, LinkParams
from .x402 import DEFAULT_BASE_URL

_PIN_RE = re.compile(r"^\d{4,6}$")


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
            raise AbaPayError("PIN must be 4-6 digits.")

        timestamp = str(int(time.time() * 1000))
        message = f"AbaPay Agent Action: POST:/api/agent/link: {timestamp}"
        signed = params.signer.sign_message(_personal_sign_message(message))
        signature = signed.signature.hex()
        if not signature.startswith("0x"):
            signature = "0x" + signature

        data = _http_json(
            f"{params.base_url.rstrip('/')}/api/agent/link",
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
                "x-wallet-timestamp": timestamp,
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
    ) -> str:
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
        return self.call_tool("pay_bill", args)

    def schedule_bill(self, **args: Any) -> str:
        return self.call_tool("schedule_bill", args)

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
