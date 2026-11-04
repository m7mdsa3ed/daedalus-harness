/* ── Markdown ──
   A document-shaped passage — headings, paragraphs, lists, tables, quotes and
   fenced code — drawn by the same renderer the transcript's answer goes
   through (`Prose`, via `rich-text`), so a table inside a drawn answer and a
   table in the prose above it are the same table. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { MarkdownBlock } from "@/lib/openui/rich-text"

export const Markdown = defineComponent({
  name: "Markdown",
  description: "A block of Markdown: headings, lists, tables, quotes, links and fenced code.",
  props: z.object({ text: z.string() }),
  component: ({ props }) => <MarkdownBlock text={props.text} />,
})
