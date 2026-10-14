/* ── The file library, client side ──
   Folders and files in one tree (`parentId: null` is the root), served by
   `/api/files`. Bytes are fetched with the bearer header and shown from a blob,
   never an `<img src>` — which cannot carry one. */
import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"

import { createLocalStore } from "@/lib/local-store"
import { api, ApiError, type ServerSettings } from "@/lib/settings"
import { useApiQuery } from "@/lib/queries/helpers"
import { filesKey } from "@/lib/queries/keys"
import { useServer } from "@/lib/server-context"

/** How the explorer is drawn on this device — the reader's, not the library's. */
export type SortKey = "name" | "kind" | "size" | "updatedAt"
export type ListColumn = "updatedAt" | "kind" | "size"
/** Every column a list can draw after Name; Location only for search results. */
export type ColumnId = ListColumn | "location"
export const COLUMN_WIDTH = { min: 64, max: 480 } as const
export const DEFAULT_COLUMN_WIDTHS: Record<ColumnId, number> = { location: 200, updatedAt: 150, kind: 120, size: 88 }
export interface ExplorerPrefs {
  view: "list" | "grid"
  sort: SortKey
  desc: boolean
  /** Folders above files whatever the sort — off mixes them in. */
  foldersFirst: boolean
  /** The folder tree beside the listing, where there is room for it. */
  tree: boolean
  /** The details pane beside the listing, where there is room for it. */
  info: boolean
  /** Pane widths in px, as the dividers last left them. */
  treeWidth: number
  infoWidth: number
  /** Grid tile width in px (`GRID_SIZES`). */
  gridSize: number
  /** Names under grid tiles; off is a wall of thumbnails. */
  gridLabels: boolean
  /** Thumbnails fill their tile (cropped) rather than fitting inside it. */
  cropThumbs: boolean
  /** Image thumbnails in list rows instead of a kind glyph. */
  listThumbs: boolean
  /** Which optional list columns are drawn; Name always is. */
  columns: Record<ListColumn, boolean>
  /** List column widths in px, as their dividers last left them. */
  columnWidths: Record<ColumnId, number>
}
export const GRID_SIZES = { min: 72, max: 280, step: 8 } as const
const PREFS_DEFAULT: ExplorerPrefs = {
  view: "list",
  sort: "name",
  desc: false,
  foldersFirst: true,
  tree: true,
  info: true,
  treeWidth: 208,
  infoWidth: 380,
  gridSize: 120,
  gridLabels: true,
  cropThumbs: true,
  listThumbs: false,
  columns: { updatedAt: true, kind: true, size: true },
  columnWidths: DEFAULT_COLUMN_WIDTHS,
}
const clamp = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback
export const explorerPrefs = createLocalStore<ExplorerPrefs>(
  "daedalus.files.explorer",
  (raw) => {
    const value = (raw ?? {}) as Partial<ExplorerPrefs>
    const bool = (key: keyof ExplorerPrefs) =>
      typeof value[key] === "boolean" ? (value[key] as boolean) : (PREFS_DEFAULT[key] as boolean)
    const columns = (value.columns ?? {}) as Partial<Record<ListColumn, unknown>>
    return {
      view: value.view === "grid" ? "grid" : "list",
      sort: (["name", "kind", "size", "updatedAt"] as const).find((k) => k === value.sort) ?? "name",
      desc: bool("desc"),
      foldersFirst: bool("foldersFirst"),
      tree: bool("tree"),
      info: bool("info"),
      treeWidth: clamp(value.treeWidth, 140, 480, PREFS_DEFAULT.treeWidth),
      infoWidth: clamp(value.infoWidth, 220, 1600, PREFS_DEFAULT.infoWidth),
      gridSize: clamp(value.gridSize, GRID_SIZES.min, GRID_SIZES.max, PREFS_DEFAULT.gridSize),
      gridLabels: bool("gridLabels"),
      cropThumbs: bool("cropThumbs"),
      listThumbs: bool("listThumbs"),
      columns: {
        updatedAt: columns.updatedAt !== false,
        kind: columns.kind !== false,
        size: columns.size !== false,
      },
      columnWidths: Object.fromEntries(
        (Object.keys(DEFAULT_COLUMN_WIDTHS) as ColumnId[]).map((id) => [
          id,
          clamp((value.columnWidths as Partial<Record<ColumnId, unknown>> | undefined)?.[id], COLUMN_WIDTH.min, COLUMN_WIDTH.max, DEFAULT_COLUMN_WIDTHS[id]),
        ])
      ) as Record<ColumnId, number>,
    }
  },
  PREFS_DEFAULT
)
export const setExplorerPrefs = (patch: Partial<ExplorerPrefs>) =>
  explorerPrefs.set({ ...explorerPrefs.get(), ...patch })

