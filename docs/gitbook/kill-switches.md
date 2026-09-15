# Kill switches

All of them stop the agent, not just the UI — enforced by the same code path (or the
contract itself) regardless of which channel or credential is calling in, MCP and A2A
included.

- **Per-channel pause** — an operator can pause just the MCP surface without touching
  Telegram/WhatsApp/X.
- **Global pause** — the contract itself can be paused; payments revert while paused, but
  refunds deliberately stay callable so anyone already charged can still be made whole.
- **Relayer kill switch** — instantly disables the agent-initiated payment path
  system-wide, on-chain, independent of anything the backend does. A compromised backend
  cannot re-enable itself.
- **Per-credential rate limiting** — every money-moving call is rate-limited per API key,
  on top of the PIN requirement.
- **PIN lockout** — escalating lockout on repeated failed PIN attempts.

The two contract-level switches, verbatim:

{% code title="contracts/AbaPayV4.sol — kill switches" %}
```solidity
/// Instantly disables the agent-initiated path system-wide, on-chain --
/// independent of anything the backend does. A compromised backend
/// cannot re-enable itself.
function setRelayer(address newRelayer) external onlyOwner {
    relayer = newRelayer;
}

/// payBillFor reverts while paused. Refunds deliberately stay callable
/// so anyone already charged can still be made whole.
function pause() external onlyOwner { _pause(); }
```
{% endcode %}
