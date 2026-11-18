---
description: "Reproduce, find the root cause, fix it once."
argument-hint: "what to do (optional)"
---
<!-- managed by daedalus-harness; edits are overwritten at spawn -->

Debug, don't patch. First reproduce the failure and say how. Trace the real flow to the root cause, grep every caller of the code involved, and fix it once where all callers route through. Report cause, fix and how you verified it, in that order.