/** Folders first (unless asked not to), then the chosen key; names break ties naturally ("2" < "10"). */
export function sortFiles<T extends FileRecord>(items: readonly T[], sort: SortKey, desc: boolean, foldersFirst = true): T[] {
  const byName = (a: T, b: T) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
  const key: Record<SortKey, (a: T, b: T) => number> = {
    name: byName,
    kind: (a, b) => kindLabel(a).localeCompare(kindLabel(b)),
    size: (a, b) => (a.kind === "folder" ? (a.childCount ?? 0) - (b.childCount ?? 0) : a.size - b.size),
    updatedAt: (a, b) => a.updatedAt - b.updatedAt,
  }
  return [...items].sort((a, b) => {
    if (foldersFirst && a.kind !== b.kind) return a.kind === "folder" ? -1 : 1
    const order = key[sort](a, b) || byName(a, b)
    return desc ? -order : order
  })
}

/** What a folder's `mimeType` is — one column to sort and filter on. */
export const FOLDER_MIME = "inode/directory"

export interface FileRecord {
  id: string
  parentId: string | null
  kind: "folder" | "file"
  name: string
  mimeType: string
  size: number
  createdAt: number
  updatedAt: number
  /** A listed folder's direct entries. Absent on a search hit. */
  childCount?: number
}

export type PathStep = { id: string; name: string }

export interface FolderListing {
  parentId: string | null
  /** Root → this folder. */
  path: PathStep[]
  items: FileRecord[]
}

/** A search hit says which folder it sits in (root → parent). */
export type SearchHit = FileRecord & { path: PathStep[] }

export type FolderNode = { id: string; parentId: string | null; name: string }

export function useFolder(parentId: string | null, enabled = true) {
  return useApiQuery<FolderListing>(
    filesKey(useServer(), parentId),
    `/api/files?parent=${parentId ?? "root"}`,
    { enabled, staleTime: 15_000 }
  )
}

/** Every folder, flat — the tree pane and "Move to" both draw from it. */
export function useFolderTree() {
  return useApiQuery<{ folders: FolderNode[] }>(filesKey(useServer()).concat(["~tree"]), "/api/files/folders", {
    staleTime: 15_000,
  })
}

/** Names containing `query`, across the whole library. */
export function useFileSearch(query: string) {
  const q = query.trim()
  return useApiQuery<{ items: SearchHit[] }>(
    filesKey(useServer()).concat(["~search", q]),
    `/api/files/search?q=${encodeURIComponent(q)}`,
    { enabled: q.length > 0, staleTime: 5_000, placeholderData: (previous) => previous }
  )
}

/** Does a file satisfy an `accept` list — `image/*`, `application/pdf`, `.png`? */
export function matchesAccept(file: Pick<FileRecord, "name" | "mimeType">, accept?: string): boolean {
  if (!accept) return true
  return accept
    .split(",")
    .map((rule) => rule.trim().toLowerCase())
    .filter(Boolean)
    .some((rule) =>
      rule.startsWith(".")
        ? file.name.toLowerCase().endsWith(rule)
        : rule.endsWith("/*")
          ? file.mimeType.startsWith(rule.slice(0, -1))
          : file.mimeType === rule
    )
}

const extOf = (name: string) => {
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ""
}

