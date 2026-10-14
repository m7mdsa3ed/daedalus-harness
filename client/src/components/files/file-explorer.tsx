/* ── The file library as a file explorer ──
   A folder tree beside the folder you are in, an address bar and back/forward/
   up, list and grid views, a details pane, and search across the whole library.
   It behaves like a desktop explorer because that is what hands already know:
   click selects, ⌘/Ctrl-click toggles, Shift-click and Shift-arrows extend,
   double-click or Enter opens, Space previews, F2 renames, Delete deletes,
   ⌘C/⌘X/⌘V copy, cut and paste, Backspace or Alt+↑ goes up, Alt+←/→ walk
   history, typing jumps to a name. Right-click is the same verbs as a menu.
   Dragging rows onto a folder (in the listing, the tree or the address bar)
   moves them, with Alt/Ctrl held copies them; files or whole folders dropped
   from the desktop upload into wherever they land.

   `pick` mode (`onPick`) is the same explorer choosing files: the picker
   dialog behind the composer's "From library" (`multiple` — click, ⌘/Ctrl-
   and Shift-click select as they do anywhere else) and every logo field's
   Upload (one file).
   A file that does not match `accept` is drawn but cannot be chosen.

   The pieces: `file-tree.tsx` (folders), `file-items.tsx` (list and grid),
   `file-preview.tsx` (the preview panel — in the details pane, across the
   whole explorer, or full screen — and the details). State lives here. */
import * as React from "react"
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  ChevronRightIcon,
  ClipboardPasteIcon,
  CopyIcon,
  CopyPlusIcon,
  DownloadIcon,
  EyeIcon,
  FolderInputIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  FolderUpIcon,
  LayoutGridIcon,
  LibraryIcon,
  ListIcon,
  PanelLeftIcon,
  PanelRightIcon,
  SlidersHorizontalIcon,
  ZoomInIcon,
  ZoomOutIcon,
  PencilIcon,
  RefreshCwIcon,
  ScissorsIcon,
  SearchIcon,
  SquareCheckIcon,
  Trash2Icon,
  UploadIcon,
  XIcon,
} from "lucide-react"

import { useConfirm } from "@/components/confirm-dialog"
import { Empty } from "@/components/empty"
import { GridView, ListView, useWidth, type ItemHandlers, type ListedItem } from "@/components/files/file-items"
import { FileDetails, PreviewPanel } from "@/components/files/file-preview"
import { FolderTree, type DropProps } from "@/components/files/file-tree"
import { Button } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { Slider } from "@/components/ui/slider"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { useCoarsePointer } from "@/hooks/use-device"
import { formatBytes } from "@/lib/attachments"
import { reportError } from "@/lib/errors"
import {
  entriesFromDrop,
  entriesFromInput,
  explorerPrefs,
  matchesAccept,
  DEFAULT_COLUMN_WIDTHS,
  GRID_SIZES,
  setExplorerPrefs,
  sortFiles,
  useFileActions,
  useFileSearch,
  useFolder,
  useFolderTree,
  type ExplorerPrefs,
  type ColumnId,
  type FileRecord,
  type FolderNode,
  type ListColumn,
  type SortKey,
  type UploadEntry,
} from "@/lib/files"
import { cn } from "@/lib/utils"

const DRAG_TYPE = "application/x-daedalus-files"
const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl+"
const SORTS: { key: SortKey; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "updatedAt", label: "Date modified" },
  { key: "size", label: "Size" },
  { key: "kind", label: "Kind" },
]

type Nav = { back: (string | null)[]; cwd: string | null; fwd: (string | null)[] }
type Clipboard = { mode: "cut" | "copy"; items: FileRecord[] }

const setPrefs = setExplorerPrefs
const LIST_COLUMNS: { id: ListColumn; label: string }[] = [
  { id: "updatedAt", label: "Modified" },
  { id: "kind", label: "Kind" },
  { id: "size", label: "Size" },
]
/** Below these explorer widths a side pane is not drawn, whatever its toggle says. */
const TREE_MIN_WIDTH = 640
const INFO_MIN_WIDTH = 820
const zoomGrid = (by: number) => {
  const { gridSize } = explorerPrefs.get()
  setPrefs({ gridSize: Math.min(GRID_SIZES.max, Math.max(GRID_SIZES.min, gridSize + by)) })
}

