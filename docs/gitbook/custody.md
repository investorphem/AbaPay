# Custody & settlement

What happens after a payment is signed: custody, on-chain settlement, and the off-chain
handoff to a delivered bill.

## Non-custodial by construction, not just by claim

AbaPay never takes custody of funds ahead of a payment. There is no deposit step, no pooled
balance held on your behalf. The settlement contract uses a pull-based ERC-20 allowance, and
every constraint is enforced **on-chain**, not by application code a direct API call could
bypass:

- The agent-relay function reverts if an amount exceeds either the owner-set
  per-transaction ceiling *or* the caller's own remaining spending allowance — both checked
  before anything moves.
- The allowance is decremented *before* the token transfer (checks-effects-interactions), so
  a reentrant call can't double-spend the same allowance.
- Tokens move directly from the payer's wallet to the settlement contract in the same
  transaction that decrements the allowance — no intermediate AbaPay-controlled balance for
  them to sit in.
- Setting a spending allowance can only ever be called by the wallet setting its own
  allowance — no owner/admin path exists for AbaPay's backend to grant itself more room on
  anyone's account.

The actual checks, verbatim from `contracts/AbaPayV4.sol`:

```solidity
function payBillFor(address user, address tokenAddress, ..., uint256 amount)
    external onlyRelayer whenNotPaused nonReentrant
{
    uint256 perTxCap = maxAgentPaymentPerTx[tokenAddress];
    if (amount > perTxCap) revert ExceedsMaxAgentPayment(amount, perTxCap);

    uint256 remaining = spendingAllowance[user][tokenAddress];
    if (amount > remaining) revert ExceedsSpendingAllowance(amount, remaining);

    // EFFECTS BEFORE INTERACTIONS: burn the allowance first, so a reentrant
    // token cannot spend the same allowance twice.
    spendingAllowance[user][tokenAddress] = remaining - amount;

    uint256 received = _pull(tokenAddress, user, amount);
    emit PaymentReceived(user, tokenAddress, serviceType, accountNumber, received);
}

function setSpendingAllowance(address tokenAddress, uint256 amount) external {
    // msg.sender only -- no owner/relayer path raises anyone else's allowance.
    spendingAllowance[msg.sender][tokenAddress] = amount;
}
```

This matches the framing published at `/terms`: AbaPay operates as a non-custodial software
protocol / technology interface, not a custodian, with no access to any wallet's private
keys.

> `/terms` covers AML monitoring and is explicitly not represented as lawyer-reviewed — read
> it directly for anything you need to rely on legally.

## The off-chain leg: how a payment becomes a delivered bill

The on-chain payment and the off-chain vend are two separate steps, bridged by a webhook,
not a synchronous call:

1. The stablecoin payment lands on-chain (contract call or x402 settlement).
2. AbaPay's backend, triggered by the on-chain event, calls the licensed bill-aggregation
   API this product vends through to actually deliver the purchase.
3. If vending fails after the on-chain payment already confirmed, the transaction enters an
   automatic refund flow — flagged, verified against what actually happened, and refunded
   on-chain without a human needing to intervene.

> An agent integrating against this should treat a pending or failed-vend state as a real,
> expected outcome with money already moved — not an error to retry blindly. Retrying an
> already-settled payment double-charges the wallet.