/** "PNG image", "PDF document", "Folder" — the Kind column. */
export function kindLabel(file: Pick<FileRecord, "kind" | "name" | "mimeType">): string {
  if (file.kind === "folder") return "Folder"
  const ext = extOf(file.name).toUpperCase()
  const [family] = file.mimeType.split("/")
  if (file.mimeType === "application/pdf") return "PDF document"
  if (family === "image" || family === "video" || family === "audio") return ext ? `${ext} ${family}` : family[0].toUpperCase() + family.slice(1)
  if (isTextLike(file)) return ext ? `${ext} text` : "Text"
  return ext ? `${ext} file` : "File"
}

// ponytail: browsers send "" or odd types for source files (.ts is video/mp2t), so the extension decides too.
const TEXT_EXTS = new Set(
  "txt md markdown json jsonc yml yaml toml ini env csv tsv log xml html htm css scss js mjs cjs jsx ts tsx py rb go rs java kt swift c h cpp cs php sh bash zsh sql graphql vue svelte".split(" ")
)

export function isTextLike(file: Pick<FileRecord, "name" | "mimeType">): boolean {
  return (
    file.mimeType.startsWith("text/") ||
    /json|xml|javascript|typescript|yaml|x-sh|toml/.test(file.mimeType) ||
    TEXT_EXTS.has(extOf(file.name))
  )
}

/** One file headed for a folder `path` below the drop target. */
export type UploadEntry = { path: string[]; file: File }

/** A drop as upload entries, folders included: `webkitGetAsEntry` walks a
    dropped directory, which `dataTransfer.files` alone flattens away. */
export async function entriesFromDrop(transfer: DataTransfer): Promise<UploadEntry[]> {
  const roots = Array.from(transfer.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.webkitGetAsEntry?.())
    .filter((entry): entry is FileSystemEntry => !!entry)
  if (roots.length === 0) return Array.from(transfer.files).map((file) => ({ path: [], file }))
  const out: UploadEntry[] = []
  const walk = async (entry: FileSystemEntry, path: string[]): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject))
      out.push({ path, file })
      return
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader()
    // readEntries answers in batches until it answers none.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
      if (batch.length === 0) break
      for (const child of batch) await walk(child, [...path, entry.name])
    }
  }
  for (const root of roots) await walk(root, [])
  return out
}

/** An `<input webkitdirectory>` pick as upload entries. */
export const entriesFromInput = (files: Iterable<File>): UploadEntry[] =>
  Array.from(files, (file) => ({ file, path: (file.webkitRelativePath || file.name).split("/").slice(0, -1) }))

