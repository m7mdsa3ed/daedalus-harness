import * as React from "react"
import { BookmarkPlus, FileCode, History, SquareTerminal, TriangleAlert } from "lucide-react"
import { HelperForm } from "@/components/helper-form"
import { Button } from "@/components/ui/button"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import type { HelperCommand } from "@/lib/settings"
import type { ProjectScript, ShellUse } from "@/lib/workspace/project-helpers"
import { useStripSummary } from "./composer-strip"
import { CompleterList, CompleterRow, CompleterSection } from "./composer/completer"

/* `!` commands for the composer — a shell line, with the project's saved ones
   and its package.json scripts suggested.

   Three things share the prefix, and the send path tells them apart. The
   **project's helper commands** ("Restart server", "Run migrations") are the
   suggestions: saved shell lines owned by `server/src/project-helpers.ts`,
   edited in Settings › Projects, and the same list the tab menu draws under
   "Project commands" and the project page under "Run". Picking one fills its
   **command** into the box rather than its name — what will actually run is the
   thing worth reading and editing before it does.

   **The scripts the project's package.json files declare** are suggested
   beside them — read off the disk (root and one directory deep), never
   stored. A helper is a row the user wrote; a script is one the project
   already shipped, and both are "the small shell actions this workspace
   runs". A nested package's line carries its own `cd`, so it runs from the
   project root like any other `!` line.

   **What this project keeps running** is the third list, and the one nobody
   writes: the server tallies every `!` line per project
   (`server/src/shell-history.ts`, bumped by the run route itself) and the menu
   offers every recorded line most-used first, under "Recent". Server-side rather than
   device-local on purpose — the line you build with is a property of the
   workspace, so the phone offers what the desktop ran. The same tally *orders*
   the other two lists, so the helper you run daily stands at the top of its
   own section; a line that is already a helper or a script is never repeated
   under Recent.

   **Anything else after the `!`** is a shell line of the user's own. None of
   them is a prompt: the send path consumes the text instead of prompting (the
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

/** One `!` suggestion row, whichever list it came from. A script's `id` is
    its own `command` — it names no row, and the key only has to be unique
    among the rows drawn. */
export interface ProjectCommandSuggestion {
  id: string
  name: string
  command: string
  /** Which list it came from — a row the person wrote, or one the project's
      package.json shipped. Drawn, because a helper carries a cwd, an
      environment and a confirm the script does not. */
  kind: "recent" | "helper" | "script"
  /** A helper that asks before it runs. Scripts never do: the row the
      package shipped did not come with the project's own confirm setting. */
  confirm?: boolean
}

export interface ProjectCommandState {
  /** Helper rows and script rows matching the token being typed; empty when
      nothing matches, which is also when there is no card to draw. */
  matches: ProjectCommandSuggestion[]
  selected: number
  /** Fill the box with a suggestion's *command* line. */
  pick: (suggestion: ProjectCommandSuggestion) => void
  setSelected: (index: number) => void
  /** Returns true when the key drove the menu and must not reach the send logic. */
  onKeyDown: (e: React.KeyboardEvent) => boolean
}

