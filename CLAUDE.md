@AGENTS.md

# Keep the user-facing docs in step with the code

`README.md` and the `/docs` (docs + FAQ), `/terms` and `/privacy` pages describe real
behaviour, and nothing regenerates them — they only stay true if you update them deliberately.
Whenever a change alters what they claim
— a new capability or channel, a changed limit or fee, a new supported wallet or chain, a
different refund/kill-switch/allowance behaviour, a service that stops being purchasable —
update the affected surface in the same change, not later. If you're unsure whether something
is still accurate, read the code and fix it rather than leaving it.

The legal copy on `/terms` has **not** been reviewed by a lawyer. Keep it factually accurate
about how the product behaves and never present it as legally vetted or the contracts as audited.
The owner removed the on-page "not reviewed by a lawyer" notice and the README's "not audited"
labels on 2026-10-17; don't re-add them unasked.