async function uploadOne(settings: ServerSettings, parentId: string | null, file: File): Promise<FileRecord> {
  const path = `/api/files?parent=${parentId ?? "root"}`
  const response = await fetch(new URL(path, settings.url), {
    method: "POST",
    headers: {
      authorization: `Bearer ${settings.token}`,
      "content-type": file.type || "application/octet-stream",
      "x-filename": encodeURIComponent(file.name || "file"),
    },
    body: file,
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new ApiError({ status: response.status, path, serverMessage: typeof body?.error === "string" ? body.error : undefined })
  }
  return (await response.json()) as FileRecord
}

/** Run `each` over `items` in order; every one is tried, the first failure is
    rethrown after the rest, and the tree is re-read once either way. */
async function all<T, R>(items: readonly T[], each: (item: T) => Promise<R>, done: () => Promise<unknown>): Promise<R[]> {
  const out: R[] = []
  let failure: unknown
  for (const item of items) {
    try {
      out.push(await each(item))
    } catch (err) {
      failure ??= err
    }
  }
  await done()
  if (failure) throw failure
  return out
}

/** Every write, each batch followed by one re-read of the whole tree (one cheap family). */
export function useFileActions() {
  const settings = useServer()
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: filesKey(settings) })
  const done = <T,>(value: T) => refresh().then(() => value)
  const makeFolder = (parentId: string | null, name: string) =>
    api<FileRecord>(settings, "/api/files/folder", { method: "POST", body: JSON.stringify({ parentId, name }) })
  const fetchFile = async (record: FileRecord): Promise<File> => {
    const path = `/api/files/${record.id}/content`
    const response = await fetch(new URL(path, settings.url), {
      headers: { authorization: `Bearer ${settings.token}` },
    })
    if (!response.ok) throw new ApiError({ status: response.status, path })
    return new File([await response.blob()], record.name, { type: record.mimeType })
  }
  return {
    refresh,
    upload: (files: Iterable<File>, parentId: string | null) =>
      all(Array.from(files), (file) => uploadOne(settings, parentId, file), refresh),
    /** Files with folder paths below `parentId`; folders are made as they are
        first needed (so an empty dropped folder is not recreated). */
    uploadEntries: async (entries: UploadEntry[], parentId: string | null, onProgress?: (done: number) => void) => {
      const folders = new Map<string, string | null>([["", parentId]])
      const folderFor = async (path: string[]): Promise<string | null> => {
        const key = path.join("/")
        if (folders.has(key)) return folders.get(key)!
        const parent = await folderFor(path.slice(0, -1))
        const made = await makeFolder(parent, path.at(-1)!)
        folders.set(key, made.id)
        return made.id
      }
      let count = 0
      return all(
        entries,
        async ({ path, file }) => {
          const row = await uploadOne(settings, await folderFor(path), file)
          onProgress?.(++count)
          return row
        },
        refresh
      )
    },
    makeFolder: (parentId: string | null, name: string) => makeFolder(parentId, name).then(done),
    rename: (id: string, name: string) =>
      api<FileRecord>(settings, `/api/files/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }).then(done),
    move: (ids: readonly string[], parentId: string | null) =>
      all(
        ids.filter((id) => id !== parentId),
        (id) => api<FileRecord>(settings, `/api/files/${id}`, { method: "PATCH", body: JSON.stringify({ parentId }) }),
        refresh
      ),
    copy: (ids: readonly string[], parentId: string | null) =>
      all(
        ids,
        (id) => api<FileRecord>(settings, `/api/files/${id}/copy`, { method: "POST", body: JSON.stringify({ parentId }) }),
        refresh
      ),
    remove: (ids: readonly string[]) =>
      all(ids, (id) => api(settings, `/api/files/${id}`, { method: "DELETE" }), refresh),
    /** The bytes as a `File`, ready for anything that takes one — the composer's
        attachment pipeline, a logo scaler. */
    fetchFile,
    /** Save to the device, through a blob: the content route needs the bearer header. */
    download: async (record: FileRecord) => {
      const url = URL.createObjectURL(await fetchFile(record))
      const a = Object.assign(document.createElement("a"), { href: url, download: record.name })
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    },
  }
}

/** A file's bytes as an object URL (revoked when the file changes or the
    caller unmounts), plus the text for a text preview. */
export function useFileBlob(record: FileRecord | null, opts: { text?: boolean; enabled?: boolean } = {}) {
  const settings = useServer()
  const [state, setState] = React.useState<{ url?: string; blob?: Blob; text?: string; error?: unknown; loading: boolean }>({
    loading: false,
  })
  const id = record?.id
  const enabled = opts.enabled !== false && !!record && record.kind === "file"
  React.useEffect(() => {
    if (!enabled || !id) return setState({ loading: false })
    const abort = new AbortController()
    let url: string | undefined
    setState({ loading: true })
    const path = `/api/files/${id}/content`
    fetch(new URL(path, settings.url), { headers: { authorization: `Bearer ${settings.token}` }, signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new ApiError({ status: response.status, path })
        const blob = await response.blob()
        url = URL.createObjectURL(blob)
        setState({ url, blob, text: opts.text ? await blob.text() : undefined, loading: false })
      })
      .catch((error) => !abort.signal.aborted && setState({ error, loading: false }))
    return () => {
      abort.abort()
      if (url) URL.revokeObjectURL(url)
    }
    // `updatedAt` is not a dependency: bytes never change under an id.
  }, [enabled, id, opts.text, settings.url, settings.token])
  return state
}

const DATE = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })
export const formatDate = (at: number) => DATE.format(at)