export function useProjectCommands(opts: {
  text: string
  helpers: readonly HelperCommand[]
  scripts: readonly ProjectScript[]
  /** What this project has already run, most used first (the server's tally). */
  history: readonly ShellUse[]
  setText: (text: string) => void
}): ProjectCommandState {
  const { text, helpers, scripts, history, setText } = opts
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
     either is a thing the user knows it by. Helpers first, then scripts — a
     row the person wrote outranks one the package shipped. */
  const suggestions = React.useMemo<ProjectCommandSuggestion[]>(() => {
    /* A line already offered as a helper or a script is not repeated as a
       recent one — the row the project defines carries a name, a cwd and a
       confirm the bare line does not. What it *does* lend it is order:
       inside each list, the thing you run most stands first. */
    const uses = new Map(history.map((use) => [use.line, use.count]))
    const defined = new Set([
      ...helpers.map((helper) => helper.command),
      ...scripts.map((script) => script.command),
    ])
    const byUse = <T extends { command: string }>(rows: T[]) =>
      rows
        .map((row, index) => ({ row, index }))
        .sort(
          (a, b) =>
            (uses.get(b.row.command) ?? 0) - (uses.get(a.row.command) ?? 0) || a.index - b.index
        )
        .map(({ row }) => row)
    return [
      ...history
        .filter((use) => !defined.has(use.line))
        .map((use) => ({
          id: `recent:${use.line}`,
          name: use.count === 1 ? "Run once" : `Run ${use.count} times`,
          command: use.line,
          kind: "recent" as const,
        })),
      ...byUse(helpers.map((helper) => ({
        id: helper.id,
        name: helper.name,
        command: helper.command,
        kind: "helper" as const,
        confirm: helper.confirm || undefined,
      }))),
      ...byUse(
        /* A script saved as a helper is offered once, as the helper. */
        scripts.filter((script) => !helpers.some((helper) => helper.command === script.command)).map((script) => ({
          id: script.command,
          name: script.name,
          command: script.command,
          kind: "script" as const,
        }))
      ),
    ]
  }, [helpers, scripts, history])
  const matches = React.useMemo(() => {
    if (!open || token === null) return []
    const q = token.toLowerCase()
    return suggestions.filter(
      (suggestion) =>
        suggestion.name.toLowerCase().startsWith(q) || suggestion.command.toLowerCase().startsWith(q)
    )
  }, [open, token, suggestions])

  // Escape closes the menu for this token only; typing anything reopens it.
  React.useEffect(() => setDismissed(false), [text])
  // Clamp instead of resetting so narrowing the query keeps the highlight stable.
  const index = Math.min(selected, Math.max(matches.length - 1, 0))

  const pick = (suggestion: ProjectCommandSuggestion) => {
    /* The command, not the name: what goes in the box is what will run, and a
       line the user can read and edit beats an opaque label. */
    setText(`!${suggestion.command}`)
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
export function ProjectCommandMenu({
  state,
  projectId,
}: {
  state: ProjectCommandState
  /** Where a Recent line or a script is saved as a helper; no save button without one. */
  projectId?: string
}) {
  const showing = state.matches.length > 0
  /* The row being saved as a helper. Held here and drawn even once the menu
     has nothing to show, so the dialog outlives a list that filtered away. */
  const [saving, setSaving] = React.useState<ProjectCommandSuggestion | null>(null)
  const [busy, setBusy] = React.useState(false)
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
  const dialog = projectId && (
    <ResponsiveDialog open={saving !== null} onOpenChange={(open) => !open && setSaving(null)}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Save as project command</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Offered first under <span className="font-mono">!</span> and in the project&rsquo;s Run
            menu.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        {saving && (
          <HelperForm
            id="save-helper-form"
            key={saving.id}
            projectId={projectId}
            /* A script lends its name; a Recent line has none worth keeping
               ("Run 3 times"), so the name is the one field left to fill. */
            initial={{ command: saving.command, name: saving.kind === "script" ? saving.name : "" }}
            /* A script already has a name, so the caret goes nowhere and the
               keyboard stays down: Save is one tap. */
            autoFocus={saving.kind !== "script"}
            actions={false}
            onBusyChange={setBusy}
            onDone={() => setSaving(null)}
          />
        )}
        {/* The dialog's own footer, not the form's buttons: it is pinned under
            the scroll and rides the soft keyboard, and on a phone it stacks
            the buttons full-width over the home indicator. */}
        <ResponsiveDialogFooter>
          <Button type="button" variant="outline" onClick={() => setSaving(null)} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form="save-helper-form" disabled={busy}>
            <BookmarkPlus /> {busy ? "Saving…" : "Save command"}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
  if (!showing) return dialog || null

  return (
    <>
    {dialog}
    <CompleterList selected={state.selected} count={state.matches.length}>
      {state.matches.map((suggestion, i) => (
        <React.Fragment key={suggestion.id}>
          {/* The two lists are already ordered (helpers, then scripts), so the
              heading is drawn where the kind changes — said once for the group
              instead of as a badge on every row of it, which is a column of
              chips repeating what the run above it already established. */}
          {suggestion.kind !== state.matches[i - 1]?.kind && (
            <CompleterSection>
              {suggestion.kind === "recent"
                ? "Recent"
                : suggestion.kind === "helper"
                  ? "Project helpers"
                  : "package.json scripts"}
            </CompleterSection>
          )}
        <CompleterRow
          icon={
            suggestion.kind === "recent"
              ? History
              : suggestion.kind === "helper"
                ? SquareTerminal
                : FileCode
          }
          /* The command leads, because that is what a pick puts in the box —
             and the name it is known by is the second line. */
          label={`!${suggestion.command}`}
          description={suggestion.name}
          /* A helper that asks before it runs says so here too, so a row
             picked with the keyboard is not a surprise dialog. */
          trailing={
            suggestion.confirm ? (
              <TriangleAlert
                className="size-3 shrink-0 text-amber-500"
                aria-label="Asks before running"
              />
            ) : projectId && suggestion.kind !== "helper" ? (
              /* Not a <button>: the row already is one. Mousedown is stopped
                 so the row does not pick, and kept from the textarea's focus. */
              /* A pill with its word where the panel has room, the mark alone
                 where it does not; 36px under a coarse pointer, where a 24px
                 mark at the row's edge is a tap on the row instead. */
              <span
                role="button"
                title="Save as a project command"
                className="-my-1 inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground pointer-coarse:-my-2 pointer-coarse:h-9 pointer-coarse:min-w-9 pointer-coarse:justify-center"
                onMouseDown={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setSaving(suggestion)
                }}
              >
                <BookmarkPlus className="size-3.5 pointer-coarse:size-4" />
                <span className="hidden text-[11px] @panel-sm:inline pointer-coarse:hidden">Save</span>
              </span>
            ) : undefined
          }
          selected={i === state.selected}
          onPick={() => state.pick(suggestion)}
          onHover={() => state.setSelected(i)}
        />
        </React.Fragment>
      ))}
    </CompleterList>
    </>
  )
}
