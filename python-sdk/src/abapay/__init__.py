"""abapay — pay real-world bills from a Celo wallet, no browser required.

Mirrors abapay-sdk (npm) field-for-field. Two ways in:

- `pay_bill_via_x402` — zero setup. No account, no API key, no PIN.
- `AbaPayAgent` — a linked-wallet client for the fuller MCP tool catalog.

See https://agents.abapays.com/sdk and https://agents.abapays.com/tools.
"""

from .agent import AbaPayAgent
from .types import AbaPayError, BillDetails, LinkParams, X402PayResult
from .x402 import DEFAULT_BASE_URL, pay_bill_via_x402

__all__ = [
    "AbaPayAgent",
    "AbaPayError",
    "BillDetails",
    "LinkParams",
    "X402PayResult",
    "DEFAULT_BASE_URL",
    "pay_bill_via_x402",
]

__version__ = "0.1.0"
