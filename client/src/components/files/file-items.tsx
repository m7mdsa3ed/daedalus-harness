/* ── The listing: list and grid ──
   Pure drawing. Selection, focus, renaming and drag-and-drop are the
   explorer's state; this file only says how an item looks in each view and
   reports what was done to it. Items are `role="option"` inside the
   explorer's listbox, which keeps the focus and points at the focused one with
   `aria-activedescendant` — so no row is a tab stop. */
import * as React from "react"
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react"

import type { DropProps } from "@/components/files/file-tree"
import { mimeIcon } from "@/components/files/mime-icon"
import { Input } from "@/components/ui/input"
import { formatBytes } from "@/lib/attachments"
import {
  COLUMN_WIDTH,
  DEFAULT_COLUMN_WIDTHS,
  formatDate,
  kindLabel,
  useFileBlob,
  type ColumnId,
  type FileRecord,
  type PathStep,
  type SortKey,
} from "@/lib/files"
import { cn } from "@/lib/utils"
import { useWindowedRows } from "@/lib/windowed-rows"

export type ListedItem = FileRecord & { path?: PathStep[] }

export interface ItemHandlers {
  selected: ReadonlySet<string>
  focusId: string | null
  cutIds: ReadonlySet<string>
  renamingId: string | null
  /** The drag source: kept rendered in a windowed listing so its dragend fires. */
  draggingId: string | null
  isPickable: (item: ListedItem) => boolean
  onPointer: (e: React.MouseEvent, item: ListedItem) => void
  onOpen: (item: ListedItem) => void
  onContext: (item: ListedItem) => void
  onRename: (item: ListedItem, name: string | null) => void
  dragProps: (item: ListedItem) => React.HTMLAttributes<HTMLElement>
  dropProps: DropProps
  domId: (id: string) => string
}

/** Thumbnails are the file itself, so a big one is not fetched to draw 7rem of it. */
const THUMB_MAX_BYTES = 4 * 1024 * 1024

function useInView<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = React.useRef<T>(null)
  const [seen, setSeen] = React.useState(false)
  React.useEffect(() => {
    const el = ref.current
    if (!el || seen) return
    const io = new IntersectionObserver(([entry]) => entry.isIntersecting && setSeen(true), { rootMargin: "200px" })
    io.observe(el)
    return () => io.disconnect()
  }, [seen])
  return [ref, seen]
}

function RenameInput({ item, onRename, className }: { item: ListedItem; onRename: ItemHandlers["onRename"]; className?: string }) {
  const done = React.useRef(false)
  const finish = (name: string | null) => {
    if (done.current) return
    done.current = true
    onRename(item, name)
  }
  return (
    <Input
      autoFocus
      defaultValue={item.name}
      aria-label={`Rename ${item.name}`}
      className={cn("h-6 min-w-0 px-1.5", className)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onFocus={(e) => {
        /* Select the stem, not the extension — what a rename almost always means. */
        const dot = item.kind === "file" ? item.name.lastIndexOf(".") : -1
        e.currentTarget.setSelectionRange(0, dot > 0 ? dot : item.name.length)
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === "Enter") {
          e.preventDefault()
          finish(e.currentTarget.value)
        }
        if (e.key === "Escape") finish(null)
      }}
    />
  )
}

/** The attributes every item carries, whichever view draws it. */
function itemAttrs(item: ListedItem, h: ItemHandlers) {
  const selected = h.selected.has(item.id)
  const off = item.kind === "file" && !h.isPickable(item)
  return {
    id: h.domId(item.id),
    role: "option" as const,
    "aria-selected": selected,
    "aria-disabled": off || undefined,
    "data-selected": selected || undefined,
    "data-focus": h.focusId === item.id || undefined,
    ...h.dragProps(item),
    ...(item.kind === "folder" ? h.dropProps(item.id) : {}),
    onClick: (e: React.MouseEvent) => h.onPointer(e, item),
    onDoubleClick: () => h.onOpen(item),
    onContextMenu: () => h.onContext(item),
    className: cn(
      "relative cursor-default select-none rounded-md outline-none",
      "hover:bg-muted data-selected:bg-primary/10 data-selected:hover:bg-primary/15",
      "data-focus:ring-[3px] data-focus:ring-ring/50",
      "data-drop:bg-primary/10 data-drop:ring-1 data-drop:ring-primary",
      h.cutIds.has(item.id) && "opacity-50",
      off && "opacity-45"
    ),
  }
}

