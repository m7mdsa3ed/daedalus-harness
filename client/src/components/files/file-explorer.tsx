/* ── The file library as a tree ──
   Folders nest and expand in place, the way a file explorer does; a row's
   glyph comes from its mime type. Dropping files on a folder uploads into it,
   dragging a row onto a folder moves it (onto the empty area: the root).
   `pick` mode is the same tree with a click that chooses a file — used by the
   picker dialog, so the composer and the logo fields share one surface. */
import * as React from "react"
import {
  ChevronRightIcon,
  FolderPlusIcon,
  MoreHorizontalIcon,
  PencilIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react"

import { useConfirm } from "@/components/confirm-dialog"
import { Empty } from "@/components/empty"
import { mimeIcon } from "@/components/files/mime-icon"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { formatBytes } from "@/lib/attachments"
import { reportError } from "@/lib/errors"
import { matchesAccept, useFileActions, useFolder, type FileRecord } from "@/lib/files"
import { cn } from "@/lib/utils"

const DRAG_TYPE = "application/x-daedalus-file"

interface Ctx {
  accept?: string
  onPick?: (file: FileRecord) => void
  target: string | null
  setTarget: (id: string | null) => void
  actions: ReturnType<typeof useFileActions>
  renaming: string | null
  setRenaming: (id: string | null) => void
}
const ExplorerCtx = React.createContext<Ctx | null>(null)

export function FileExplorer({
  accept,
  onPick,
  className,
}: {
  /** An `<input accept>` list. Files that do not match are drawn but not pickable. */
  accept?: string
  /** Present = pick mode: a file's click chooses it and there is no row menu. */
  onPick?: (file: FileRecord) => void
  className?: string
}) {
  const actions = useFileActions()
  const [target, setTarget] = React.useState<string | null>(null)
  const [renaming, setRenaming] = React.useState<string | null>(null)
  const input = React.useRef<HTMLInputElement>(null)
  const root = useFolder(null)
  const targetName = useFolder(target, target !== null).data?.path.at(-1)?.name

  const upload = (files: Iterable<File>, parentId: string | null) =>
    actions.upload(files, parentId).catch((err) => reportError(err, "Couldn't upload that"))
  const newFolder = async () => {
    try {
      const folder = await actions.makeFolder(target, "New folder")
      setRenaming(folder.id)
    } catch (err) {
      reportError(err, "Couldn't create that folder")
    }
  }

  return (
    <ExplorerCtx.Provider value={{ accept, onPick, target, setTarget, actions, renaming, setRenaming }}>
      <div className={cn("flex min-h-0 flex-col gap-2", className)}>
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {targetName ? `Into “${targetName}”` : "Into the top level"}
          </span>
          <Button type="button" size="xs" variant="outline" onClick={newFolder}>
            <FolderPlusIcon data-icon="inline-start" /> Folder
          </Button>
          <Button type="button" size="xs" onClick={() => input.current?.click()}>
            <UploadIcon data-icon="inline-start" /> Upload
          </Button>
          <input
            ref={input}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) void upload(Array.from(e.target.files), target)
              e.target.value = ""
            }}
          />
        </div>
        <div
          className="min-h-40 flex-1 overflow-y-auto rounded-lg border p-1"
          onClick={(e) => e.target === e.currentTarget && setTarget(null)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            dropOn(e, null, actions, upload)
          }}
        >
          {root.isPending ? (
            <Skeleton className="m-1 h-7" />
          ) : root.data?.items.length === 0 ? (
            <Empty className="m-2">Nothing here yet. Upload a file or drop one on this box.</Empty>
          ) : (
            <Level parentId={null} depth={0} />
          )}
        </div>
      </div>
    </ExplorerCtx.Provider>
  )
}

/** A drop: a row from this tree moves, files from the desktop upload. */
function dropOn(
  e: React.DragEvent,
  folderId: string | null,
  actions: Ctx["actions"],
  upload: (files: Iterable<File>, parentId: string | null) => Promise<unknown>
) {
  const moved = e.dataTransfer.getData(DRAG_TYPE)
  if (moved) {
    if (moved !== folderId) void actions.move(moved, folderId).catch((err) => reportError(err, "Couldn't move that"))
  } else if (e.dataTransfer.files.length > 0) {
    void upload(Array.from(e.dataTransfer.files), folderId)
  }
}

