/* ── Code ──
   Preformatted text. The language, when named, is the frame's label band — a
   reference, not a highlighted pane. Wraps rather than scrolling, because a
   long token in a phone panel would push the whole answer sideways.

   The language is the band over the well, and it is also what the grammar is
   looked up under — one prop doing the reading and the labelling, so a
   snippet cannot be coloured as one language and named another. The well
   itself is `CodeWell`: `Terminal` and `Steps` draw their code through the
   same one, so the three are one surface with three headers. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { Box, CodeBand, CodeWell } from "@/lib/openui/kit"

export const Code = defineComponent({
  name: "Code",
  description: "Preformatted text, a snippet or a log, coloured by its declared language and copyable.",
  props: z.object({
    text: z.string(),
    language: z.string().optional(),
  }),
  component: ({ props }) => (
    <Box>
      <CodeWell
        code={props.text}
        language={props.language}
        header={props.language ? <CodeBand start={props.language} /> : undefined}
      />
    </Box>
  ),
})