/** An image file's own pixels (fetched once it scrolls near), else its kind's glyph. */
export function Thumb({ item, crop = true, className }: { item: ListedItem; crop?: boolean; className?: string }) {
  const [ref, seen] = useInView<HTMLDivElement>()
  const image = item.kind === "file" && item.mimeType.startsWith("image/") && item.size <= THUMB_MAX_BYTES
  const blob = useFileBlob(image ? item : null, { enabled: seen })
  const Icon = mimeIcon(item.mimeType)
  return (
    <div ref={ref} className={cn("flex items-center justify-center overflow-hidden", className)}>
      {blob.url ? (
        <img src={blob.url} alt="" draggable={false} className={cn("size-full", crop ? "object-cover" : "object-contain")} />
      ) : (
        <Icon
          className={cn("size-1/2", item.kind === "folder" ? "text-primary" : "text-muted-foreground")}
          strokeWidth={1.25}
          fill={item.kind === "folder" ? "currentColor" : "none"}
          fillOpacity={0.15}
        />
      )}
    </div>
  )
}

/** Above this many items a view draws only what is near the viewport (plus focus, rename and drag). */
const WINDOW_AT = 150

/** id → index, for pinning rows by the explorer's ids. */
function useIndexOf(items: ListedItem[]) {
  const map = React.useMemo(() => new Map(items.map((item, i) => [item.id, i])), [items])
  return (id: string | null) => (id == null ? undefined : map.get(id))
}

const sizeText = (item: ListedItem) =>
  item.kind === "folder" ? `${item.childCount ?? 0} ${item.childCount === 1 ? "item" : "items"}` : formatBytes(item.size)

export function GridView({
  items,
  h,
  size,
  labels,
  crop,
}: {
  items: ListedItem[]
  h: ItemHandlers
  /** Tile width in px — the explorer's slider. */
  size: number
  labels: boolean
  crop: boolean
}) {
  const roomy = size >= 104
  /* One root div in both modes, so the width observer survives a switch. */
  const [wrap, width] = useWidth<HTMLDivElement>()
  /* Not gated on the width: an unmeasured big folder draws no tiles for the
     one commit before its width lands, rather than all of them. */
  const windowed = items.length > WINDOW_AT
  /* auto-fill minmax(min(tile,100%),1fr) with gap-2, in numbers. */
  const cols = Math.max(1, Math.floor((width + 8) / (size + 8)))
  const ix = useIndexOf(items)
  const rowOf = (id: string | null) => {
    const i = ix(id)
    return i == null ? undefined : Math.floor(i / cols)
  }
  /* Rows are positional (keyed by row number): tiles stay direct children of
     the one grid, keyed by id, so an insertion or a column change moves a tile
     rather than remounting it (and a rename's draft with it). */
  const w = useWindowedRows({
    count: windowed && width > 0 ? Math.ceil(items.length / cols) : 0,
    threshold: 0,
    list: wrap,
    estimateSize: () => Math.round(width / cols) + (labels ? 48 : 8),
    gap: 8,
    measured: true,
    pin: [rowOf(h.focusId), rowOf(h.renamingId), rowOf(h.draggingId)],
  })

  /* Windowed, every tile carries its grid row's index and the row's first
     tile is measured for it (a stretched grid item is its row's height); a
     tile that stops being first stays observed and still reports its row. */
  const tile = (item: ListedItem, index: number, row?: number, first?: boolean) => {
    const attrs = itemAttrs(item, h)
    return (
      <div
        key={item.id}
        {...attrs}
        data-index={row}
        ref={first ? w.measure : undefined}
        aria-setsize={windowed ? items.length : undefined}
        aria-posinset={windowed ? index + 1 : undefined}
        className={cn(attrs.className, "flex min-w-0 flex-col items-center gap-2", roomy ? "p-2 rounded-2xl" : "p-1 rounded-xl")}
        title={item.name}
      >
        <Thumb item={item} crop={crop} className="aspect-square w-full rounded-lg bg-muted" />
        {h.renamingId === item.id ? (
          <RenameInput item={item} onRename={h.onRename} className="w-full text-center" />
        ) : (
          labels && <span className="line-clamp-2 w-full text-center text-sm break-all">{item.name}</span>
        )}
        {labels && roomy && <span className="-mt-1 text-xs text-muted-foreground tabular-nums">{sizeText(item)}</span>}
      </div>
    )
  }
  /* A skipped run of rows is one full-width cell. It is a grid row of its
     own, so it brings one gap of its own: `before` (which already counts the
     gap above the next row) loses it, `after` does not. */
  const spacer = (key: string, height: number) => (
    <div key={key} aria-hidden role="none" style={{ gridColumn: "1 / -1", height }} />
  )

  return (
    /* The explicit repeat(cols) when windowed is what the explorer's
       gridColumns() reads off [data-grid]. */
    <div
      ref={wrap}
      className={cn("grid gap-2 p-2", !windowed && "grid-cols-[repeat(auto-fill,minmax(min(var(--tile),100%),1fr))]")}
      style={
        windowed
          ? { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }
          : ({ "--tile": `${size}px` } as React.CSSProperties)
      }
      data-grid
    >
      {windowed
        ? w.rows.flatMap(({ index: r, before }) => [
            ...(before > 8 ? [spacer(`b${r}`, before - 8)] : []),
            ...items.slice(r * cols, r * cols + cols).map((item, i) => tile(item, r * cols + i, r, i === 0)),
          ])
        : items.map((item, i) => tile(item, i))}
      {w.after > 0 && spacer("after", w.after)}
    </div>
  )
}

