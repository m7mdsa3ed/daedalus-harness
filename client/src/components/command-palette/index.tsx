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

   Ranking is ours (`filter={() => true}`, see `score.ts`/`rank.ts`) because the
   rows that are *about* the query — search for it, ask a thread with it — have
   to sit below every row that is a real match for it, whatever they score. The
   menu is handed rows already in their final order and is asked to keep it.

   A page is left the way it was entered: Escape, Backspace on an empty box, or
   the chip in the input. Escape is taken in the capture phase — the dialog's
   own Escape-to-close listens on the popup, which bubbles *after* us, so
   without capture the whole palette would close instead of going back one.

   ── The publish loop, and why it terminates ──
   `CommandMenu` owns selection from its own `items` array (see `list.tsx`), so
   the page components render for their hooks and publish their rows up here
   rather than drawing them. That is a cycle waiting to happen: a publish sets
   state on this component, this component re-renders its child page, the page
   builds a fresh array and publishes again. Two things close it, and removing
   either brings back an infinite render:

     - `palette` is **memoized** on what it is actually made of. It used to be a
       fresh object every render, which is a context change, which re-renders
       every page through any memo.
     - the page is rendered through a **memoized** `PageBody` taking only the
       page id. A publish changes neither its props nor the context it reads, so
       it does not re-render — and a page that re-renders for its *own* reasons
       (a query answering, a turn starting) still publishes, which is the point.

   A publish is also stamped with the page that made it, and a reading for the
   wrong page is discarded rather than drawn: a descend would otherwise paint
   one frame of the page being left, under the heading of the page being
   entered. It cannot be an effect that clears — a child's layout effect runs
   before the parent's, so the clear would land after the new page's publish. */
import * as React from "react"
import { ArrowLeft } from "lucide-react"

import {
  CommandMenu,
  CommandMenuDialog,
  CommandMenuEmpty,
  CommandMenuFooter,
  CommandMenuInput,
  CommandMenuList,
} from "@/components/ui/command-menu"
import { Button } from "@/components/ui/button"
import { useShortcut } from "@/hooks/use-hotkey"
import { KEYS, matchesChord } from "@/lib/shortcuts"
import type { Actions } from "@/lib/actions"
import type { WorkspaceDock } from "@/components/workspace/dock-context"
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
  ProjectPage,
  ProjectsPage,
  StartPage,
  ThemePage,
} from "./choice-pages"
import { RootPage } from "./root-page"
import { AutomationActivityPage, RunAutomationPage } from "./automation-pages"
import { SearchPage } from "./search-page"
import { PaletteRowsProvider, Row, toMenuItems, type PaletteGroup } from "./list"

export { PaletteContext, usePalette } from "./context"

const NO_GROUPS: PaletteGroup[] = []

/** Open state + the ⌘K binding, so the shell only has to render the palette.

    `openAt` is the door for the chords that are *about* one of the pages —
    change model, change project. They are the palette opened somewhere other
    than the root, not a second surface: a chooser the keyboard can reach and a
    chooser the palette can reach have to be one list, or the rows drift. */
