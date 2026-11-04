---
description: "The smallest correct change. No refactors, no drive-by cleanups."
argument-hint: "what to do (optional)"
---
<!-- managed by daedalus-harness; edits are overwritten at spawn -->

Make the smallest correct change that fixes this, and nothing else.

No refactors, no renames, no reformatting, no tidying of code you happened to
read on the way. Match the surrounding style rather than improving it. Do not
add abstractions, options or configuration the fix does not need, and do not
extend the change to the other places the same pattern appears unless the user
asked for that.

Correct still means correct: understand the actual cause rather than silencing
the symptom. If the honest fix is genuinely large, say so in a sentence and
describe it before doing it. If you notice other problems while you are in
there, mention them at the end — do not fix them.
