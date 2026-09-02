import * as React from "react"
import { CalendarClock, SlashSquare, type LucideIcon } from "lucide-react"
import type * as acp from "@daedalus/acp"
import { cn } from "@/lib/utils"
import { ComposerStripItem, useStripSummary } from "./composer-strip"

/* Slash-command autocomplete for the composer.

   ACP has no "run command" RPC — a command is a normal `session/prompt` whose
   text starts with `/name`, and the agent advertises the catalog through
   `available_commands_update` (held on ThreadState.availableCommands). So for
   the agent's own commands this is purely an input affordance: it completes the
   name, and the send path stays untouched. A draft thread has no process and
   therefore no catalog, so only harness commands open the menu there.

   **A second kind of command is the harness's own** (`HARNESS_COMMANDS`), and
   it is the one thing here the send path has to know about: `/schedule` opens
   the schedule form with what is already typed, and must never be handed to the
   agent as a prompt. They are declared in the same `acp.AvailableCommand` shape
   so the menu draws one list, and they are **shadowed by the agent's**: a
   runtime that advertises `/schedule` of its own keeps it, and
   `harnessCommandFor` then declines to intercept — a name collision must cost
   the agent's command, never silently swallow it. */

/** The harness's own commands. `_meta` is untouched — these never reach ACP. */
export const HARNESS_COMMANDS = [
  {
    name: "schedule",
    description: "Send this message later, once or on a repeat",
    input: { hint: "message to schedule (optional)" },
  },
] as const satisfies readonly acp.AvailableCommand[]

export type HarnessCommandName = (typeof HARNESS_COMMANDS)[number]["name"]

/* Drawn with its own mark rather than the generic slash, so a row that opens a
   harness surface does not read as one more thing the agent will answer. */
const HARNESS_ICON: Record<string, LucideIcon> = { schedule: CalendarClock }


/**
 * Read a composed message as a harness command: `/schedule do the thing` →
 * `{ name: "schedule", args: "do the thing" }`, and `null` for anything else —
 * including a name the agent also advertises, which stays the agent's.
 *
 * The send path calls this *before* sending, which is what makes these commands
 * different from the agent's: the text is consumed here instead of travelling
 * as a prompt.
 */
export function harnessCommandFor(
  text: string,
  agentCommands: acp.AvailableCommand[]
): { name: HarnessCommandName; args: string } | null {
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(text.trim())
  if (!m) return null
  const [, name, args] = m
  const command = HARNESS_COMMANDS.find((c) => c.name === name)
  if (!command) return null
  if (agentCommands.some((c) => c.name === name)) return null
  return { name: command.name, args: args.trim() }
}

export interface SlashCommandState {
  /** Matches for the token being typed; empty when the menu is closed. */
  matches: acp.AvailableCommand[]
  selected: number
  /** Argument hint for a fully typed command awaiting its input. */
  hint: string | null
  /** Names in `matches` that are the harness's, not the agent's — the menu
      draws those with their own mark. Shadowed names are not in here. */
  harnessNames: ReadonlySet<string>
  pick: (command: acp.AvailableCommand) => void
  setSelected: (index: number) => void
  /** Returns true when the key drove the menu and must not reach the send logic. */
  onKeyDown: (e: React.KeyboardEvent) => boolean
}

