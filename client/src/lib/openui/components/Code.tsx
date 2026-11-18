/* ── Code ──
   Preformatted text, copyable, coloured by its declared language. One surface
   for every run of characters meant to be copied: a snippet, a log, a shell
   session (`bash`, the command and what it printed — what `Terminal` was) and a
   unified diff (`diff`, which highlight.js colours by line — what `Diff` was).
   The band over the well names it: `title` (a path, a cwd) when given, else the
   language. Wraps rather than scrolling, because a long token in a phone panel
   would push the whole answer sideways. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { Box, CodeBand, CodeWell } from "@/lib/openui/kit"

export const Code = defineComponent({
  name: "Code",
  description:
    "Preformatted text, copyable and coloured by its `language`: a snippet, a log, a shell session (`bash`) or a unified diff (`diff`), with an optional `title` such as a file path.",
  props: z.object({
    text: z.string(),
    language: z.string().optional(),
    title: z.string().optional(),
  }),
  component: ({ props }) => {
    const band = props.title || props.language
    return (
      <Box className="bg-muted/50">
        <CodeWell code={props.text} language={props.language} header={band ? <CodeBand start={band} /> : undefined} />
      </Box>
    )
  },
})
