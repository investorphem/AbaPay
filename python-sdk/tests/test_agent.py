import base64
import json
from datetime import datetime, timezone

from eth_account import Account
from eth_account.messages import encode_defunct

from abapay.agent import AbaPayAgent, build_siwe_message
from abapay.types import AbaPayError, LinkParams

TEST_PRIVATE_KEY = "0x" + "22" * 32


def test_link_signs_and_returns_agent(httpserver):
    account = Account.from_key(TEST_PRIVATE_KEY)
    captured = {}

    def handler(request):
        from werkzeug.wrappers import Response

        captured["body"] = json.loads(request.data)
        captured["headers"] = dict(request.headers)
        return Response(json.dumps({"success": True, "api_key": "aba_mcp_test123"}), status=200, content_type="application/json")

    httpserver.expect_request("/api/auth/nonce", method="GET").respond_with_json({"success": True, "nonce": "n0nce12345abc"})
    httpserver.expect_request("/api/agent/link", method="POST").respond_with_handler(handler)

    agent = AbaPayAgent.link(LinkParams(signer=account, pin="123456", base_url=httpserver.url_for("")))

    assert agent.api_key == "aba_mcp_test123"
    assert agent.wallet_address == account.address
    assert captured["body"]["pin"] == "123456"
    assert captured["body"]["wallet_address"] == account.address

    # The header carries a SIWE message bound to the server's nonce and this action, and the
    # signature really does verify against exactly that message.
    message = base64.b64decode(captured["headers"]["X-Wallet-Siwe"]).decode("utf-8")
    assert "Nonce: n0nce12345abc" in message
    assert message.endswith("Resources:\n- abapay:action:POST:/api/agent/link")
    assert account.address in message
    recovered = Account.recover_message(encode_defunct(text=message), signature=captured["headers"]["X-Wallet-Signature"])
    assert recovered.lower() == account.address.lower()


def test_siwe_message_matches_viem_byte_for_byte():
    # Reference produced by viem's createSiweMessage (what the AbaPay app and server use) for
    # the same fields. Any drift here would make every Python-signed link fail to verify.
    expected = (
        "agents.abapays.com wants you to sign in with your Ethereum account:\n"
        "0x1563915e194D8CfBA1943570603F7606A3115508\n\n"
        "Link an AI agent or chat account to this wallet, protected by the PIN you chose. It does not move any money by itself.\n\n"
        "URI: https://agents.abapays.com\nVersion: 1\nChain ID: 42220\nNonce: n0nce12345abc\n"
        "Issued At: 2026-10-01T12:00:00.000Z\nExpiration Time: 2026-10-01T12:05:00.000Z\n"
        "Resources:\n- abapay:action:POST:/api/agent/link"
    )
    built = build_siwe_message(
        domain="agents.abapays.com",
        uri="https://agents.abapays.com",
        address="0x1563915e194d8cfba1943570603f7606a3115508",
        chain_id=42220,
        nonce="n0nce12345abc",
        issued_at=datetime(2026, 10, 1, 12, 0, 0, tzinfo=timezone.utc),
        expiration_time=datetime(2026, 10, 1, 12, 5, 0, tzinfo=timezone.utc),
        statement="Link an AI agent or chat account to this wallet, protected by the PIN you chose. It does not move any money by itself.",
        resources=["abapay:action:POST:/api/agent/link"],
    )
    assert built == expected


def test_link_rejects_malformed_pin():
    account = Account.from_key(TEST_PRIVATE_KEY)
    # "1234" was valid before; an MCP key now needs exactly 6 digits.
    for bad in ("12", "1234"):
        try:
            AbaPayAgent.link(LinkParams(signer=account, pin=bad))
            assert False, "expected AbaPayError"
        except AbaPayError as e:
            assert "6 digits" in e.message


def test_call_tool_round_trips(httpserver):
    def handler(request):
        from werkzeug.wrappers import Response

        body = json.loads(request.data)
        assert body["method"] == "tools/call"
        assert body["params"]["name"] == "check_balance"
        assert body["params"]["arguments"]["api_key"] == "aba_mcp_test123"
        return Response(
            json.dumps({"jsonrpc": "2.0", "id": 1, "result": {"content": [{"type": "text", "text": "USDT 1.88"}]}}),
            status=200,
            content_type="application/json",
        )

    httpserver.expect_request("/api/mcp", method="POST").respond_with_handler(handler)

    agent = AbaPayAgent.from_api_key("aba_mcp_test123", "0xabc", base_url=httpserver.url_for(""))
    text = agent.check_balance("CELO")
    assert text == "USDT 1.88"


def test_pay_bill_forwards_idempotency_key_and_status_sends_reference(httpserver):
    seen = []

    def handler(request):
        from werkzeug.wrappers import Response

        seen.append(json.loads(request.data)["params"])
        return Response(
            json.dumps({"jsonrpc": "2.0", "id": 1, "result": {"content": [{"type": "text", "text": "ok"}]}}),
            status=200,
            content_type="application/json",
        )

    httpserver.expect_request("/api/mcp", method="POST").respond_with_handler(handler)

    agent = AbaPayAgent.from_api_key("aba_mcp_test123", "0xabc", base_url=httpserver.url_for(""))
    agent.pay_bill(pin="123456", service="AIRTIME", provider="mtn", account_number="080", amount_ngn=100, idempotency_key="order-0001")
    agent.get_payment_status("0xabc")

    assert seen[0]["arguments"]["idempotency_key"] == "order-0001"
    assert seen[1]["name"] == "get_payment_status"
    assert seen[1]["arguments"]["reference"] == "0xabc"


def test_call_tool_raises_on_jsonrpc_error(httpserver):
    httpserver.expect_request("/api/mcp", method="POST").respond_with_json(
        {"jsonrpc": "2.0", "id": 1, "error": {"message": "Invalid or revoked API key."}}
    )

    agent = AbaPayAgent.from_api_key("aba_mcp_bad", "0xabc", base_url=httpserver.url_for(""))
    try:
        agent.check_balance()
        assert False, "expected AbaPayError"
    except AbaPayError as e:
        assert "Invalid or revoked" in e.message