export function FileExplorer({
  accept,
  onPick,
  multiple = false,
  onCancel,
  pickLabel = "Choose",
  className,
}: {
  /** An `<input accept>` list. Files that do not match are drawn but not pickable. */
  accept?: string
  /** Present = pick mode: choosing calls this with the chosen files (folders never). */
  onPick?: (files: FileRecord[]) => void
  /** Pick mode chooses several at once; without it selection is single. */
  multiple?: boolean
  /** Pick mode's Cancel, beside its Choose. */
  onCancel?: () => void
  pickLabel?: string
  className?: string
}) {
  const actions = useFileActions()
  const confirm = useConfirm()
  /** Pick mode choosing one: every multi-select gesture is off. */
  const singlePick = !!onPick && !multiple
  const coarse = useCoarsePointer()
  const prefs = explorerPrefs.use()
  const uid = React.useId()
  const pane = React.useRef<HTMLDivElement>(null)
  const fileInput = React.useRef<HTMLInputElement>(null)
  const folderInput = React.useRef<HTMLInputElement>(null)
  const searchInput = React.useRef<HTMLInputElement>(null)

  const [nav, setNav] = React.useState<Nav>({ back: [], cwd: null, fwd: [] })
  const [query, setQuery] = React.useState("")
  const [debounced, setDebounced] = React.useState("")
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set())
  const [anchor, setAnchor] = React.useState<string | null>(null)
  const [focusId, setFocusId] = React.useState<string | null>(null)
  const [renamingId, setRenamingId] = React.useState<string | null>(null)
  const [clipboard, setClipboard] = React.useState<Clipboard | null>(null)
  const [dropTarget, setDropTarget] = React.useState<string | null>(null)
  const [uploading, setUploading] = React.useState<{ done: number; total: number } | null>(null)
  /** The preview taken across the whole explorer rather than the side pane. */
  const [wide, setWide] = React.useState(false)
  const [destination, setDestination] = React.useState<{ mode: "move" | "copy"; items: FileRecord[] } | null>(null)

  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 200)
    return () => clearTimeout(t)
  }, [query])

  const listing = useFolder(nav.cwd)
  const tree = useFolderTree()
  const search = useFileSearch(debounced)
  const searching = debounced.trim().length > 0
  const folders = React.useMemo(() => tree.data?.folders ?? [], [tree.data])
  const path = listing.data?.path ?? []
  const folderName = path.at(-1)?.name ?? "Library"

  const items: ListedItem[] = React.useMemo(
    () => sortFiles((searching ? search.data?.items : listing.data?.items) ?? [], prefs.sort, prefs.desc, prefs.foldersFirst),
    [searching, search.data, listing.data, prefs.sort, prefs.desc, prefs.foldersFirst]
  )
  const pending = searching ? search.isPending : listing.isPending
  const selectedItems = React.useMemo(() => items.filter((item) => selected.has(item.id)), [items, selected])
  const files = React.useMemo(() => items.filter((item) => item.kind === "file"), [items])
  const cutIds = React.useMemo(
    () => new Set(clipboard?.mode === "cut" ? clipboard.items.map((item) => item.id) : []),
    [clipboard]
  )
  const pickable = React.useCallback(
    (item: ListedItem) => item.kind === "file" && matchesAccept(item, accept),
    [accept]
  )
  const domId = React.useCallback((id: string) => `${uid}-${id}`, [uid])

  /* A folder that disappeared under us (deleted elsewhere) sends us home. */
  React.useEffect(() => {
    if (nav.cwd && listing.error) setNav((n) => ({ back: [], cwd: null, fwd: n.fwd }))
  }, [listing.error, nav.cwd])

  /* Selection follows the listing: what left it is unselected. Only once the
     listing is in, or a navigation's empty first frame would clear a reveal. */
  React.useEffect(() => {
    if (pending) return
    const present = new Set(items.map((item) => item.id))
    setSelected((prev) => ([...prev].every((id) => present.has(id)) ? prev : new Set([...prev].filter((id) => present.has(id)))))
    setFocusId((id) => (id && !present.has(id) ? null : id))
  }, [items, pending])

  React.useEffect(() => {
    if (focusId) document.getElementById(domId(focusId))?.scrollIntoView({ block: "nearest" })
  }, [focusId, domId])

  /* What fits beside the listing is measured on the explorer itself — a
     picker dialog and a settings page are different widths of the same thing. */
  const [root, rootWidth] = useWidth<HTMLDivElement>()
  const showTree = prefs.tree && rootWidth >= TREE_MIN_WIDTH
  const showInfo = prefs.info && rootWidth >= INFO_MIN_WIDTH
  /** Pane widths as dragged; kept when a divider is let go. */
  const paneWidths = React.useRef({ tree: prefs.treeWidth, info: prefs.infoWidth })

  /* ⌘/Ctrl + wheel sizes the grid's tiles. A native listener, because React's
     wheel listener is passive and could not stop the browser zooming the page. */
  React.useEffect(() => {
    const el = pane.current
    if (!el || prefs.view !== "grid") return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      zoomGrid(e.deltaY < 0 ? GRID_SIZES.step : -GRID_SIZES.step)
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [prefs.view])

  /* ── Navigation ── */
  const go = (id: string | null, reveal?: string) => {
    setQuery("")
    setDebounced("")
    setRenamingId(null)
    setSelected(new Set(reveal ? [reveal] : []))
    setAnchor(reveal ?? null)
    setFocusId(reveal ?? null)
    setNav((n) => (id === n.cwd ? n : { back: [...n.back, n.cwd], cwd: id, fwd: [] }))
  }
  const back = () =>
    setNav((n) => (n.back.length ? { back: n.back.slice(0, -1), cwd: n.back.at(-1)!, fwd: [n.cwd, ...n.fwd] } : n))
  const forward = () =>
    setNav((n) => (n.fwd.length ? { back: [...n.back, n.cwd], cwd: n.fwd[0], fwd: n.fwd.slice(1) } : n))
  const up = () => nav.cwd && go(path.at(-2)?.id ?? null, nav.cwd)

  /* ── Writes ── */
  const fail = (what: string) => (err: unknown) => void reportError(err, what)

  const upload = (entries: UploadEntry[], parentId: string | null) => {
    if (entries.length === 0) return
    setUploading({ done: 0, total: entries.length })
    void actions
      .uploadEntries(entries, parentId, (done) => setUploading({ done, total: entries.length }))
      .catch(fail("Couldn't upload everything"))
      .finally(() => setUploading(null))
  }
  const newFolder = async () => {
    try {
      const folder = await actions.makeFolder(nav.cwd, "New folder")
      if (searching) go(nav.cwd)
      setSelected(new Set([folder.id]))
      setFocusId(folder.id)
      setRenamingId(folder.id)
    } catch (err) {
      reportError(err, "Couldn't create that folder")
    }
  }
  const remove = async (targets: FileRecord[]) => {
    if (targets.length === 0) return
    const one = targets.length === 1 ? targets[0] : null
    const ok = await confirm({
      title: one ? `Delete “${one.name}”?` : `Delete ${targets.length} items?`,
      description: targets.some((t) => t.kind === "folder")
        ? "Folders are deleted with everything inside them. This cannot be undone."
        : "This cannot be undone.",
      confirmLabel: "Delete",
      destructive: true,
    })
    if (ok) await actions.remove(targets.map((t) => t.id)).catch(fail("Couldn't delete everything"))
    pane.current?.focus()
  }
  const rename = (item: ListedItem, name: string | null) => {
    setRenamingId(null)
    pane.current?.focus()
    const next = name?.trim()
    if (next && next !== item.name) void actions.rename(item.id, next).catch(fail("Couldn't rename that"))
  }
  const paste = (into: string | null) => {
    if (!clipboard) return
    const ids = clipboard.items.map((item) => item.id)
    if (clipboard.mode === "cut") {
      void actions.move(ids, into).catch(fail("Couldn't move everything"))
      setClipboard(null)
    } else {
      void actions.copy(ids, into).catch(fail("Couldn't copy everything"))
    }
  }
  const download = (targets: FileRecord[]) => {
    void (async () => {
      for (const file of targets.filter((t) => t.kind === "file")) await actions.download(file)
    })().catch(fail("Couldn't download that"))
  }
  /** What a pick would hand over: the selection's pickable files, never a folder —
      one at most when choosing one. */
  const chosenOf = (from: ListedItem[]) => from.filter(pickable).slice(0, multiple ? undefined : 1)
  const open = (item: ListedItem) => {
    if (item.kind === "folder") return go(item.id)
    if (!onPick) {
      selectOnly(item.id)
      return setWide(true)
    }
    if (!pickable(item)) return
    /* Opening one of several selected files chooses all of them. */
    onPick(multiple && selected.has(item.id) ? chosenOf(selectedItems) : [item])
  }

  /* ── Selection ── */
  const selectOnly = (id: string) => {
    setSelected(new Set([id]))
    setAnchor(id)
    setFocusId(id)
  }
  const selectRange = (from: string | null, to: string) => {
    const a = items.findIndex((item) => item.id === (from ?? to))
    const b = items.findIndex((item) => item.id === to)
    const [lo, hi] = a < b ? [a, b] : [b, a]
    setSelected(new Set(items.slice(Math.max(lo, 0), hi + 1).map((item) => item.id)))
    setFocusId(to)
  }
  const onPointer = (e: React.MouseEvent, item: ListedItem) => {
    if (renamingId) return
    pane.current?.focus({ preventScroll: true })
    /* Touch has no double-click: a tap opens a folder, previews a file. */
    if (coarse && (item.kind === "folder" || !onPick)) return open(item)
    /* …and no modifier keys: choosing several on touch is a tap per file. */
    const toggle = coarse && multiple
    if (singlePick || (!toggle && !e.shiftKey && !e.metaKey && !e.ctrlKey)) return selectOnly(item.id)
    if (e.shiftKey) return selectRange(anchor, item.id)
    setSelected((prev) => {
      const next = new Set(prev)
      if (!next.delete(item.id)) next.add(item.id)
      return next
    })
    setAnchor(item.id)
    setFocusId(item.id)
  }

  /* ── Drag and drop ── */
  const dragProps = (item: ListedItem): React.HTMLAttributes<HTMLElement> & { draggable?: boolean } => ({
    draggable: !onPick && renamingId !== item.id && !coarse,
    onDragStart: (e) => {
      const ids = selected.has(item.id) ? [...selected] : [item.id]
      if (!selected.has(item.id)) selectOnly(item.id)
      e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids))
      e.dataTransfer.effectAllowed = "copyMove"
    },
    onDragEnd: () => setDropTarget(null),
  })
  const dropFor = (folderId: string | null, key = folderId ?? "@root") => ({
    "data-drop": dropTarget === key || undefined,
    onDragOver: (e: React.DragEvent) => {
      const internal = e.dataTransfer.types.includes(DRAG_TYPE)
      if (!internal && !e.dataTransfer.types.includes("Files")) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = !internal || e.altKey || e.ctrlKey ? "copy" : "move"
      if (dropTarget !== key) setDropTarget(key)
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget((t) => (t === key ? null : t))
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setDropTarget(null)
      const moved = e.dataTransfer.getData(DRAG_TYPE)
      if (moved) {
        const ids = (JSON.parse(moved) as string[]).filter((id) => id !== folderId)
        if (e.altKey || e.ctrlKey) void actions.copy(ids, folderId).catch(fail("Couldn't copy everything"))
        else void actions.move(ids, folderId).catch(fail("Couldn't move everything"))
      } else {
        void entriesFromDrop(e.dataTransfer).then((entries) => upload(entries, folderId), fail("Couldn't read what was dropped"))
      }
    },
  })
  const dropProps: DropProps = (folderId) => dropFor(folderId)

  /* ── Keyboard ── */
  const typeahead = React.useRef({ text: "", at: 0 })
  const gridColumns = () => {
    const grid = pane.current?.querySelector<HTMLElement>("[data-grid]")
    return grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : 1
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (renamingId || e.target !== pane.current) return
    const mod = e.metaKey || e.ctrlKey
    const index = items.findIndex((item) => item.id === focusId)
    const focused = index >= 0 ? items[index] : undefined
    const step = (to: number) => {
      const next = items[Math.max(0, Math.min(items.length - 1, to))]
      if (!next) return
      e.preventDefault()
      if (e.shiftKey && !singlePick) selectRange(anchor ?? focusId, next.id)
      else if (mod && !singlePick) setFocusId(next.id)
      else selectOnly(next.id)
    }
    const cols = prefs.view === "grid" ? gridColumns() : 1
    const targets = selectedItems.length ? selectedItems : focused ? [focused] : []
    switch (true) {
      case e.key === "ArrowDown" && !e.altKey:
        return step(index < 0 ? 0 : index + cols)
      case e.key === "ArrowUp" && e.altKey:
        e.preventDefault()
        return up()
      case e.key === "ArrowUp":
        return step(index < 0 ? 0 : index - cols)
      case e.key === "ArrowLeft" && e.altKey:
        e.preventDefault()
        return back()
      case e.key === "ArrowRight" && e.altKey:
        e.preventDefault()
        return forward()
      case e.key === "ArrowRight" && cols > 1:
        return step(index + 1)
      case e.key === "ArrowLeft" && cols > 1:
        return step(index - 1)
      case e.key === "Home":
        return step(0)
      case e.key === "End":
        return step(items.length - 1)
      case e.key === "PageDown":
        return step(index + cols * 10)
      case e.key === "PageUp":
        return step(index - cols * 10)
      case e.key === "Enter" && !!focused:
        e.preventDefault()
        return open(focused!)
      case e.key === " " && !!focused:
        e.preventDefault()
        /* Space is Quick Look: the focused file across the whole explorer. */
        if (focused!.kind === "file") {
          selectOnly(focused!.id)
          setWide(true)
        } else if (!selected.has(focused!.id)) selectOnly(focused!.id)
        return
      case e.key === "Backspace" && !mod && !searching:
        e.preventDefault()
        return up()
      case (e.key === "Delete" || (e.key === "Backspace" && mod)) && !onPick:
        e.preventDefault()
        return void remove(targets)
      case e.key === "F2" && !!focused:
        e.preventDefault()
        return setRenamingId(focused!.id)
      case mod && e.key.toLowerCase() === "a" && !singlePick:
        e.preventDefault()
        return setSelected(new Set(items.map((item) => item.id)))
      case mod && e.key.toLowerCase() === "c" && targets.length > 0:
        e.preventDefault()
        return setClipboard({ mode: "copy", items: targets })
      case mod && e.key.toLowerCase() === "x" && targets.length > 0 && !onPick:
        e.preventDefault()
        return setClipboard({ mode: "cut", items: targets })
      case mod && e.key.toLowerCase() === "v" && !searching:
        e.preventDefault()
        return paste(nav.cwd)
      case mod && (e.key === "=" || e.key === "+") && prefs.view === "grid":
        e.preventDefault()
        return zoomGrid(GRID_SIZES.step * 2)
      case mod && e.key === "-" && prefs.view === "grid":
        e.preventDefault()
        return zoomGrid(-GRID_SIZES.step * 2)
      case mod && e.key.toLowerCase() === "f":
        e.preventDefault()
        return searchInput.current?.focus()
      case e.key === "Escape":
        if (clipboard) setClipboard(null)
        else if (selected.size) setSelected(new Set())
        else if (query) setQuery("")
        else return // let a dialog around us close
        e.stopPropagation()
        return
      case e.key.length === 1 && !mod && !e.altKey: {
        /* Type-ahead: letters typed in quick succession jump to the first name
           starting with them; one letter repeated cycles through its names. */
        const now = Date.now()
        const t = typeahead.current
        t.text = now - t.at < 700 ? t.text + e.key.toLowerCase() : e.key.toLowerCase()
        t.at = now
        const cycling = t.text.length > 1 && [...t.text].every((c) => c === t.text[0])
        const needle = cycling ? t.text[0] : t.text
        const start = cycling || t.text.length === 1 ? index + 1 : Math.max(index, 0)
        const order = [...items.slice(start), ...items.slice(0, start)]
        const hit = order.find((item) => item.name.toLowerCase().startsWith(needle))
        if (hit) {
          e.preventDefault()
          selectOnly(hit.id)
        }
        return
      }
    }
  }

  const handlers: ItemHandlers = {
    selected,
    focusId,
    cutIds,
    renamingId,
    isPickable: (item) => !onPick || item.kind === "folder" || pickable(item),
    onPointer,
    onOpen: (item) => !coarse && open(item),
    onContext: (item) => {
      if (!selected.has(item.id)) selectOnly(item.id)
      else setFocusId(item.id)
    },
    onRename: rename,
    dragProps,
    dropProps,
    domId,
  }

  const single = selectedItems.length === 1 ? selectedItems[0] : null
  const chosen = chosenOf(selectedItems)
  const chooseText = chosen.length > 1 ? `${pickLabel} ${chosen.length} files` : pickLabel
  const paneDrop = searching ? {} : dropFor(nav.cwd, "@pane")

  /* ── The verbs, as a menu (right-click) ── */
  const menu =
    selectedItems.length > 0 ? (
      <>
        {single && (
          <ContextMenuItem onClick={() => open(single)}>
            <FolderOpenIcon /> {single.kind === "folder" ? "Open" : onPick ? pickLabel : "Preview"}
            <ContextMenuShortcut>{single.kind === "file" && !onPick ? "Space" : "Enter"}</ContextMenuShortcut>
          </ContextMenuItem>
        )}
        {multiple && chosen.length > 1 && (
          <ContextMenuItem onClick={() => onPick?.(chosen)}>
            <SquareCheckIcon /> {pickLabel} {chosen.length} files
          </ContextMenuItem>
        )}
        {single?.kind === "file" && onPick && (
          <ContextMenuItem onClick={() => setWide(true)}>
            <EyeIcon /> Preview <ContextMenuShortcut>Space</ContextMenuShortcut>
          </ContextMenuItem>
        )}
        {searching && single && (
          <ContextMenuItem onClick={() => go(single.parentId, single.id)}>
            <FolderUpIcon /> Show in folder
          </ContextMenuItem>
        )}
        {selectedItems.some((item) => item.kind === "file") && (
          <ContextMenuItem onClick={() => download(selectedItems)}>
            <DownloadIcon /> Download
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        {!onPick && (
          <ContextMenuItem onClick={() => setClipboard({ mode: "cut", items: selectedItems })}>
            <ScissorsIcon /> Cut <ContextMenuShortcut>{MOD}X</ContextMenuShortcut>
          </ContextMenuItem>
        )}
        <ContextMenuItem onClick={() => setClipboard({ mode: "copy", items: selectedItems })}>
          <CopyIcon /> Copy <ContextMenuShortcut>{MOD}C</ContextMenuShortcut>
        </ContextMenuItem>
        {single?.kind === "folder" && clipboard && (
          <ContextMenuItem onClick={() => paste(single.id)}>
            <ClipboardPasteIcon /> Paste into folder
          </ContextMenuItem>
        )}
        <ContextMenuItem
          onClick={() =>
            void actions
              .copy(
                selectedItems.map((item) => item.id),
                selectedItems[0].parentId
              )
              .catch(fail("Couldn't duplicate everything"))
          }
        >
          <CopyPlusIcon /> Duplicate
        </ContextMenuItem>
        {!onPick && (
          <ContextMenuItem onClick={() => setDestination({ mode: "move", items: selectedItems })}>
            <FolderInputIcon /> Move to…
          </ContextMenuItem>
        )}
        <ContextMenuItem onClick={() => setDestination({ mode: "copy", items: selectedItems })}>
          <FolderInputIcon /> Copy to…
        </ContextMenuItem>
        {single && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => setRenamingId(single.id)}>
              <PencilIcon /> Rename <ContextMenuShortcut>F2</ContextMenuShortcut>
            </ContextMenuItem>
          </>
        )}
        {!onPick && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onClick={() => void remove(selectedItems)}>
              <Trash2Icon /> Delete
              {selectedItems.length > 1 ? ` ${selectedItems.length} items` : ""}
              <ContextMenuShortcut>Del</ContextMenuShortcut>
            </ContextMenuItem>
          </>
        )}
      </>
    ) : (
      <>
        <ContextMenuItem disabled={searching} onClick={() => void newFolder()}>
          <FolderPlusIcon /> New folder
        </ContextMenuItem>
        <ContextMenuItem disabled={searching} onClick={() => fileInput.current?.click()}>
          <UploadIcon /> Upload files…
        </ContextMenuItem>
        <ContextMenuItem disabled={searching} onClick={() => folderInput.current?.click()}>
          <FolderUpIcon /> Upload a folder…
        </ContextMenuItem>
        <ContextMenuItem disabled={!clipboard || searching} onClick={() => paste(nav.cwd)}>
          <ClipboardPasteIcon /> Paste{clipboard ? ` ${clipboard.items.length} ${clipboard.items.length === 1 ? "item" : "items"}` : ""}
          <ContextMenuShortcut>{MOD}V</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        {!singlePick && (
          <ContextMenuItem disabled={items.length === 0} onClick={() => setSelected(new Set(items.map((item) => item.id)))}>
            <SquareCheckIcon /> Select all <ContextMenuShortcut>{MOD}A</ContextMenuShortcut>
          </ContextMenuItem>
        )}
        <ContextMenuItem onClick={() => setPrefs({ view: prefs.view === "list" ? "grid" : "list" })}>
          {prefs.view === "list" ? <LayoutGridIcon /> : <ListIcon />} {prefs.view === "list" ? "Show as grid" : "Show as list"}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => void actions.refresh()}>
          <RefreshCwIcon /> Refresh
        </ContextMenuItem>
      </>
    )

  /* The verbs for what is selected, under the details or the preview. */
  const selectionActions = selectedItems.length > 0 && (
    <div className="flex flex-wrap gap-1.5">
      {onPick && chosen.length > 0 ? (
        <Button type="button" size="sm" onClick={() => onPick(chosen)}>
          {chooseText}
        </Button>
      ) : single?.kind === "folder" ? (
        <Button type="button" size="sm" variant="outline" onClick={() => go(single.id)}>
          <FolderOpenIcon data-icon="inline-start" /> Open
        </Button>
      ) : null}
      {selectedItems.length > 1 && selectedItems.some((item) => item.kind === "file") && (
        <Button type="button" size="sm" variant="outline" onClick={() => download(selectedItems)}>
          <DownloadIcon data-icon="inline-start" /> Download
        </Button>
      )}
      {single && (
        <Button type="button" size="sm" variant="outline" onClick={() => setRenamingId(single.id)}>
          <PencilIcon data-icon="inline-start" /> Rename
        </Button>
      )}
      {!onPick && (
        <Button type="button" size="sm" variant="outline" className="text-destructive" onClick={() => void remove(selectedItems)}>
          <Trash2Icon data-icon="inline-start" /> Delete
        </Button>
      )}
    </div>
  )
  /* One file selected is one file previewed; anything else is details. */
  const previewed = single?.kind === "file" ? single : null
  const wideOn = wide && previewed !== null
  /* Full width is about one file: when the selection stops being one (it was
     deleted, or Esc cleared it), it ends rather than lying in wait for the next. */
  React.useEffect(() => {
    if (wide && !previewed && !pending) setWide(false)
  }, [wide, previewed, pending])
  const previewPanel = (size: "pane" | "wide") =>
    previewed && (
      <PreviewPanel
        file={previewed}
        files={files}
        size={size}
        onSize={(next) => {
          setWide(next === "wide")
          if (next === "pane") requestAnimationFrame(() => pane.current?.focus({ preventScroll: true }))
        }}
        onStep={(file) => selectOnly(file.id)}
        onDownload={(file) => download([file])}
        location={searching ? (previewed as ListedItem).path : undefined}
        actions={selectionActions}
      />
    )

  const totalSize = selectedItems.reduce((sum, item) => sum + (item.kind === "file" ? item.size : 0), 0)

  return (
    <div ref={root} className={cn("@container flex min-h-0 flex-col overflow-hidden rounded-xl border bg-background", className)}>
      {/* ── Toolbar ── */}
      <div className="flex flex-wrap items-center gap-1 border-b px-2 py-1.5">
        <Button type="button" variant="ghost" size="icon-sm" title="Back (Alt+←)" disabled={!nav.back.length} onClick={back}>
          <ArrowLeftIcon />
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" title="Forward (Alt+→)" disabled={!nav.fwd.length} onClick={forward}>
          <ArrowRightIcon />
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" title="Up a folder (Alt+↑)" disabled={!nav.cwd} onClick={up}>
          <ArrowUpIcon />
        </Button>
        <div className="mx-1 h-5 w-px bg-border" />
        <Button type="button" variant="ghost" size="sm" title="New folder" disabled={searching} onClick={() => void newFolder()}>
          <FolderPlusIcon data-icon="inline-start" /> <span className="hidden @panel-sm:inline">New folder</span>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button type="button" size="sm" disabled={searching} />}>
            <UploadIcon data-icon="inline-start" /> Upload
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => fileInput.current?.click()}>
              <UploadIcon /> Files…
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => folderInput.current?.click()}>
              <FolderUpIcon /> A folder…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="flex-1" />
        <div className="relative order-last w-full @min-[34rem]:order-none @min-[34rem]:w-56">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchInput}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.stopPropagation()
                setQuery("")
              }
              if (e.key === "ArrowDown") {
                e.preventDefault()
                pane.current?.focus()
              }
            }}
            placeholder="Search the library"
            aria-label="Search the library"
            className="h-8 pr-7 pl-8 text-sm"
          />
          {query && (
            <button
              type="button"
              title="Clear search"
              onClick={() => setQuery("")}
              className="absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            >
              <XIcon className="size-3.5" />
            </button>
          )}
        </div>
        {/* The view, as two toggles rather than a menu: it is changed often. */}
        <div role="radiogroup" aria-label="View" className="flex items-center rounded-md bg-muted p-0.5">
          {(
            [
              ["list", ListIcon, "List"],
              ["grid", LayoutGridIcon, "Grid"],
            ] as const
          ).map(([view, Icon, label]) => (
            <button
              key={view}
              type="button"
              role="radio"
              aria-checked={prefs.view === view}
              title={`${label} view`}
              onClick={() => setPrefs({ view })}
              className={cn(
                "flex size-7 items-center justify-center rounded",
                prefs.view === view ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Icon className="size-4" />
            </button>
          ))}
        </div>
        {prefs.view === "grid" && (
          <div className="hidden items-center gap-1.5 px-1 @min-[40rem]:flex" title={`Tile size (${MOD}+scroll, ${MOD}= / ${MOD}−)`}>
            <button type="button" tabIndex={-1} aria-label="Smaller tiles" className="text-muted-foreground hover:text-foreground" onClick={() => zoomGrid(-GRID_SIZES.step * 2)}>
              <ZoomOutIcon className="size-3.5" />
            </button>
            <Slider
              className="w-24"
              aria-label="Tile size"
              min={GRID_SIZES.min}
              max={GRID_SIZES.max}
              step={GRID_SIZES.step}
              value={[prefs.gridSize]}
              onValueChange={(value) => setPrefs({ gridSize: Array.isArray(value) ? value[0] : (value as number) })}
            />
            <button type="button" tabIndex={-1} aria-label="Larger tiles" className="text-muted-foreground hover:text-foreground" onClick={() => zoomGrid(GRID_SIZES.step * 2)}>
              <ZoomInIcon className="size-3.5" />
            </button>
          </div>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon-sm" title="View options" />}>
            <SlidersHorizontalIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>Sort by</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={prefs.sort} onValueChange={(sort) => setPrefs({ sort: sort as SortKey })}>
              {SORTS.map((s) => (
                <DropdownMenuRadioItem key={s.key} value={s.key}>
                  {s.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuCheckboxItem checked={prefs.desc} onCheckedChange={(desc) => setPrefs({ desc })}>
              Descending
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={prefs.foldersFirst} onCheckedChange={(foldersFirst) => setPrefs({ foldersFirst })}>
              Folders first
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Panes</DropdownMenuLabel>
            <DropdownMenuCheckboxItem checked={prefs.tree} onCheckedChange={(tree) => setPrefs({ tree })}>
              Folder tree
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={prefs.info} onCheckedChange={(info) => setPrefs({ info })}>
              Details
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            {prefs.view === "list" ? (
              <>
                <DropdownMenuLabel>List</DropdownMenuLabel>
                <DropdownMenuCheckboxItem checked={prefs.listThumbs} onCheckedChange={(listThumbs) => setPrefs({ listThumbs })}>
                  Image thumbnails
                </DropdownMenuCheckboxItem>
                {LIST_COLUMNS.map((column) => (
                  <DropdownMenuCheckboxItem
                    key={column.id}
                    checked={prefs.columns[column.id]}
                    onCheckedChange={(on) => setPrefs({ columns: { ...prefs.columns, [column.id]: on } })}
                  >
                    {column.label} column
                  </DropdownMenuCheckboxItem>
                ))}
                <DropdownMenuItem onClick={() => setPrefs({ columnWidths: DEFAULT_COLUMN_WIDTHS })}>Reset column widths</DropdownMenuItem>
              </>
            ) : (
              <>
                <DropdownMenuLabel>Grid</DropdownMenuLabel>
                <DropdownMenuCheckboxItem checked={prefs.gridLabels} onCheckedChange={(gridLabels) => setPrefs({ gridLabels })}>
                  Names under tiles
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem checked={prefs.cropThumbs} onCheckedChange={(cropThumbs) => setPrefs({ cropThumbs })}>
                  Fill tiles (crop images)
                </DropdownMenuCheckboxItem>
                <DropdownMenuRadioGroup
                  value={String(prefs.gridSize)}
                  onValueChange={(size) => setPrefs({ gridSize: Number(size) })}
                >
                  {(
                    [
                      [88, "Small tiles"],
                      [120, "Medium tiles"],
                      [176, "Large tiles"],
                      [256, "Extra large tiles"],
                    ] as const
                  ).map(([size, label]) => (
                    <DropdownMenuRadioItem key={size} value={String(size)}>
                      {label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        {rootWidth >= TREE_MIN_WIDTH && (
          <Button
            type="button"
            variant={prefs.tree ? "secondary" : "ghost"}
            size="icon-sm"
            title={prefs.tree ? "Hide the folder tree" : "Show the folder tree"}
            aria-pressed={prefs.tree}
            onClick={() => setPrefs({ tree: !prefs.tree })}
          >
            <PanelLeftIcon />
          </Button>
        )}
        {rootWidth >= INFO_MIN_WIDTH && (
          <Button
            type="button"
            variant={prefs.info ? "secondary" : "ghost"}
            size="icon-sm"
            title={prefs.info ? "Hide details" : "Show details"}
            aria-pressed={prefs.info}
            onClick={() => setPrefs({ info: !prefs.info })}
          >
            <PanelRightIcon />
          </Button>
        )}
      </div>

      {/* ── Address bar ── */}
      <nav aria-label="Folder path" className="flex min-w-0 items-center gap-0.5 border-b bg-muted/30 px-2 py-1 text-sm">
        {searching ? (
          <span className="truncate px-1.5 text-muted-foreground">
            Search results for “{debounced.trim()}” across the library
          </span>
        ) : (
          [{ id: null as string | null, name: "Library" }, ...path].map((step, i, all) => (
            <React.Fragment key={step.id ?? "root"}>
              {i > 0 && <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />}
              <button
                type="button"
                {...dropFor(step.id, `@crumb:${step.id ?? "root"}`)}
                onClick={() => go(step.id)}
                className={cn(
                  "flex min-w-0 shrink items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-muted data-drop:bg-primary/20",
                  i === all.length - 1 ? "font-medium text-foreground" : "text-muted-foreground"
                )}
              >
                {i === 0 && <LibraryIcon className="size-3.5 shrink-0" />}
                <span className="truncate">{step.name}</span>
              </button>
            </React.Fragment>
          ))
        )}
      </nav>

      {/* Full width: the preview takes the whole explorer until Esc or its
          own button gives the panes back (remounted, so they reopen at the
          widths the dividers last left). */}
      {wideOn ? (
        <div className="min-h-0 flex-1">{previewPanel("wide")}</div>
      ) : (
      /* Dividers between the panes drag; their widths are kept per device. */
      <ResizablePanelGroup
        orientation="horizontal"
        className="min-h-0 flex-1"
        onLayoutChanged={(_layout, meta) => {
          if (!meta.isUserInteraction) return
          const { tree: treeWidth, info: infoWidth } = paneWidths.current
          setPrefs({ treeWidth, infoWidth })
        }}
      >
        {/* ── Folder tree ── */}
        {showTree && (
          <>
            <ResizablePanel
              id="tree"
              defaultSize={prefs.treeWidth}
              minSize={140}
              maxSize={480}
              onResize={(size) => (paneWidths.current.tree = Math.round(size.inPixels))}
            >
              <div className="size-full overflow-y-auto p-1.5">
                {tree.isPending ? (
                  <Skeleton className="h-7" />
                ) : (
                  <FolderTree folders={folders} value={searching ? undefined : nav.cwd} onSelect={(id) => go(id)} dropProps={dropProps} />
                )}
              </div>
            </ResizablePanel>
            <ResizableHandle />
          </>
        )}

        {/* ── The listing ── */}
        <ResizablePanel id="main" minSize={240}>
        <ContextMenu>
          <ContextMenuTrigger
            ref={pane}
            tabIndex={0}
            role="listbox"
            aria-label={searching ? "Search results" : `Contents of ${folderName}`}
            aria-multiselectable={!singlePick || undefined}
            aria-activedescendant={focusId ? domId(focusId) : undefined}
            onKeyDown={onKeyDown}
            onFocus={(e) => {
              if (e.target === e.currentTarget && !focusId && items[0]) setFocusId(selectedItems[0]?.id ?? items[0].id)
            }}
            onClick={(e) => {
              if (!(e.target as HTMLElement).closest("[role=option]")) setSelected(new Set())
            }}
            onContextMenu={(e) => {
              if (!(e.target as HTMLElement).closest("[role=option]")) setSelected(new Set())
            }}
            {...paneDrop}
            className={cn(
              "@container relative size-full min-w-0 overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset",
              "data-drop:bg-primary/5"
            )}
          >
            {pending ? (
              <div className="flex flex-col gap-1 p-2">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-7" />
                ))}
              </div>
            ) : (searching ? search.error : listing.error) ? (
              <Empty className="m-3">Couldn’t read this folder.</Empty>
            ) : items.length === 0 ? (
              <Empty className="m-3" icon={searching ? SearchIcon : UploadIcon}>
                {searching
                  ? `Nothing in the library is named like “${debounced.trim()}”.`
                  : "This folder is empty. Drop files or folders here, or use Upload."}
              </Empty>
            ) : prefs.view === "grid" ? (
              <GridView items={items} h={handlers} size={prefs.gridSize} labels={prefs.gridLabels} crop={prefs.cropThumbs} />
            ) : (
              <ListView
                items={items}
                h={handlers}
                sort={prefs.sort}
                desc={prefs.desc}
                columns={[
                  ...(searching ? (["location"] as ColumnId[]) : []),
                  ...LIST_COLUMNS.filter((c) => prefs.columns[c.id]).map((c) => c.id),
                ]}
                widths={prefs.columnWidths}
                onWidths={(columnWidths) => setPrefs({ columnWidths })}
                thumbs={prefs.listThumbs}
                onSort={(sort) => setPrefs(sort === prefs.sort ? { desc: !prefs.desc } : { sort, desc: false })}
              />
            )}
            {dropTarget === "@pane" && (
              <div className="pointer-events-none absolute inset-2 flex items-center justify-center rounded-lg border-2 border-dashed border-primary/50 bg-background/70 text-sm font-medium text-primary">
                Drop into {folderName}
              </div>
            )}
          </ContextMenuTrigger>
          <ContextMenuContent className="w-56">{menu}</ContextMenuContent>
        </ContextMenu>
        </ResizablePanel>

        {/* ── Details ── */}
        {showInfo && (
          <>
          <ResizableHandle />
          <ResizablePanel
            id="info"
            defaultSize={prefs.infoWidth}
            minSize={220}
            maxSize="75"
            onResize={(size) => (paneWidths.current.info = Math.round(size.inPixels))}
          >
          {previewed ? (
            previewPanel("pane")
          ) : (
          <aside aria-label="Details" className="size-full overflow-y-auto">
            <FileDetails
              selected={selectedItems}
              folderName={folderName}
              folderCount={items.length}
              location={searching && single ? (single as ListedItem).path : undefined}
              actions={selectionActions}
            />
          </aside>
          )}
          </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
      )}

      {/* ── Status bar / pick footer ── */}
      <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 border-t bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
        <span className="tabular-nums">
          {items.length} {items.length === 1 ? "item" : "items"}
          {selectedItems.length > 0 &&
            ` · ${selectedItems.length} selected${totalSize ? ` (${formatBytes(totalSize)})` : ""}`}
        </span>
        {uploading && (
          <span className="flex items-center gap-1.5 text-foreground tabular-nums">
            <Spinner className="size-3" /> Uploading {Math.min(uploading.done + 1, uploading.total)} of {uploading.total}…
          </span>
        )}
        {clipboard && (
          <span className="flex items-center gap-1">
            {clipboard.items.length} {clipboard.mode === "cut" ? "cut" : "copied"} — paste with {MOD}V
            <button type="button" title="Clear the clipboard" className="rounded hover:text-foreground" onClick={() => setClipboard(null)}>
              <XIcon className="size-3" />
            </button>
          </span>
        )}
        {onPick && (
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden max-w-48 truncate @panel-sm:inline">
              {chosen.length === 1
                ? chosen[0].name
                : chosen.length > 1
                  ? `${chosen.length} files (${formatBytes(chosen.reduce((sum, f) => sum + f.size, 0))})`
                  : `Choose ${multiple ? "files" : "a file"}${accept ? ` (${accept})` : ""}`}
            </span>
            {onCancel && (
              <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
            )}
            <Button type="button" size="sm" disabled={chosen.length === 0} onClick={() => onPick(chosen)}>
              {chooseText}
            </Button>
          </div>
        )}
      </div>

      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        accept={onPick ? accept : undefined}
        onChange={(e) => {
          if (e.target.files) upload(Array.from(e.target.files, (file) => ({ path: [], file })), nav.cwd)
          e.target.value = ""
        }}
      />
      <input
        ref={folderInput}
        type="file"
        hidden
        {...{ webkitdirectory: "", directory: "" }}
        onChange={(e) => {
          if (e.target.files) upload(entriesFromInput(Array.from(e.target.files)), nav.cwd)
          e.target.value = ""
        }}
      />

      <DestinationDialog
        request={destination}
        folders={folders}
        initial={nav.cwd}
        onClose={() => {
          setDestination(null)
          pane.current?.focus()
        }}
        onConfirm={(mode, ids, into) =>
          void (mode === "move" ? actions.move(ids, into) : actions.copy(ids, into)).catch(
            fail(mode === "move" ? "Couldn't move everything" : "Couldn't copy everything")
          )
        }
      />
    </div>
  )
}

/** "Move to…" / "Copy to…": the folder tree, choosing a destination. A moved
    folder and everything under it are not offered — a folder cannot go inside
    itself. */
function DestinationDialog({
  request,
  folders,
  initial,
  onClose,
  onConfirm,
}: {
  request: { mode: "move" | "copy"; items: FileRecord[] } | null
  folders: FolderNode[]
  initial: string | null
  onClose: () => void
  onConfirm: (mode: "move" | "copy", ids: string[], into: string | null) => void
}) {
  const [into, setInto] = React.useState<string | null>(initial)
  React.useEffect(() => {
    if (request) setInto(initial)
  }, [request, initial])
  const blocked = React.useMemo(
    () => new Set(request?.items.filter((item) => item.kind === "folder").map((item) => item.id) ?? []),
    [request]
  )
  const verb = request?.mode === "copy" ? "Copy" : "Move"
  const count = request?.items.length ?? 0
  return (
    <ResponsiveDialog open={!!request} onOpenChange={(open) => !open && onClose()}>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {verb} {count === 1 ? `“${request?.items[0].name}”` : `${count} items`}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>Choose the folder to {verb.toLowerCase()} into.</ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <div className="max-h-[min(50svh,24rem)] overflow-y-auto rounded-lg border p-1.5">
          <FolderTree folders={folders} value={into} onSelect={setInto} disabled={blocked} />
        </div>
        <ResponsiveDialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              if (request) onConfirm(request.mode, request.items.map((item) => item.id), into)
              onClose()
            }}
          >
            {verb} here
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
