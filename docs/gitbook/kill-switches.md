# Kill switches

All of them stop the agent, not just the UI — enforced by the same code path (or the
contract itself) regardless of which channel or credential is calling in, MCP and A2A
included.

- **Per-service and per-provider switches**: pausing, say, Electricity or just MTN airtime
  applies to every rail, including the web app's API and x402. A paused service is refused
  before anything is paid.
- **Automatic float breaker**: if a provider reports that AbaPay's float with it is empty, its
  services are refused before payment until the float is topped up. They then resume on their
  own. Payers see "temporarily unavailable" instead of being charged and refunded.
- **Per-channel pause** — an operator can pause just the MCP surface without touching
  Telegram/WhatsApp/X.
- **Global pause** — the contract itself can be paused; payments revert while paused, but
  refunds deliberately stay callable so anyone already charged can still be made whole.
- **Relayer kill switch** — instantly disables the agent-initiated payment path
  system-wide, on-chain, independent of anything the backend does. A compromised backend
  cannot re-enable itself.
- **Per-credential rate limiting** — every money-moving call is rate-limited per API key, on
  top of the PIN requirement. See [Rate limits](rate-limits.md) for the full numbers.
- **PIN lockout** — escalating lockout on repeated failed PIN attempts: the 5th wrong PIN
  locks the credential for 1 minute, then 5 minutes, 30 minutes, 2 hours and 24 hours. Each
  attempt is counted *before* the PIN is checked, so sending guesses in parallel doesn't get
  more than 5 through. If the counter can't be reached, the attempt is refused rather than let
  through uncounted.

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
