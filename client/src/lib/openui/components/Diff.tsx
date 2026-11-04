/* ── Diff ──
   A before/after of text, drawn by the same line diff tool steps use, so a diff
   in a drawn answer and the diff on a tool row are one renderer. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { DiffView } from "@/components/ui/diff-view"

export const Diff = defineComponent({
  name: "Diff",
  description: "A line diff between old and new text, with an optional path.",
  props: z.object({
    before: z.string(),
    after: z.string(),
    path: z.string().optional(),
  }),
  component: ({ props }) => <DiffView className="w-full" oldText={props.before} newText={props.after} path={props.path} />,
})
