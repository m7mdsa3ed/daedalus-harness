/* ── Recommended project commands ──
   The model's closing `suggest-commands` fence (`lib/suggestions`): one or two
   of the project's own commands (`server/src/project-helpers.ts`,
   `project-scripts.ts`) it picked as the next thing worth running. Drawn beside
   the follow-ups under the same answer, and deliberately *not* the way they are:
   a follow-up is a sentence the user sends and reads as prose, a command is a
   shell line, so it wears the shell's dress — a terminal mark and the line in
   monospace behind its `!` — and the caption names it ("Project commands")
   where the follow-ups say "Next".

   The whole list is already filtered to the commands the project defines
   (`keepDefinedCommands`), so every row here is a line that will resolve and
   run; the component only draws, and draws nothing when there is nothing.

   A click fills the composer with `!<command>`, the same bargain the `!`
   completer's pick makes (`project-commands.tsx`): what will run is the line
   worth reading and editing before it does, so it lands in the box editable and
   unsent rather than running on the click. */
import { SquareTerminal } from "lucide-react"

import { LABEL } from "@/components/tool-parts"
import { cn } from "@/lib/utils"

export function CommandSuggestions({
  commands,
  onPick,
  className,
}: {
  commands: readonly string[]
  /** Fill the composer with the picked `!` line. Replaces, like a history recall. */
  onPick: (command: string) => void
  className?: string
}) {
  if (commands.length === 0) return null

  return (
    <div
      data-slot="command-suggestions"
      className={cn(
        "mt-1 mb-2 flex min-w-0 flex-col gap-1",
        "animate-in fade-in-0 slide-in-from-bottom-1 duration-200 ease-out",
        className
      )}
    >
      <span className={cn(LABEL, "mb-0.5")}>Project commands</span>
      {commands.map((command) => (
        <button
          key={command}
          type="button"
          onClick={() => onPick(command)}
          title={`Run: ${command}`}
          className={cn(
            /* The follow-up chip's frame — same radius, same hairline — on the
               recessed ground a shell surface wears, so the two groups under one
               answer read as two kinds of thing rather than one list drawn
               twice. */
            "group/command flex w-full min-w-0 items-center gap-2 rounded-md",
            "border border-border/60 bg-muted/40 px-2 py-1 text-start",
            "transition-colors hover:border-border hover:bg-accent hover:text-accent-foreground",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          )}
        >
          <span aria-hidden className="grid h-5 shrink-0 place-items-center">
            <SquareTerminal className="size-3.5 text-muted-foreground/60 transition-colors group-hover/command:text-current" />
          </span>
          {/* The line is a whole message that happens to be one line, so it
              truncates rather than wrapping: a command broken across two lines
              is harder to read back than one cut off, and the `!` still says
              what it is. Mono, because that is what a shell line looks like. */}
          <span className="min-w-0 flex-1 truncate font-mono text-xs leading-5 text-muted-foreground transition-colors group-hover/command:text-current">
            <span className="select-none text-muted-foreground/50">!</span>
            {command}
          </span>
        </button>
      ))}
    </div>
  )
}
