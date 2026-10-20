/* A command and what it printed, drawn as a terminal session. Display only: the
   text is a string the model wrote, nothing here runs it or reaches out. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { Box, META, PAD, PAD_ROW, TONE_DOT } from "@/lib/openui/kit"

/** Zero is the only success; anything else is the command saying it failed. */
function ExitBadge({ code }: { code: number }) {
  const ok = code === 0
  return (
    <span className={cn(META, "inline-flex shrink-0 items-center gap-1.5 font-mono tabular-nums")}>
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
    const hasBand = Boolean(cwd) || typeof exitCode === "number"
    return (
      <Box>
        <div role="group" aria-label={cwd ? `Terminal in ${cwd}` : "Terminal"}>
          {hasBand && (
            <div
              className={cn(
                "flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b bg-muted/50",
                PAD_ROW,
                "py-1.5 @panel-sm:py-1.5"
              )}
            >
              {/* The path is the long thing: it takes the line and wraps, the badge keeps its width. */}
              <span className={cn(META, "min-w-0 flex-1 basis-32 font-mono")}>{cwd}</span>
              {typeof exitCode === "number" && <ExitBadge code={exitCode} />}
            </div>
          )}
          {/* Wraps rather than scrolls, so a long line cannot widen a phone panel. */}
          <pre
            className={cn(
              "overflow-auto font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-foreground",
              PAD
            )}
          >
            {command && (
              <span className="block font-medium text-foreground">
                <span aria-hidden className="text-muted-foreground select-none">$ </span>
                {command}
              </span>
            )}
            {output && <span className={cn("block", command && "mt-1.5")}>{output}</span>}
          </pre>
        </div>
      </Box>
    )
  },
})
