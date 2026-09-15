"""Shared types for the abapay Python SDK — mirrors sdk/src/types.ts field-for-field so the
two SDKs can never silently drift on wire shape."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional


class AbaPayError(Exception):
    """Raised for any AbaPay-side failure — a bad request, a rejected signature, or a
    settlement AbaPay itself reports as unsuccessful. Mirrors sdk/src/types.ts's AbaPayError."""

    def __init__(self, message: str, cause: Optional[Exception] = None, response: Any = None):
        super().__init__(message)
        self.message = message
        self.cause = cause
        self.response = response


@dataclass
class BillDetails:
    """The same fields public/openapi.json's /api/pay/x402 requestBody documents.
    Celo mainnet only — see the SDK's file-level comments in x402.py for why."""

    serviceID: str
    serviceCategory: str  # AIRTIME | DATA | ELECTRICITY | CABLE | EDUCATION | BANK
    network: str
    billersCode: str
    nairaAmount: float
    token: str  # "USDC" or "USDT"
    wallet_address: Optional[str] = None

    def to_dict(self) -> dict:
        d = {
            "serviceID": self.serviceID,
            "serviceCategory": self.serviceCategory,
            "network": self.network,
            "billersCode": self.billersCode,
            "nairaAmount": self.nairaAmount,
            "token": self.token,
        }
        if self.wallet_address:
            d["wallet_address"] = self.wallet_address
        return d


@dataclass
class X402PayResult:
    success: bool
    status: str  # "SUCCESS" | "FAILED_VENDING" | "TIMEOUT" | "SYSTEM_CRASH" | str
    purchased_code: Optional[str] = None
    units: Optional[str] = None
    request_id: Optional[str] = None
    tx_hash: Optional[str] = None
    message: Optional[str] = None

    @staticmethod
    def from_dict(d: dict) -> "X402PayResult":
        return X402PayResult(
            success=bool(d.get("success", False)),
            status=str(d.get("status", "")),
            purchased_code=d.get("purchased_code"),
            units=d.get("units"),
            request_id=d.get("request_id"),
            tx_hash=d.get("tx_hash"),
            message=d.get("message"),
        )


@dataclass
class LinkParams:
    """Params for AbaPayAgent.link(). `signer` is any eth_account LocalAccount."""

    signer: Any
    pin: str
    approved_chain: str = "CELO"
    approved_token: Optional[str] = None
    label: str = "abapay-sdk-py"
    base_url: str = field(default="https://www.abapays.com")