export function useCommandPalette() {
  const [open, setOpenState] = React.useState(false)
  const [at, setAt] = React.useState<PageId>("root")

  /* Every ordinary open is the root's, whoever asked — the header button, ⌘K,
     a row. Only `openAt` says otherwise, and it says so for one open. */
  const setOpen = React.useCallback((next: boolean) => {
    if (next) setAt("root")
    setOpenState(next)
  }, [])

  useShortcut("palette", () => {
    setAt("root")
    setOpenState((previous) => !previous)
  })

  const openAt = React.useCallback((page: PageId) => {
    setAt(page)
    setOpenState(true)
  }, [])

  return { open, setOpen, openAt, initialPage: at }
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
  onViewOptions,
  initialPage = "root",
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
  /** The layout-options dialog, app-shell's for the same reason the sheet is. */
  onViewOptions: () => void
  /** Which page an open lands on. `root` for every ordinary ⌘K; a page for the
      chords that name one (see `useCommandPalette`). */
  initialPage?: PageId
}) {
  const [stack, setStack] = React.useState<PageId[]>(["root"])
  const [query, setQuery] = React.useState("")
  const [askText, setAskText] = React.useState("")
  const page = stack[stack.length - 1]
  const nested = stack.length > 1

  /* Every open starts where the opener said, with an empty query — a palette
     that remembers where *you* left it is a palette you have to read before
     using, and one that ignores the chord you pressed is a chord that lies.
     A page below the root keeps its back chip, so ⌥M is still one Escape away
     from the command list. */
  React.useEffect(() => {
    if (open) {
      setStack(initialPage === "root" ? ["root"] : ["root", initialPage])
      setQuery("")
      setAskText("")
    }
  }, [open, initialPage])

  const back = React.useCallback(() => {
    setStack((previous) => (previous.length > 1 ? previous.slice(0, -1) : previous))
    setQuery("")
  }, [])

  const descend = React.useCallback((next: PageId, opts?: { query?: string; askText?: string }) => {
    setStack((previous) => [...previous, next])
    setQuery(opts?.query ?? "")
    if (opts?.askText !== undefined) setAskText(opts.askText)
  }, [])

  const close = React.useCallback(() => onOpenChange(false), [onOpenChange])
  const run = React.useCallback(
    (fn: () => void) => {
      onOpenChange(false)
      fn()
    },
    [onOpenChange]
  )

  /* Memoized, and load-bearing — see the header. Every field is either state
     the pages are meant to follow or a callback that is stable on its own. */
  const palette: Palette = React.useMemo(
    () => ({
      page,
      query,
      setQuery,
      askText,
      close,
      run,
      descend,
      back,
      actions,
      dock,
      newThread: onNewThread,
      newProject: onNewProject,
      importThreads: onImportThreads,
      showShortcuts: onShortcuts,
      showViewOptions: onViewOptions,
    }),
    [
      page,
      query,
      askText,
      close,
      run,
      descend,
      back,
      actions,
      dock,
      onNewThread,
      onNewProject,
      onImportThreads,
      onShortcuts,
      onViewOptions,
    ]
  )

  /* The rows the page in front published, stamped with the page that published
     them. Read through a ref so `publish` itself never changes identity — it is
     a context value, and a new one on every keystroke would re-render every
     page through the memo that exists to stop exactly that. */
  const pageRef = React.useRef(page)
  pageRef.current = page
  const [published, setPublished] = React.useState<{ page: PageId; groups: PaletteGroup[] }>({
    page: "root",
    groups: NO_GROUPS,
  })
  const publish = React.useCallback((groups: PaletteGroup[]) => {
    setPublished({ page: pageRef.current, groups })
  }, [])

  const groups = published.page === page ? published.groups : NO_GROUPS
  const items = React.useMemo(() => toMenuItems(groups), [groups])
  const byId = React.useMemo(
    () => new Map(groups.flatMap((group) => group.items).map((item) => [item.id, item])),
    [groups]
  )

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
    /* The menu's own dialog shell. `shortcut={null}` because ⌘K is the app's,
       bound once in `useCommandPalette` through the rebindable table in
       `lib/keybindings.ts` — a second listener inside the component would be a
       chord nothing lists and nobody can move. */
    <CommandMenuDialog
      open={open}
      onOpenChange={onOpenChange}
      shortcut={null}
      title="Command Palette"
      description="Search for a command to run."
      /* Height belongs to the panel and not to the list: `CommandMenuList`
         puts its className on the row container *inside* its own scroller,
         where a max-height clips instead of scrolling. Everything between the
         panel and the rows is `flex-1 min-h-0`, so the list takes what is left
         under the field and over the footer.

         The panel's own cap (`min(440px,76dvh)`, top-anchored) is the shell's
         and is left alone — all that is added is the soft keyboard, which it
         cannot know about: the page does not resize when one opens
         (`overlays-content`), so `dvh` still reports the whole screen and the
         foot of the list would sit behind the keys.

         ponytail: one term, not the panel's full geometry re-derived here.
         Subtracting the inset from the cap moves the foot up by exactly the
         keyboard, which clears it for every viewport the 12dvh top applies to
         — i.e. every phone. A viewport over ~846px tall takes the panel's
         other top (`50dvh-220px`) and would need the top in the arithmetic
         too; that is a tablet with a keyboard open, and the fix is to read the
         top from a shared variable rather than to spell 220px twice. */
      className="flex flex-col sm:max-w-xl max-h-[min(440px,76dvh,calc(76dvh_-_var(--keyboard-inset,0px)))]"
    >
      <PaletteContext.Provider value={palette}>
        <PaletteRowsProvider value={publish}>
          <div
            onKeyDownCapture={onKeyDownCapture}
            className="flex min-h-0 flex-1 flex-col"
          >
            {/* Filtering and ordering are this file's, not the menu's — the
                rows arrive already ranked (see `rank.ts`), and a second filter
                over them would drop the rows that are *about* the query. */}
            <CommandMenu
              items={items}
              filter={RANKED_HERE}
              query={query}
              onQueryChange={setQuery}
              /* A row closes the palette by calling `palette.run`, and a row
                 that descends must leave it open — so the shell decides, never
                 the menu. */
              closeOnSelect={false}
              className="flex min-h-0 flex-1 flex-col"
            >
              <CommandMenuInput autoFocus className="text-base md:text-sm" placeholder={PAGE_PLACEHOLDER[page]} />

              {/* Where the page stack is said. The menu's field takes an icon
                  and not a prefix slot, so the chip is its own row under it —
                  which is also where it stops competing with the caret. */}
              {nested && (
                <div className="flex items-center gap-2 px-3 pb-2">
                  <Button
                    variant="secondary"
                    size="xs"
                    // Keeps the caret in the box: a chip that steals focus would
                    // leave the next keystroke going nowhere.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={back}
                    className="text-muted-foreground"
                  >
                    <ArrowLeft />
                    {PAGE_LABEL[page]}
                  </Button>
                </div>
              )}

              <CommandMenuList
                renderItem={(data) => {
                  const item = byId.get(data.value)
                  return item ? <Row item={item} /> : null
                }}
              >
                {/* The pages that ask the server say their own emptiness, per
                    section and per clock — a single global line cannot tell "no
                    messages" from "still asking". They say it as `note` rows,
                    which are rows, so this never fires under them. */}
                <CommandMenuEmpty>No matches.</CommandMenuEmpty>
              </CommandMenuList>

              <CommandMenuFooter />

              {/* Renders for its hooks and publishes its rows; draws nothing. */}
              <PageBody page={page} />
            </CommandMenu>
          </div>
        </PaletteRowsProvider>
      </PaletteContext.Provider>
    </CommandMenuDialog>
  )
}

/** Hoisted so the identity is stable: the menu resets its highlight when the
    filter changes, which on a fresh arrow function is every keystroke. */
const RANKED_HERE = () => true

/* Memoized on the page id alone — see the header. It reads the palette from
   context, which is memoized for the same reason. */
const PageBody = React.memo(function PageBody({ page }: { page: PageId }) {
  switch (page) {
    case "root":
      return <RootPage />
    case "search":
      return <SearchPage />
    case "thread-search":
      return <SearchPage threadScoped />
    case "projects":
      return <ProjectsPage />
    case "project":
      return <ProjectPage />
    case "start":
      return <StartPage />
    case "theme":
      return <ThemePage />
    case "model":
      return <ModelPage />
    case "effort":
      return <EffortPage />
    case "mode":
      return <ModePage />
    case "automations":
      return <RunAutomationPage />
    case "automation-activity":
      return <AutomationActivityPage />
  }
})