const COLUMN_LABEL: Record<ColumnId, string> = { location: "Location", updatedAt: "Modified", kind: "Kind", size: "Size" }
const COLUMN_SORT: Record<ColumnId, SortKey | null> = { location: null, updatedAt: "updatedAt", kind: "kind", size: "size" }
/** Below this listing width a column is dropped, whatever the toggles say — Name keeps its room. */
const COLUMN_MIN_PANE: Record<ColumnId, number> = { location: 420, updatedAt: 480, kind: 600, size: 0 }

export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = React.useRef<T>(null)
  const [width, setWidth] = React.useState(0)
  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => entry.contentRect.width > 0 && setWidth(entry.contentRect.width))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}

export function ListView({
  items,
  h,
  sort,
  desc,
  onSort,
  columns,
  widths,
  onWidths,
  thumbs,
}: {
  items: ListedItem[]
  h: ItemHandlers
  sort: SortKey
  desc: boolean
  onSort: (key: SortKey) => void
  /** The columns asked for, in order (Location only for search results). */
  columns: ColumnId[]
  widths: Record<ColumnId, number>
  /** A divider let go: the widths to keep. */
  onWidths: (widths: Record<ColumnId, number>) => void
  /** Image thumbnails in place of the kind glyph. */
  thumbs: boolean
}) {
  const [ref, paneWidth] = useWidth<HTMLDivElement>()
  /* A drag is drawn from local state and kept only when it ends — the
     preference store is not written per pixel. */
  const [live, setLive] = React.useState<Record<ColumnId, number> | null>(null)
  const w = live ?? widths
  const shown = columns.filter((id) => paneWidth === 0 || paneWidth >= COLUMN_MIN_PANE[id])
  const template = ["minmax(8rem,1fr)", ...shown.map((id) => `${w[id]}px`)].join(" ")

  const rowsRef = React.useRef<HTMLDivElement>(null)
  const [coarse] = React.useState(() => matchMedia("(pointer: coarse)").matches)
  const ix = useIndexOf(items)
  /* The scroller is the explorer's listbox pane; the sticky header above is
     absorbed by the measured scroll margin. */
  const win = useWindowedRows({
    count: items.length,
    threshold: WINDOW_AT,
    list: rowsRef,
    estimateSize: () => (coarse ? 44 : 32),
    getItemKey: (i) => items[i].id,
    gap: 1,
    pin: [ix(h.focusId), ix(h.renamingId), ix(h.draggingId)],
  })

  const startResize = (id: ColumnId) => (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const handle = e.currentTarget as HTMLElement
    handle.setPointerCapture(e.pointerId)
    const x0 = e.clientX
    const w0 = w[id]
    let next = w
    const move = (ev: PointerEvent) => {
      /* The handle is the column's leading edge: dragging it left widens it. */
      const width = Math.round(Math.min(COLUMN_WIDTH.max, Math.max(COLUMN_WIDTH.min, w0 - (ev.clientX - x0))))
      next = { ...w, [id]: width }
      setLive(next)
    }
    const up = () => {
      handle.removeEventListener("pointermove", move)
      handle.removeEventListener("pointerup", up)
      handle.removeEventListener("pointercancel", up)
      setLive(null)
      if (next !== w) onWidths(next)
    }
    handle.addEventListener("pointermove", move)
    handle.addEventListener("pointerup", up)
    handle.addEventListener("pointercancel", up)
  }

  const cell = (item: ListedItem, id: ColumnId) => {
    switch (id) {
      case "location": {
        const where = item.path?.map((p) => p.name).join(" / ") || "Library"
        return (
          <span key={id} className="truncate text-sm text-muted-foreground" title={where}>
            {where}
          </span>
        )
      }
      case "updatedAt":
        return (
          <span key={id} className="truncate text-sm text-muted-foreground tabular-nums">
            {formatDate(item.updatedAt)}
          </span>
        )
      case "kind":
        return (
          <span key={id} className="truncate text-sm text-muted-foreground">
            {kindLabel(item)}
          </span>
        )
      case "size":
        return (
          <span key={id} className="truncate text-right text-sm text-muted-foreground tabular-nums">
            {sizeText(item)}
          </span>
        )
    }
  }

  return (
    <div ref={ref} className="flex flex-col">
      <div
        // px-3.5: the rows' columns start at the pane's p-1.5 + the row's px-2.
        className="sticky top-0 z-10 grid gap-3 border-b bg-background px-3.5 py-2 text-xs font-medium text-muted-foreground"
        style={{ gridTemplateColumns: template }}
      >
        <SortHead id="name" label="Name" sort={sort} desc={desc} onSort={onSort} />
        {shown.map((id) => (
          <div key={id} className="relative min-w-0">
            {/* The divider between this column and the one before it. */}
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={`Resize ${COLUMN_LABEL[id]}`}
              title="Drag to resize"
              onPointerDown={startResize(id)}
              onDoubleClick={() => onWidths({ ...w, [id]: DEFAULT_COLUMN_WIDTHS[id] })}
              className="absolute inset-y-[-6px] -left-2 z-10 w-2 cursor-col-resize after:absolute after:inset-y-1 after:left-1/2 after:w-px after:bg-border hover:after:bg-primary"
            />
            <SortHead
              id={COLUMN_SORT[id]}
              label={COLUMN_LABEL[id]}
              sort={sort}
              desc={desc}
              onSort={onSort}
              className={id === "size" ? "justify-end" : undefined}
            />
          </div>
        ))}
      </div>
      <div ref={rowsRef} className="flex flex-col gap-px p-1.5">
        {win.rows.map(({ index, before }) => {
          const item = items[index]
          const attrs = itemAttrs(item, h)
          const Icon = mimeIcon(item.mimeType)
          return (
            <div
              key={item.id}
              {...attrs}
              data-index={index}
              aria-setsize={win.windowed ? items.length : undefined}
              aria-posinset={win.windowed ? index + 1 : undefined}
              className={cn(attrs.className, "grid h-8 items-center gap-3 rounded-lg px-2 text-sm pointer-coarse:h-11")}
              style={{ gridTemplateColumns: template, marginTop: before || undefined }}
            >
              <span className="flex min-w-0 items-center gap-2">
                {thumbs && item.kind === "file" ? (
                  <Thumb item={item} className="size-6 shrink-0 rounded-sm bg-muted" />
                ) : (
                  /* With thumbs on, a folder takes the thumb's 24px slot so
                     every name starts on one column. */
                  <span className={cn("flex shrink-0 items-center justify-center", thumbs && "size-6")}>
                    <Icon
                      className={cn("size-4 shrink-0", item.kind === "folder" ? "text-primary" : "text-muted-foreground")}
                      fill={item.kind === "folder" ? "currentColor" : "none"}
                      fillOpacity={0.15}
                    />
                  </span>
                )}
                {h.renamingId === item.id ? (
                  <RenameInput item={item} onRename={h.onRename} className="flex-1" />
                ) : (
                  <span className="truncate" title={item.name}>
                    {item.name}
                  </span>
                )}
              </span>
              {shown.map((id) => cell(item, id))}
            </div>
          )
        })}
        {win.after > 0 && <div aria-hidden style={{ height: win.after }} />}
      </div>
    </div>
  )
}

function SortHead({
  id,
  label,
  sort,
  desc,
  onSort,
  className,
}: {
  id: SortKey | null
  label: string
  sort: SortKey
  desc: boolean
  onSort: (key: SortKey) => void
  className?: string
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      disabled={!id}
      onClick={() => id && onSort(id)}
      className={cn("flex w-full min-w-0 items-center gap-1 truncate text-left hover:text-foreground disabled:hover:text-inherit", className)}
    >
      {label}
      {id === sort && (desc ? <ArrowDownIcon className="size-3 shrink-0" /> : <ArrowUpIcon className="size-3 shrink-0" />)}
    </button>
  )
}