export function useSlashCommands(
  text: string,
  commands: acp.AvailableCommand[],
  setText: (text: string) => void,
  /** Harness commands the caller can offer — a draft thread cannot be scheduled
      (nothing exists to schedule against yet), so it passes none. */
  harness: readonly acp.AvailableCommand[] = HARNESS_COMMANDS
): SlashCommandState {
  const [selected, setSelected] = React.useState(0)
  const [dismissed, setDismissed] = React.useState(false)

  /* The agent's catalog wins a name collision — see harnessCommandFor, which
     declines the same pair — so the harness rows are filtered against it. */
  const own = React.useMemo(
    () => harness.filter((h) => !commands.some((c) => c.name === h.name)),
    [commands, harness]
  )
  const catalog = React.useMemo(() => [...commands, ...own], [commands, own])
  const harnessNames = React.useMemo(() => new Set(own.map((c) => c.name)), [own])

  /* Open only while the command *name* is being typed: a lone token starting
     with "/". The first space ends the token — from there the user is writing
     arguments and the menu would cover their own text. */
  const token = /^\/(\S*)$/.exec(text)?.[1] ?? null
  const matches = React.useMemo(() => {
    if (token === null || dismissed) return []
    const q = token.toLowerCase()
    return catalog.filter((c) => c.name.toLowerCase().startsWith(q))
  }, [token, dismissed, catalog])

  // Escape closes the menu for this token only; typing anything reopens it.
  React.useEffect(() => setDismissed(false), [text])
  // Clamp instead of resetting on every keystroke so narrowing the query keeps
  // the highlight stable when it can.
  const index = Math.min(selected, Math.max(matches.length - 1, 0))

  /* Once the name is complete and a space typed, surface the command's
     argument hint (ACP UnstructuredCommandInput) where the menu just was. */
  const typed = /^\/(\S+)\s+$/.exec(text)?.[1]
  const hint = typed
    ? (catalog.find((c) => c.name === typed)?.input?.hint ?? null)
    : null

  const pick = (command: acp.AvailableCommand) => {
    // A trailing space only when the command takes input — for the rest the
    // completion is the whole message, ready to send.
    setText(`/${command.name}${command.input ? " " : ""}`)
    setSelected(0)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (matches.length === 0) return false
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault()
        setSelected((index + 1) % matches.length)
        return true
      case "ArrowUp":
        e.preventDefault()
        setSelected((index - 1 + matches.length) % matches.length)
        return true
      case "Tab":
      case "Enter":
        // IME composition owns Enter (accepting a candidate, not a command).
        if (e.nativeEvent.isComposing) return false
        // Fully typed already: completing would change nothing, so Enter must
        // fall through and send — otherwise it re-picks forever.
        if (
          e.key === "Enter" &&
          `/${matches[index].name}${matches[index].input ? " " : ""}` === text
        )
          return false
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

  return { matches, selected: index, hint, harnessNames, pick, setSelected, onKeyDown }
}

/**
 * The suggestions, as a row on the composer strip.
 *
 * It used to be a bordered, shadowed popover pinned over the composer with
 * `absolute inset-x-0 bottom-full`. Two problems with that: it was a second
 * floating surface in a place that already has a shelf for exactly this kind of
 * thing, and being absolutely positioned it painted straight over whatever the
 * strip was showing — a running plan, the "earlier prompt" notice — hiding
 * state the user needs while they type.
 *
 * As a strip item it has no chrome of its own (the strip is the surface), it
 * stacks under the plan instead of on top of it, and the composer moves down to
 * make room rather than being covered. It goes LAST, closest to the composer,
 * because it belongs to the text being typed right now — the rows above it
 * belong to the turn.
 */
export function SlashCommandMenu({ state }: { state: SlashCommandState }) {
  const listRef = React.useRef<HTMLDivElement>(null)
  /* Urgent: a menu you are arrow-keying through has to be visible to be a menu.
     It belongs to the text being typed right now, so while it is up the shelf
     is open regardless of what the summary line would otherwise have said. */
  const showing = state.hint !== null || state.matches.length > 0
  useStripSummary(
    showing
      ? {
          id: "slash",
          icon: SlashSquare,
          label: state.hint ?? `${state.matches.length} command${state.matches.length === 1 ? "" : "s"}`,
          urgent: true,
        }
      : null
  )
  React.useEffect(() => {
    listRef.current
      ?.querySelector('[data-selected="true"]')
      ?.scrollIntoView({ block: "nearest" })
  }, [state.selected, state.matches])

  if (state.hint) {
    return (
      <ComposerStripItem className="flex items-center gap-2 px-2 py-1.5 text-[11px] text-muted-foreground">
        <SlashSquare className="size-3 shrink-0" />
        <span className="min-w-0 truncate">{state.hint}</span>
      </ComposerStripItem>
    )
  }
  if (state.matches.length === 0) return null

  return (
    <ComposerStripItem>
      {/* Caps at roughly five rows and scrolls: a long catalog must not push the
          composer off the bottom of the screen — the same rule the plan list
          follows. */}
      <div ref={listRef} className="max-h-44 overflow-y-auto p-1 overscroll-contain">
        {state.matches.map((command, i) => {
          const Icon = state.harnessNames.has(command.name)
            ? (HARNESS_ICON[command.name] ?? SlashSquare)
            : SlashSquare
          return (
          <button
            key={command.name}
            type="button"
            data-selected={i === state.selected || undefined}
            /* mousedown, not click: click fires after the textarea has lost
               focus, and preventDefault here keeps the caret where typing
               continues. */
            onMouseDown={(e) => {
              e.preventDefault()
              state.pick(command)
            }}
            onMouseMove={() => state.setSelected(i)}
            className={cn(
              "flex w-full items-baseline gap-2 rounded-lg px-2 py-2 text-left sm:py-1",
              i === state.selected && "bg-accent text-accent-foreground"
            )}
          >
            <Icon className="size-3.5 shrink-0 self-center text-muted-foreground" />
            <span className="shrink-0 font-mono text-xs">/{command.name}</span>
            {command.input?.hint && (
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground/70">
                {command.input.hint}
              </span>
            )}
            {/* min-w-0: a flex item won't shrink below its content without it,
                so the description pushed a long row past the strip's edge
                instead of eliding. */}
            <span className="min-w-0 truncate text-[11px] text-muted-foreground">
              {command.description}
            </span>
          </button>
          )
        })}
      </div>
    </ComposerStripItem>
  )
}
