/* ── Command palette ──
   ⌘K / Ctrl-K. One box over everything the shell can do, and — since this
   rewrite — a stack of pages rather than one long list.

   The rule the whole thing is built on: **the root page never asks the server.**
   It used to. Threads were listed inline and a debounced `/api/search` ran on
   every keystroke, so the command list and a full-text query shared one input,
   one ranking and one clock — commands were diluted by conversations, and the
   fast local half of the list redrew whenever the slow remote half answered.
   Now the root is a pure local filter over commands, and searching is a
   *destination*: "Search threads and messages…" descends into a page that owns
   its own query, debounce and loading state, exactly as "Ask a new thread"
   descends into a project chooser. Actions are instant because nothing they
   share a box with is waiting on a socket.

   Ranking is ours (`shouldFilter={false}`, see `score.ts`/`list.tsx`) because
   the rows that are *about* the query — search for it, ask a thread with it —
   have to sit below every row that is a real match for it, whatever they score.

   A page is left the way it was entered: Escape, Backspace on an empty box, or
   the chip in the input. Escape is taken in the capture phase — the dialog's
   own Escape-to-close listens on the popup, which bubbles *after* us, so
   without capture the whole palette would close instead of going back one. */
import * as React from "react"
import { ArrowLeft } from "lucide-react"

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandList,
} from "@/components/ui/command"
import { PaletteInput } from "./palette-input"
import { useShortcut } from "@/hooks/use-hotkey"
import { KEYS, matchesChord } from "@/lib/shortcuts"
import type { Actions } from "@/lib/actions"
import type { WorkspaceDock } from "@/components/workspace/dock"
import {
  PAGE_LABEL,
  PAGE_PLACEHOLDER,
  PaletteContext,
  type PageId,
  type Palette,
} from "./context"
import {
  EffortPage,
  ModePage,
  ModelPage,
  PersonaPage,
  ProjectsPage,
  StartPage,
  ThemePage,
} from "./choice-pages"
import { RootPage } from "./root-page"
import { RoutineActivityPage, RunRoutinePage } from "./routine-pages"
import { SearchPage } from "./search-page"

export { PaletteContext, usePalette } from "./context"

/** Open state + the ⌘K binding, so the shell only has to render the palette. */
export function useCommandPalette() {
  const [open, setOpen] = React.useState(false)

  useShortcut("palette", () => {
    setOpen((previous) => !previous)
  })

  return { open, setOpen }
}

export function CommandPalette({
  open,
  onOpenChange,
  actions,
  dock,
  onNewThread,
  onNewProject,
  onImportThreads,
  onShortcuts,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  actions: Actions
  dock: WorkspaceDock
  /** Mints a draft thread and routes to it. With `text`, it also sends that
      first message — see `startThread` in app-shell. */
  onNewThread: (opts?: { text?: string; projectId?: string }) => void
  onNewProject: () => void
  /** Opens the import dialog, which app-shell owns — it outlives the palette,
      which unmounts the moment a command runs. */
  onImportThreads: () => void
  onShortcuts: () => void
}) {
  const [stack, setStack] = React.useState<PageId[]>(["root"])
  const [query, setQuery] = React.useState("")
  const [askText, setAskText] = React.useState("")
  const page = stack[stack.length - 1]
  const nested = stack.length > 1

  // Every open starts at the root page with an empty query — a palette that
  // remembers where you left it is a palette you have to read before using.
  React.useEffect(() => {
    if (open) {
      setStack(["root"])
      setQuery("")
      setAskText("")
    }
  }, [open])

  const back = React.useCallback(() => {
    setStack((previous) => (previous.length > 1 ? previous.slice(0, -1) : previous))
    setQuery("")
  }, [])

  const palette: Palette = {
    page,
    query,
    setQuery,
    askText,
    close: () => onOpenChange(false),
    run: (fn) => {
      onOpenChange(false)
      fn()
    },
    descend: (next, opts) => {
      setStack((previous) => [...previous, next])
      setQuery(opts?.query ?? "")
      if (opts?.askText !== undefined) setAskText(opts.askText)
    },
    back,
    actions,
    dock,
    newThread: onNewThread,
    newProject: onNewProject,
    importThreads: onImportThreads,
    showShortcuts: onShortcuts,
  }

  const onKeyDownCapture = (event: React.KeyboardEvent) => {
    /* ⌘↵ is the composer's own send chord, which is why it is this one and not
       a new binding to learn: the box doubles as a first message, and this
       sends it without hunting for the row that offers the same by mouse. */
    if ((page === "root" || page === "search") && query.trim() && matchesChord(event, KEYS.send)) {
      event.preventDefault()
      onOpenChange(false)
      onNewThread({ text: query.trim() })
      return
    }
    if (!nested) return
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      back()
      return
    }
    if (event.key === "Backspace" && !query) {
      event.preventDefault()
      back()
    }
  }

  return (
    /* Centred, like every other dialog: shadcn's CommandDialog pins itself at
        top-1/3, which reads as anchored to nothing once the list grows or
        shrinks with the query. Dead-centre keeps the input under the cursor's
        rest position at any result count — asserted here rather than patched
        into `ui/command.tsx`, which a re-install would overwrite. */
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      className="top-1/2 -translate-y-1/2 sm:max-w-xl"
    >
      <PaletteContext.Provider value={palette}>
        {/* Filtering is this file's, not cmdk's — see score.ts. */}
        <Command loop shouldFilter={false} onKeyDownCapture={onKeyDownCapture} className="bg-transparent">
          <PaletteInput
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder={PAGE_PLACEHOLDER[page]}
            prefix={
              nested ? (
                <button
                  type="button"
                  // Keeps the caret in the box: a chip that steals focus would
                  // leave the next keystroke going nowhere.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={back}
                  className="flex shrink-0 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  <ArrowLeft className="size-3" />
                  {PAGE_LABEL[page]}
                </button>
              ) : undefined
            }
          />
          <CommandList className="max-h-[60vh]">
            {/* The search page says its own "nothing found", per section and per
                clock — a single global one cannot tell "no messages" from
                "still asking". */}
            {/* The activity page says its own "nothing yet", per cause: an
                empty digest can mean no routines, a read still out, or a read
                that failed, and one global line cannot tell them apart. */}
            {page !== "search" && page !== "routine-activity" && (
              <CommandEmpty>No matches.</CommandEmpty>
            )}
            {page === "root" && <RootPage />}
            {page === "search" && <SearchPage />}
            {page === "projects" && <ProjectsPage />}
            {page === "start" && <StartPage />}
            {page === "theme" && <ThemePage />}
            {page === "model" && <ModelPage />}
            {page === "effort" && <EffortPage />}
            {page === "mode" && <ModePage />}
            {page === "persona" && <PersonaPage />}
            {page === "routines" && <RunRoutinePage />}
            {page === "routine-activity" && <RoutineActivityPage />}
          </CommandList>
        </Command>
      </PaletteContext.Provider>
    </CommandDialog>
  )
}
