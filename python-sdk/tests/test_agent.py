import json

from eth_account import Account
from eth_account.messages import encode_defunct

from abapay.agent import AbaPayAgent
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

    httpserver.expect_request("/api/agent/link", method="POST").respond_with_handler(handler)

    agent = AbaPayAgent.link(LinkParams(signer=account, pin="1234", base_url=httpserver.url_for("")))

    assert agent.api_key == "aba_mcp_test123"
    assert agent.wallet_address == account.address
    assert captured["body"]["pin"] == "1234"
    assert captured["body"]["wallet_address"] == account.address

    # The signature really does verify against the message it claims to sign.
    timestamp = captured["headers"]["X-Wallet-Timestamp"]
    message = encode_defunct(text=f"AbaPay Agent Action: POST:/api/agent/link: {timestamp}")
    recovered = Account.recover_message(message, signature=captured["headers"]["X-Wallet-Signature"])
    assert recovered.lower() == account.address.lower()


def test_link_rejects_malformed_pin():
    account = Account.from_key(TEST_PRIVATE_KEY)
    try:
        AbaPayAgent.link(LinkParams(signer=account, pin="12"))
        assert False, "expected AbaPayError"
    except AbaPayError as e:
        assert "4-6 digits" in e.message


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
