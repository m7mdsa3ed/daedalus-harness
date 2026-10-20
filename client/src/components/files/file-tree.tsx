/* ── The folder tree ──
   Folders only, drawn from the one flat `/api/files/folders` read: the
   explorer's left pane, and the destination list of "Move to…". The root is a
   node of its own ("Library") so it can be chosen and dropped on like any
   folder. The ancestors of the chosen folder open themselves, so navigating in
   the listing is mirrored here. */
import * as React from "react"
import { ChevronRightIcon, FolderIcon, FolderOpenIcon, LibraryIcon } from "lucide-react"

import type { FolderNode } from "@/lib/files"
import { cn } from "@/lib/utils"

/** What makes a node a drop target — the explorer's, passed through. */
export type DropProps = (folderId: string | null) => React.HTMLAttributes<HTMLElement> & { "data-drop"?: boolean }

export function FolderTree({
  folders,
  value,
  onSelect,
  dropProps,
  disabled,
  className,
}: {
  folders: FolderNode[]
  /** The chosen folder; `null` is the root, `undefined` none (a search is on screen). */
  value: string | null | undefined
  onSelect: (id: string | null) => void
  dropProps?: DropProps
  /** Folders that cannot be chosen (and whose subtrees cannot either) — a move's own sources. */
  disabled?: ReadonlySet<string>
  className?: string
}) {
  const children = React.useMemo(() => {
    const map = new Map<string | null, FolderNode[]>()
    for (const folder of folders) map.set(folder.parentId, [...(map.get(folder.parentId) ?? []), folder])
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    return map
  }, [folders])
  const [open, setOpen] = React.useState<ReadonlySet<string>>(new Set())

  /* Reveal the chosen folder: every ancestor opens. */
  React.useEffect(() => {
    if (!value) return
    const byId = new Map(folders.map((f) => [f.id, f]))
    const ancestors: string[] = []
    for (let cursor = byId.get(value)?.parentId ?? null, guard = 0; cursor && guard < 100; guard++) {
      ancestors.push(cursor)
      cursor = byId.get(cursor)?.parentId ?? null
    }
    if (ancestors.some((id) => !open.has(id))) setOpen((prev) => new Set([...prev, ...ancestors]))
    // `open` is read, not watched: collapsing an ancestor by hand must stick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, folders])

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })

  const node = (folder: FolderNode, depth: number, blocked: boolean): React.ReactNode => {
    const kids = children.get(folder.id) ?? []
    const isOpen = open.has(folder.id)
    const off = blocked || !!disabled?.has(folder.id)
    const Icon = isOpen && kids.length > 0 ? FolderOpenIcon : FolderIcon
    return (
      <React.Fragment key={folder.id}>
        <div
          role="treeitem"
          aria-selected={value === folder.id}
          aria-expanded={kids.length > 0 ? isOpen : undefined}
          aria-disabled={off || undefined}
          {...(!off ? dropProps?.(folder.id) : {})}
          onClick={() => !off && onSelect(folder.id)}
          onDoubleClick={() => kids.length > 0 && toggle(folder.id)}
          // One level = the chevron slot (20) + the gap (4), from a 4px inset.
          style={{ paddingLeft: depth * 24 + 4 }}
          className={cn(
            "group flex h-7 cursor-pointer items-center gap-1 rounded-md pr-2 text-sm pointer-coarse:h-10",
            "hover:bg-muted data-drop:bg-primary/10 data-drop:ring-1 data-drop:ring-primary",
            value === folder.id && "bg-muted font-medium",
            off && "cursor-not-allowed opacity-40 hover:bg-transparent"
          )}
        >
          <button
            type="button"
            tabIndex={-1}
            aria-label={isOpen ? `Collapse ${folder.name}` : `Expand ${folder.name}`}
            className={cn("flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground", kids.length === 0 && "invisible")}
            onClick={(e) => {
              e.stopPropagation()
              toggle(folder.id)
            }}
          >
            <ChevronRightIcon className={cn("size-3.5 transition-transform", isOpen && "rotate-90")} />
          </button>
          <Icon className="size-4 shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate" title={folder.name}>
            {folder.name}
          </span>
        </div>
        {isOpen && kids.map((kid) => node(kid, depth + 1, off))}
      </React.Fragment>
    )
  }

  return (
    <div role="tree" aria-label="Folders" className={cn("flex flex-col gap-px", className)}>
      <div
        role="treeitem"
        aria-selected={value === null}
        aria-expanded
        {...dropProps?.(null)}
        onClick={() => onSelect(null)}
        style={{ paddingLeft: 4 }}
        className={cn(
          "flex h-7 cursor-pointer items-center gap-1 rounded-md pr-2 text-sm pointer-coarse:h-10",
          "hover:bg-muted data-drop:bg-primary/10 data-drop:ring-1 data-drop:ring-primary",
          value === null && "bg-muted font-medium"
        )}
      >
        {/* The folders' chevron slot, empty, so the root's mark is on their column. */}
        <span aria-hidden className="invisible size-5 shrink-0" />
        <LibraryIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate">Library</span>
      </div>
      {(children.get(null) ?? []).map((folder) => node(folder, 1, false))}
    </div>
  )
}
