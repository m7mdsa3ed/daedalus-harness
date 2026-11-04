/* A command and what it printed, drawn as a terminal session. Display only: the
   text is a string the model wrote, nothing here runs it or reaches out.

   The body is the kit's `CodeWell` — the same surface `Code` and a `Steps`
   command draw through — so a command copied out of a terminal reads the same
   as one copied out of a snippet, and the copy button is the app's own. What is
   this component's alone is the band above it: where it ran, and how it exited. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { Box, CodeBand, CodeWell, META, TONE_DOT } from "@/lib/openui/kit"

/** Zero is the only success; anything else is the command saying it failed. */
function ExitBadge({ code }: { code: number }) {
  const ok = code === 0
  return (
    <span className={cn(META, "inline-flex shrink-0 items-center gap-1 font-mono tabular-nums")}>
      <span aria-hidden className={cn("size-1.5 rounded-full", ok ? TONE_DOT.success : TONE_DOT.error)} />
      <span className={ok ? undefined : "text-destructive"}>exit {code}</span>
    </span>
  )
}

export const Terminal = defineComponent({
  name: "Terminal",
  description: "A shell command and its output in a terminal frame, with an optional working directory and exit code; display only.",
  props: z.object({
    command: z.string(),
    output: z.string().optional(),
    exitCode: z.number().optional(),
    cwd: z.string().optional(),
  }),
  component: ({ props }) => {
    const { command, output, exitCode, cwd } = props
    /* The command is coloured as the shell it will be pasted into. The output
       is deliberately left plain: it is whatever the command printed — a log, a
       stack trace, a table — and a guessed grammar paints a stack trace as
       Perl. The `$` prompt is text, so the copy button hands back what the
       reader would paste: the line without it. */
    const hasBand = Boolean(cwd) || typeof exitCode === "number"
    return (
      /* One group for the whole session: a screen reader meets a shell command
         and its output as one thing, named by where it ran. */
      <Box>
        <div role="group" aria-label={cwd ? `Terminal in ${cwd}` : "Terminal"}>
          <CodeWell
            code={command}
            tail={output}
            prefix="$"
            language="bash"
            header={
              /* The same band `Code` wears, with the reading at the end being the
                 exit rather than nothing. A terminal with neither a cwd nor an
                 exit has no band at all, rather than an empty rule. */
              hasBand ? <CodeBand start={cwd} end={typeof exitCode === "number" ? <ExitBadge code={exitCode} /> : undefined} /> : undefined
            }
          />
        </div>
      </Box>
    )
  },
})
