"""Zero-setup x402 payments — mirrors sdk/src/x402.ts's payBillViaX402 field-for-field. The
agent's own wallet signs an EIP-3009 transferWithAuthorization for exactly the amount AbaPay's
server names in its 402 challenge; nothing here ever touches abapays.com, an Agent Hub
account, or a PIN. Celo mainnet only in this version.

Verify this against the real wire format any time: https://agents.abapays.com/x402
"""

from __future__ import annotations

import base64
import json
import os
import time
import urllib.error
import urllib.request
from typing import Any, Optional

from eth_account.messages import encode_typed_data

from .types import AbaPayError, BillDetails, X402PayResult

DEFAULT_BASE_URL = "https://www.abapays.com"

# ⚡ MUST MATCH src/lib/x402Settle.ts's TRANSFER_WITH_AUTHORIZATION_TYPES BYTE-FOR-BYTE (and
# sdk/src/x402.ts's copy of the same) — that's the code that reconstructs this signature
# server-side to verify it. Three independent copies now (TypeScript app, TypeScript SDK,
# this one) because none of them can depend on each other across language/publish boundaries;
# a drift in any one is a signature that silently fails to verify. Each carries this exact
# comment as the tripwire.
TRANSFER_WITH_AUTHORIZATION_TYPES = {
    "TransferWithAuthorization": [
        {"name": "from", "type": "address"},
        {"name": "to", "type": "address"},
        {"name": "value", "type": "uint256"},
        {"name": "validAfter", "type": "uint256"},
        {"name": "validBefore", "type": "uint256"},
        {"name": "nonce", "type": "bytes32"},
    ],
}


def _random_nonce() -> str:
    return "0x" + os.urandom(32).hex()


def _caip2_chain_id(network: str) -> int:
    parts = network.split(":")
    if len(parts) != 2 or parts[0] != "eip155":
        raise AbaPayError(
            f'Unsupported x402 network "{network}" — this SDK version only understands '
            "eip155:* (EVM) networks, and only Celo (eip155:42220) is currently offered by AbaPay."
        )
    try:
        return int(parts[1])
    except ValueError:
        raise AbaPayError(f'Unsupported x402 network "{network}" — non-numeric chain id.')


def _post_json(url: str, body: dict, extra_headers: Optional[dict] = None) -> tuple[int, dict]:
    headers = {"Content-Type": "application/json"}
    if extra_headers:
        headers.update(extra_headers)
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req) as res:
            raw = res.read().decode("utf-8")
            return res.status, json.loads(raw)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8")
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            raise AbaPayError(f"AbaPay returned a non-JSON response (HTTP {e.code}): {raw[:300]}")


def pay_bill_via_x402(
    signer: Any,
    bill: BillDetails,
    base_url: str = DEFAULT_BASE_URL,
) -> X402PayResult:
    """Pay a real-world bill (airtime, data, electricity, cable) via x402 — zero setup.

    `signer` is any eth_account LocalAccount (e.g. from
    `eth_account.Account.from_key(private_key)`). Its private key never leaves this process —
    only `sign_message`/typed-data signing is used, matching the SDK's own no-custody design.

    Raises AbaPayError on any HTTP failure, a challenge this version can't act on, or a final
    response AbaPay itself reports as unsuccessful.
    """
    if bill.wallet_address is None:
        bill = BillDetails(**{**bill.__dict__, "wallet_address": signer.address})
    endpoint = f"{base_url.rstrip('/')}/api/pay/x402"

    # ── 1. Ask for a price. No X-PAYMENT header yet — this MUST come back 402. ──────────────
    status, challenge = _post_json(endpoint, bill.to_dict())
    if status != 402:
        raise AbaPayError(f"Expected HTTP 402 (payment required), got {status}.", response=challenge)

    accepts = challenge.get("accepts") or []
    accept = next((a for a in accepts if a.get("scheme") == "exact"), None)
    if accept is None:
        raise AbaPayError("402 challenge carried no usable 'exact' payment option.", response=challenge)

    # ── 2. Sign the exact amount the challenge named, with the wallet's OWN key. ─────────────
    chain_id = _caip2_chain_id(accept["network"])
    now = int(time.time())
    authorization = {
        "from": signer.address,
        "to": accept["payTo"],
        "value": int(accept["amount"]),
        # 60s of slack behind "now" absorbs ordinary clock skew.
        "validAfter": now - 60,
        "validBefore": now + int(accept.get("maxTimeoutSeconds") or 3600),
        "nonce": _random_nonce(),
    }

    domain = {
        "name": accept["extra"]["name"],
        "version": accept["extra"]["version"],
        "chainId": chain_id,
        "verifyingContract": accept["asset"],
    }
    signable = encode_typed_data(
        domain_data=domain,
        message_types=TRANSFER_WITH_AUTHORIZATION_TYPES,
        message_data=authorization,
    )
    signed = signer.sign_message(signable)
    signature = signed.signature.hex()
    if not signature.startswith("0x"):
        signature = "0x" + signature

    # ── 3. Retry with the signed authorization attached. ─────────────────────────────────────
    payment_header = base64.b64encode(
        json.dumps(
            {
                "x402Version": 1,
                "scheme": "exact",
                "network": "celo",
                "payload": {
                    "signature": signature,
                    "authorization": {
                        **authorization,
                        "value": str(authorization["value"]),
                        "validAfter": str(authorization["validAfter"]),
                        "validBefore": str(authorization["validBefore"]),
                    },
                },
            }
        ).encode("utf-8")
    ).decode("ascii")

    settle_status, result = _post_json(endpoint, bill.to_dict(), {"X-PAYMENT": payment_header})
    parsed = X402PayResult.from_dict(result)
    if settle_status >= 300 or parsed.success is False:
        raise AbaPayError(parsed.message or f"Settlement failed (HTTP {settle_status}).", response=result)
    return parsed
