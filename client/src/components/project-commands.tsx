import * as React from "react"
import { SquareTerminal, TriangleAlert } from "lucide-react"
import { cn } from "@/lib/utils"
import type { HelperCommand } from "@/lib/settings"
import { ComposerStripItem, useStripSummary } from "./composer-strip"

/* `!` commands for the composer — a shell line, with the project's saved ones
   suggested.

   Two things share the prefix, and the send path tells them apart. The
   **project's helper commands** ("Restart server", "Run migrations") are the
   suggestions: saved shell lines owned by `server/src/project-helpers.ts`,
   edited in Settings › Projects, and the same list the tab menu draws under
   "Project commands" and the project page under "Run". Picking one fills its
   **command** into the box rather than its name — what will actually run is the
   thing worth reading and editing before it does.

   **Anything else after the `!`** is a shell line of the user's own. Neither
   kind is a prompt: the send path consumes the text instead of prompting (the
   bargain `harnessCommandFor` makes for `/schedule`) and runs it in a terminal.
   A line that *is* one of the saved commands runs **as** that helper — its own
   directory, environment and confirm, because the row is the definition — and
   anything else runs as itself (`openShellCommand`).

   Like `/`, the token is anchored to the start of the message: this is a whole
   message, not a word in one. */

/** The shell line a composed `!` message asks to run: `!npm run build` →
    `"npm run build"`, and null for a message that is not one. Trimmed, so a
    trailing newline does not become part of the command. */
export function shellLineFor(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith("!")) return null
  return trimmed.slice(1).trim() || null
}

export interface ProjectCommandState {
  /** Helper rows matching the token being typed; empty when nothing matches,
      which is also when there is no card to draw. */
  matches: HelperCommand[]
  selected: number
  /** Fill the box with a helper's *command* line. */
  pick: (helper: HelperCommand) => void
  setSelected: (index: number) => void
  /** Returns true when the key drove the menu and must not reach the send logic. */
  onKeyDown: (e: React.KeyboardEvent) => boolean
}

export function useProjectCommands(opts: {
  text: string
  helpers: readonly HelperCommand[]
  setText: (text: string) => void
}): ProjectCommandState {
  const { text, helpers, setText } = opts
  const [selected, setSelected] = React.useState(0)
  const [dismissed, setDismissed] = React.useState(false)

  /* Open only while the command *name* is being typed: a lone token starting
     with "!" and holding no space — the same shape `/` uses. A command with a
     space is reached by picking it (which fills the line and closes the menu),
     and then by the send. */
  const token = /^!(\S*)$/.exec(text)?.[1] ?? null
  const open = token !== null && !dismissed
  /* Matched on the name *and* the command: `!pnpm` should find the saved line
     whose name is "Build", and `!Build` the one whose command starts with it —
     either is a thing the user knows it by. */
  const matches = React.useMemo(() => {
    if (!open || token === null) return []
    const q = token.toLowerCase()
    return helpers.filter(
      (helper) =>
        helper.name.toLowerCase().startsWith(q) || helper.command.toLowerCase().startsWith(q)
    )
  }, [open, token, helpers])

  // Escape closes the menu for this token only; typing anything reopens it.
  React.useEffect(() => setDismissed(false), [text])
  // Clamp instead of resetting so narrowing the query keeps the highlight stable.
  const index = Math.min(selected, Math.max(matches.length - 1, 0))

  const pick = (helper: HelperCommand) => {
    /* The command, not the name: what goes in the box is what will run, and a
       line the user can read and edit beats an opaque label. */
    setText(`!${helper.command}`)
    setSelected(0)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) return false
    switch (e.key) {
      case "ArrowDown":
        if (matches.length === 0) return false
        e.preventDefault()
        setSelected((index + 1) % matches.length)
        return true
      case "ArrowUp":
        if (matches.length === 0) return false
        e.preventDefault()
        setSelected((index - 1 + matches.length) % matches.length)
        return true
      case "Tab":
      case "Enter":
        if (matches.length === 0) return false
        // IME composition owns Enter (accepting a candidate, not a command).
        if (e.nativeEvent.isComposing) return false
        // Already the line itself: picking would change nothing, so Enter must
        // fall through and run it — otherwise it re-picks forever.
        if (`!${matches[index].command}` === text) return false
        e.preventDefault()
        pick(matches[index])
        return true
      case "Escape":
        e.preventDefault()
        setDismissed(true)
        return true
      default:
        return false
    }
  }

  return { matches, selected: index, pick, setSelected, onKeyDown }
}

/**
 * The suggestions, as a row on the composer strip — the same surface, and for
 * the same reasons, as `SlashCommandMenu` and `FileMentionMenu`: it belongs to
 * the text being typed right now, so it stacks nearest the composer and pushes
 * the box down rather than painting over the plan or the queue.
 *
 * It draws nothing when nothing matches, rather than the "no matching files"
 * row the `@` menu keeps. A `!` line is a command whether or not it names a
 * saved one, so saying "no matching command" over a line that is about to run
 * would be the menu arguing with the box.
 */
export function ProjectCommandMenu({ state }: { state: ProjectCommandState }) {
  const listRef = React.useRef<HTMLDivElement>(null)
  const showing = state.matches.length > 0
  /* Urgent: a menu you are arrow-keying through has to be visible to be a menu,
     so while it is up the shelf is open whatever the summary line would say. */
  useStripSummary(
    showing
      ? {
          id: "project-command",
          icon: SquareTerminal,
          label: `${state.matches.length} project command${state.matches.length === 1 ? "" : "s"}`,
          urgent: true,
        }
      : null
  )
  React.useEffect(() => {
    listRef.current
      ?.querySelector('[data-selected="true"]')
      ?.scrollIntoView({ block: "nearest" })
  }, [state.selected, state.matches])

  if (!showing) return null

  return (
    <ComposerStripItem>
      {/* Caps at roughly five rows and scrolls — the same rule the command menu
          and the plan list follow. */}
      <div ref={listRef} className="max-h-44 overflow-y-auto p-1 overscroll-contain">
        {state.matches.map((helper, i) => (
          <button
            key={helper.id}
            type="button"
            data-selected={i === state.selected || undefined}
            /* mousedown, not click: click fires after the textarea has lost
               focus, and preventDefault here keeps the caret where typing
               continues. */
            onMouseDown={(e) => {
              e.preventDefault()
              state.pick(helper)
            }}
            onMouseMove={() => state.setSelected(i)}
            className={cn(
              "flex w-full items-baseline gap-2 rounded-lg px-2 py-2 text-left sm:py-1",
              i === state.selected && "bg-accent text-accent-foreground"
            )}
          >
            <SquareTerminal className="size-3.5 shrink-0 self-center text-muted-foreground" />
            {/* The command leads, because that is what a pick puts in the box. */}
            <span className="min-w-0 truncate font-mono text-xs">!{helper.command}</span>
            <span className="shrink-0 text-[11px] text-muted-foreground">{helper.name}</span>
            {/* A helper that asks before it runs says so here too, so a row
                picked with the keyboard is not a surprise dialog. */}
            {helper.confirm && (
              <TriangleAlert
                className="size-3 shrink-0 self-center text-amber-500"
                aria-label="Asks before running"
              />
            )}
          </button>
        ))}
      </div>
    </ComposerStripItem>
  )
}