function Level({ parentId, depth }: { parentId: string | null; depth: number }) {
  const { data, isPending, error } = useFolder(parentId)
  if (isPending) return <Skeleton className="my-1 h-6" style={{ marginLeft: depth * 16 + 8 }} />
  if (error) return <p className="px-2 py-1 text-xs text-destructive">Couldn&rsquo;t read this folder.</p>
  return (
    <>
      {data?.items.map((item) => (
        <Row key={item.id} item={item} depth={depth} />
      ))}
    </>
  )
}

function Row({ item, depth }: { item: FileRecord; depth: number }) {
  const ctx = React.useContext(ExplorerCtx)!
  const { actions, accept, onPick, target, setTarget, renaming, setRenaming } = ctx
  const confirm = useConfirm()
  const [open, setOpen] = React.useState(false)
  const [over, setOver] = React.useState(false)
  const folder = item.kind === "folder"
  const pickable = !folder && matchesAccept(item, accept)
  const Icon = mimeIcon(item.mimeType, open)

  const commitRename = async (name: string) => {
    setRenaming(null)
    if (name.trim() && name !== item.name) {
      await actions.rename(item.id, name.trim()).catch((err) => reportError(err, "Couldn't rename that"))
    }
  }

  return (
    <>
      <div
        role="treeitem"
        aria-expanded={folder ? open : undefined}
        aria-selected={folder && target === item.id}
        draggable={!onPick}
        onDragStart={(e) => e.dataTransfer.setData(DRAG_TYPE, item.id)}
        onDragOver={(e) => {
          if (!folder) return
          e.preventDefault()
          e.stopPropagation()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          if (!folder) return
          e.preventDefault()
          e.stopPropagation()
          setOver(false)
          setOpen(true)
          dropOn(e, item.id, actions, (files, parentId) =>
            actions.upload(files, parentId).catch((err) => reportError(err, "Couldn't upload that"))
          )
        }}
        onClick={() => {
          if (folder) {
            setOpen((o) => !o)
            setTarget(item.id)
          } else if (pickable) onPick?.(item)
        }}
        style={{ paddingLeft: depth * 16 + 4 }}
        className={cn(
          "group flex min-h-8 items-center gap-1.5 rounded-md pr-1 text-sm pointer-coarse:min-h-11",
          folder || pickable ? "cursor-pointer hover:bg-muted/60" : "opacity-50",
          folder && target === item.id && "bg-muted",
          over && "bg-primary/15 ring-1 ring-primary/40"
        )}
      >
        <ChevronRightIcon
          className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90", !folder && "invisible")}
        />
        <Icon className={cn("size-4 shrink-0", folder ? "text-primary" : "text-muted-foreground")} />
        {renaming === item.id ? (
          <Input
            autoFocus
            defaultValue={item.name}
            className="h-6 min-w-0 flex-1 text-xs"
            onClick={(e) => e.stopPropagation()}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => void commitRename(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur()
              if (e.key === "Escape") setRenaming(null)
            }}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate" title={item.name}>
            {item.name}
          </span>
        )}
        {!folder && (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{formatBytes(item.size)}</span>
        )}
        {!onPick && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Actions for ${item.name}`}
                  className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
                  onClick={(e) => e.stopPropagation()}
                />
              }
            >
              <MoreHorizontalIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setRenaming(item.id)}>
                <PencilIcon /> Rename
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={async () => {
                  const ok = await confirm({
                    title: `Delete “${item.name}”?`,
                    description: folder ? "Everything inside it is deleted too." : undefined,
                    confirmLabel: "Delete",
                    destructive: true,
                  })
                  if (ok) await actions.remove(item.id).catch((err) => reportError(err, "Couldn't delete that"))
                }}
              >
                <Trash2Icon /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {folder && open && <Level parentId={item.id} depth={depth + 1} />}
    </>
  )
}
