import * as React from "react"
import { SlashSquare } from "lucide-react"
import type * as acp from "@agentclientprotocol/sdk"
import { cn } from "@/lib/utils"
import { ComposerStripItem, useStripSummary } from "./composer-strip"

/* Slash-command autocomplete for the composer.

   ACP has no "run command" RPC — a command is a normal `session/prompt` whose
   text starts with `/name`, and the agent advertises the catalog through
   `available_commands_update` (held on ThreadState.availableCommands). So this
   is purely an input affordance: it completes the name, and the send path
   stays untouched. A draft thread has no process and therefore no catalog, so
   the menu simply never opens there. */

export interface SlashCommandState {
  /** Matches for the token being typed; empty when the menu is closed. */
  matches: acp.AvailableCommand[]
  selected: number
  /** Argument hint for a fully typed command awaiting its input. */
  hint: string | null
  pick: (command: acp.AvailableCommand) => void
  setSelected: (index: number) => void
  /** Returns true when the key drove the menu and must not reach the send logic. */
  onKeyDown: (e: React.KeyboardEvent) => boolean
}

export function useSlashCommands(
  text: string,
  commands: acp.AvailableCommand[],
  setText: (text: string) => void
): SlashCommandState {
  const [selected, setSelected] = React.useState(0)
  const [dismissed, setDismissed] = React.useState(false)

  /* Open only while the command *name* is being typed: a lone token starting
     with "/". The first space ends the token — from there the user is writing
     arguments and the menu would cover their own text. */
  const token = /^\/(\S*)$/.exec(text)?.[1] ?? null
  const matches = React.useMemo(() => {
    if (token === null || dismissed) return []
    const q = token.toLowerCase()
    return commands.filter((c) => c.name.toLowerCase().startsWith(q))
  }, [token, dismissed, commands])

  // Escape closes the menu for this token only; typing anything reopens it.
  React.useEffect(() => setDismissed(false), [text])
  // Clamp instead of resetting on every keystroke so narrowing the query keeps
  // the highlight stable when it can.
  const index = Math.min(selected, Math.max(matches.length - 1, 0))

  /* Once the name is complete and a space typed, surface the command's
     argument hint (ACP UnstructuredCommandInput) where the menu just was. */
  const typed = /^\/(\S+)\s+$/.exec(text)?.[1]
  const hint = typed
    ? (commands.find((c) => c.name === typed)?.input?.hint ?? null)
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

  return { matches, selected: index, hint, pick, setSelected, onKeyDown }
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
        {state.matches.map((command, i) => (
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
              "flex w-full items-baseline gap-2 rounded-lg px-2 py-1 text-left",
              i === state.selected && "bg-accent text-accent-foreground"
            )}
          >
            <SlashSquare className="size-3.5 shrink-0 self-center text-muted-foreground" />
            <span className="shrink-0 font-mono text-xs">/{command.name}</span>
            {command.input?.hint && (
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground/70">
                {command.input.hint}
              </span>
            )}
            <span className="truncate text-[11px] text-muted-foreground">
              {command.description}
            </span>
          </button>
        ))}
      </div>
    </ComposerStripItem>
  )
}
