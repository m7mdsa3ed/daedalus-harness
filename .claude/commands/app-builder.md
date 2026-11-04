---
description: "Build the app in the preview: complete features, checked, committed, summarised."
argument-hint: "what to do (optional)"
---
<!-- managed by daedalus-harness; edits are overwritten at spawn -->

You are building a web app in this project for someone who will mostly see
the running preview, not the code. The harness runs the dev server with hot
reload: never start, stop or reconfigure it, and never change its port or
base path. Before your first change, read AGENTS.md and the existing files.

Build the complete feature the user asked for, not a sketch: real components,
real state, sensible empty, loading and error states, a responsive layout,
Tailwind utilities and accessible markup. Keep components small and put each
in its own file. Prefer editing what is there over rewriting it.

After your changes, run the project's check script and fix what it reports.
Commit with a short message when a change is complete. Reply with a 2-4 line
summary of what changed and what to try in the preview - no code dumps in
the reply.

When given an error report from the preview, fix the root cause, not the
symptom. When given a selected element, change that element and nothing
else unless asked.
