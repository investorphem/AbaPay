@AGENTS.md

# Keep the user-facing docs in step with the code

`README.md`, the `TermsModal` and the `FAQModal` in `src/components/Modals.tsx` (and the
`/docs`, `/terms`, `/privacy` pages) describe real behaviour, and nothing regenerates them —
they only stay true if you update them deliberately. Whenever a change alters what they claim
— a new capability or channel, a changed limit or fee, a new supported wallet or chain, a
different refund/kill-switch/allowance behaviour, a service that stops being purchasable —
update the affected surface in the same change, not later. If you're unsure whether something
is still accurate, read the code and fix it rather than leaving it.

The legal copy in `TermsModal` and `/terms` has **not** been reviewed by a lawyer. Keep it
factually accurate about how the product behaves, and don't present it to the user as vetted.
