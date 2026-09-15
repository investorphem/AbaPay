"""Correctness, not just "it runs": asserts the signed typed-data this SDK produces recovers
to the signer's own address — the same guarantee sdk/test/x402.test.ts makes for the
TypeScript SDK ("a test asserts the signed typed-data's domain and message match a real 402
challenge byte-for-byte"). Runs against a real local HTTP server (pytest-httpserver), not a
patched urlopen, so the request/response shapes on the wire are exercised for real.
"""

import json

from eth_account import Account
from eth_account.messages import encode_typed_data

from abapay.types import BillDetails
from abapay.x402 import TRANSFER_WITH_AUTHORIZATION_TYPES, pay_bill_via_x402

TEST_PRIVATE_KEY = "0x" + "11" * 32  # deterministic, test-only — never a real funded key
VAULT = "0x5df8aE2B963165b735B18Ca86B1ea448d2AA032C"
USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e"

CHALLENGE = {
    "x402Version": 1,
    "error": "Payment required",
    "accepts": [
        {
            "scheme": "exact",
            "network": "eip155:42220",
            "amount": "1492500",
            "maxAmountRequired": "1492500",
            "payTo": VAULT,
            "asset": USDT,
            "maxTimeoutSeconds": 86400,
            "extra": {"name": "Tether USD", "version": "1", "primaryType": "TransferWithAuthorization"},
        }
    ],
}


def test_signature_recovers_to_signer_address(httpserver):
    account = Account.from_key(TEST_PRIVATE_KEY)

    captured = {}

    def handler(request):
        from werkzeug.wrappers import Response

        payment_header = request.headers.get("X-PAYMENT")
        if payment_header is None:
            return Response(json.dumps(CHALLENGE), status=402, content_type="application/json")

        captured["payment_header"] = payment_header
        return Response(
            json.dumps({"success": True, "status": "SUCCESS", "tx_hash": "0xdeadbeef", "request_id": "req_test"}),
            status=200,
            content_type="application/json",
        )

    httpserver.expect_request("/api/pay/x402", method="POST").respond_with_handler(handler)

    bill = BillDetails(
        serviceID="mtn",
        serviceCategory="AIRTIME",
        network="MTN",
        billersCode="08012345678",
        nairaAmount=1000,
        token="USDT",
    )
    result = pay_bill_via_x402(account, bill, base_url=httpserver.url_for(""))

    assert result.success is True
    assert result.status == "SUCCESS"
    assert result.tx_hash == "0xdeadbeef"
    assert "payment_header" in captured

    # ── The actual correctness check: recover the signer from the signed typed data and
    # confirm it's the account that supposedly signed it — exactly the check AbaPay's own
    # server-side verification (src/lib/x402Settle.ts) performs to accept or reject a payment.
    import base64

    decoded = json.loads(base64.b64decode(captured["payment_header"]))
    auth = decoded["payload"]["authorization"]
    signature = decoded["payload"]["signature"]

    domain = {
        "name": "Tether USD",
        "version": "1",
        "chainId": 42220,
        "verifyingContract": USDT,
    }
    message = {
        "from": auth["from"],
        "to": auth["to"],
        "value": int(auth["value"]),
        "validAfter": int(auth["validAfter"]),
        "validBefore": int(auth["validBefore"]),
        "nonce": auth["nonce"],
    }
    signable = encode_typed_data(domain_data=domain, message_types=TRANSFER_WITH_AUTHORIZATION_TYPES, message_data=message)
    recovered = Account.recover_message(signable, signature=signature)

    assert recovered.lower() == account.address.lower()
    assert auth["from"].lower() == account.address.lower()
    assert auth["to"].lower() == VAULT.lower()
    assert auth["value"] == "1492500"


def test_non_402_first_response_raises(httpserver):
    from abapay.types import AbaPayError

    httpserver.expect_request("/api/pay/x402", method="POST").respond_with_json({"error": "bad request"}, status=400)

    account = Account.from_key(TEST_PRIVATE_KEY)
    bill = BillDetails(serviceID="mtn", serviceCategory="AIRTIME", network="MTN", billersCode="08012345678", nairaAmount=1000, token="USDT")

    try:
        pay_bill_via_x402(account, bill, base_url=httpserver.url_for(""))
        assert False, "expected AbaPayError"
    except AbaPayError as e:
        assert "402" in e.message


def test_unsupported_network_raises():
    from abapay.types import AbaPayError
    from abapay.x402 import _caip2_chain_id

    try:
        _caip2_chain_id("solana:mainnet")
        assert False, "expected AbaPayError"
    except AbaPayError as e:
        assert "eip155" in e.message
