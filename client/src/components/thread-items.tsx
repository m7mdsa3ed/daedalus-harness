/* ── The transcript's rows, at the path every caller already spells ──
   The file that was here is `thread-items/rows.tsx` now; what came out of it
   are the three siblings beside that file, each of which the cluster imports
   one way (see the header comment there). This is the barrel, and it stays
   because the transcript's vocabulary is imported *from the transcript* by the
   approval card, the editor panel, the composer's queue and thread-view — and
   because a dozen comments across the app name `thread-items.tsx` as the place
   the rows live.

   The tool-call layouts and the boxes they are built from live in their own
   files — see the header comment on each. This one keeps the transcript's own
   rows: a message, a step, a plan, a compaction. The shared step chrome is
   `step-row.tsx`, the non-recursive leaf layouts are `thread-cards.tsx`, and
   a run of them (a workflow, a batch of subagents) is `workflow-run.tsx`;
   what stays here is the mutually recursive cluster (RowView / ThreadItemView
   / ToolRun / SubagentStep / SubagentBody), which cannot move apart without a
   module cycle — which is also why `SubagentStep` reaches a run's list as
   workflow-run's `stepRow` prop rather than as an import. */

/* Re-exported so the approval card and the editor panel keep importing the
   transcript's vocabulary from the transcript, not from its internals. */
export {
  FileBadge,
  KIND_CHIPS,
  KIND_COLORS,
  KIND_ICONS,
  KIND_LABELS,
  Prose,
  Timestamp,
  ToolCallContent,
} from "@/components/tool-parts"
export { SourcesStrip } from "@/components/thread-cards"

/* The row shapes are `lib/transcript-rows`' — the transform that builds them
   is shared with the nested transcript a subagent step draws, and both this
   file and thread-view read them. Re-exported so callers keep importing the
   transcript's vocabulary from the transcript. */
export type { Row, SubagentBatch, SubagentGroup, ToolRunGroup, WorkflowGroup } from "@/lib/transcript-rows"

export { RowView, SubagentStep, ThreadItemView, ToolRun } from "@/components/thread-items/rows"
export { UserMessageText } from "@/components/thread-items/user-message"
