/* ── The file library, client side ──
   Folders and files in one tree (`parentId: null` is the root), served by
   `/api/files`. Bytes are fetched with the bearer header and shown from a blob,
   never an `<img src>` — which cannot carry one. */
import { useQueryClient } from "@tanstack/react-query"

import { api, ApiError, type ServerSettings } from "@/lib/settings"
import { useApiQuery } from "@/lib/queries/helpers"
import { filesKey } from "@/lib/queries/keys"
import { useServer } from "@/lib/server-context"

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
}

export interface FolderListing {
  parentId: string | null
  /** Root → this folder. */
  path: { id: string; name: string }[]
  items: FileRecord[]
}

export function useFolder(parentId: string | null, enabled = true) {
  return useApiQuery<FolderListing>(
    filesKey(useServer(), parentId),
    `/api/files?parent=${parentId ?? "root"}`,
    { enabled, staleTime: 15_000 }
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

/** Every write, each followed by a re-read of the whole tree (one cheap family). */
export function useFileActions() {
  const settings = useServer()
  const qc = useQueryClient()
  const done = <T,>(value: T) => qc.invalidateQueries({ queryKey: filesKey(settings) }).then(() => value)
  return {
    upload: async (files: Iterable<File>, parentId: string | null) => {
      const out: FileRecord[] = []
      for (const file of files) out.push(await uploadOne(settings, parentId, file))
      return done(out)
    },
    makeFolder: (parentId: string | null, name: string) =>
      api<FileRecord>(settings, "/api/files/folder", { method: "POST", body: JSON.stringify({ parentId, name }) }).then(done),
    rename: (id: string, name: string) =>
      api<FileRecord>(settings, `/api/files/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }).then(done),
    move: (id: string, parentId: string | null) =>
      api<FileRecord>(settings, `/api/files/${id}`, { method: "PATCH", body: JSON.stringify({ parentId }) }).then(done),
    remove: (id: string) => api(settings, `/api/files/${id}`, { method: "DELETE" }).then(done),
    /** The bytes as a `File`, ready for anything that takes one — the composer's
        attachment pipeline, a logo scaler. */
    fetchFile: async (record: FileRecord): Promise<File> => {
      const path = `/api/files/${record.id}/content`
      const response = await fetch(new URL(path, settings.url), {
        headers: { authorization: `Bearer ${settings.token}` },
      })
      if (!response.ok) throw new ApiError({ status: response.status, path })
      return new File([await response.blob()], record.name, { type: record.mimeType })
    },
  }
}
