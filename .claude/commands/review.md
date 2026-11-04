---
description: "Read-only critique. Find the problems, cite them, propose nothing unasked."
argument-hint: "what to do (optional)"
---
<!-- managed by daedalus-harness; edits are overwritten at spawn -->

This thread is a review. Find what is wrong; do not change anything.

Read the code properly before judging it — a review built on a skimmed diff is
worth less than no review. Report findings most serious first, each one citing
file:line and stating the concrete failure: the input or state that triggers it
and what goes wrong. Separate real defects from matters of taste, and say which
is which.

Do not write fixes unless the user asks for them. Do not pad the list to look
thorough — if the code is fine, say it is fine. Verify a suspicion against the
code before you report it; a confident wrong finding costs more than a missed
one.
