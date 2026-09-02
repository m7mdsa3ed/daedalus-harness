/* ── The workbench's view of a project's files ──
   VS Code reads and writes through `IFileService`, and this is the provider
   behind `file://` for it: every call becomes one of the harness's workspace
   routes (`lib/workspace/fs-api.ts`), addressed by the project whose cwd
   encloses the path. Nothing is cached here — the file service has its own
   model cache and its own dirty tracking, and a second copy of either would
   be the thing that disagrees with the disk.

   Watching is the project watch stream (`lib/workspace/watch.ts`), one per
   project however many watches the workbench opens, translated into the
   `IFileChange` shape. A rename event says nothing about which side of the
   rename this path is on, so it is settled by a stat. */
import {
  FileChangeType,
  FileSystemProviderCapabilities,
  FileSystemProviderErrorCode,
  FileType,
  createFileSystemProviderError,
  type IFileChange,
  type IFileDeleteOptions,
  type IFileOverwriteOptions,
  type IFileSystemProviderWithFileReadWriteCapability,
  type IFileWriteOptions,
  type IStat,
  type IWatchOptions,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/files/common/files"
import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri"
import { Emitter, Event } from "@codingame/monaco-vscode-api/vscode/vs/base/common/event"
import type { IDisposable } from "@codingame/monaco-vscode-api/vscode/vs/base/common/lifecycle"

import { ApiError } from "@/lib/settings"
import {
  createEntry,
  deleteEntry,
  listTree,
  readFile,
  readFileBytes,
  renameEntry,
  statFile,
  writeFile,
  type WorkspaceStat,
} from "@/lib/workspace/fs-api"
import { watchProject } from "@/lib/workspace/watch"

import { absolutePath, isAncestorOfProject, locate, type Located } from "./projects"

const notFound = (uri: URI) =>
  createFileSystemProviderError(`${uri.path} was not found`, FileSystemProviderErrorCode.FileNotFound)

/** The server's failure, in the code the file service branches on. */
function translate(err: unknown, uri: URI): Error {
  if (err instanceof ApiError) {
    if (err.status === 404) return notFound(uri)
    if (err.status === 409)
      return createFileSystemProviderError(err.message, FileSystemProviderErrorCode.FileExists)
    if (err.status === 400)
      return createFileSystemProviderError(err.message, FileSystemProviderErrorCode.NoPermissions)
    if (err.status === 0)
      return createFileSystemProviderError(err.message, FileSystemProviderErrorCode.Unavailable)
  }
  return err instanceof Error
    ? createFileSystemProviderError(err.message, FileSystemProviderErrorCode.Unknown)
    : createFileSystemProviderError(String(err), FileSystemProviderErrorCode.Unknown)
}

/** `version` is `${mtimeNs}-${size}` — see `versionOf` on the server. */
function mtimeOf(stat: WorkspaceStat): number {
  const head = stat.version.split("-")[0] ?? "0"
  if (head.length > 13) {
    try {
      return Number(BigInt(head) / 1_000_000n)
    } catch {
      /* fall through */
    }
  }
  return Number(head) || 0
}

const toStat = (stat: WorkspaceStat): IStat => ({
  type: stat.type === "dir" ? FileType.Directory : FileType.File,
  ctime: 0,
  mtime: mtimeOf(stat),
  size: stat.size,
})

const DIRECTORY: IStat = { type: FileType.Directory, ctime: 0, mtime: 0, size: 0 }

interface ProjectWatch {
  count: number
  stop: () => void
}

export class HarnessFileSystemProvider implements IFileSystemProviderWithFileReadWriteCapability {
  readonly capabilities: FileSystemProviderCapabilities =
    FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.PathCaseSensitive
  readonly onDidChangeCapabilities = Event.None

  private readonly changes = new Emitter<readonly IFileChange[]>()
  readonly onDidChangeFile = this.changes.event

  private readonly watches = new Map<string, ProjectWatch>()

  private located(uri: URI): Located {
    const found = locate(uri.path)
    if (!found) throw notFound(uri)
    return found
  }

  async stat(uri: URI): Promise<IStat> {
    const found = locate(uri.path)
    if (!found) {
      if (isAncestorOfProject(uri.path)) return DIRECTORY
      throw notFound(uri)
    }
    if (found.relative === "") return DIRECTORY
    try {
      return toStat(await statFile(found.project.id, found.relative))
    } catch (err) {
      throw translate(err, uri)
    }
  }

  async readdir(uri: URI): Promise<[string, FileType][]> {
    const found = this.located(uri)
    try {
      const listing = await listTree(found.project.id, found.relative)
      return listing.entries.map((entry) => [
        entry.name,
        entry.type === "dir" ? FileType.Directory : FileType.File,
      ])
    } catch (err) {
      throw translate(err, uri)
    }
  }

  async readFile(uri: URI): Promise<Uint8Array> {
    const found = this.located(uri)
    try {
      const file = await readFile(found.project.id, found.relative)
      if (file.type === "dir")
        throw createFileSystemProviderError(
          `${uri.path} is a directory`,
          FileSystemProviderErrorCode.FileIsADirectory
        )
      if (file.content !== undefined) return new TextEncoder().encode(file.content)
      /* Binary or too large for the text route: the bytes are the answer, and
         what to do with them (an image, a hex view, a refusal) is the
         workbench's decision. */
      return await readFileBytes(found.project.id, found.relative)
    } catch (err) {
      throw translate(err, uri)
    }
  }

  async writeFile(uri: URI, content: Uint8Array, opts: IFileWriteOptions): Promise<void> {
    const found = this.located(uri)
    try {
      if (!opts.create || !opts.overwrite) {
        const exists = await statFile(found.project.id, found.relative).then(
          () => true,
          (err) => {
            if (err instanceof ApiError && err.status === 404) return false
            throw err
          }
        )
        if (!exists && !opts.create) throw notFound(uri)
        if (exists && !opts.overwrite)
          throw createFileSystemProviderError(
            `${uri.path} already exists`,
            FileSystemProviderErrorCode.FileExists
          )
      }
      /* The route takes text, so the bytes are decoded as UTF-8. The
         workbench only writes what it edited — text — and a binary file it
         opened in a viewer is never written back through here. */
      await writeFile(found.project.id, found.relative, new TextDecoder().decode(content), {
        force: true,
      })
    } catch (err) {
      throw translate(err, uri)
    }
  }

  async mkdir(uri: URI): Promise<void> {
    const found = this.located(uri)
    try {
      await createEntry(found.project.id, found.relative, "dir")
    } catch (err) {
      throw translate(err, uri)
    }
  }

  async delete(uri: URI, _opts: IFileDeleteOptions): Promise<void> {
    const found = this.located(uri)
    if (found.relative === "")
      throw createFileSystemProviderError(
        "The project root cannot be deleted",
        FileSystemProviderErrorCode.NoPermissions
      )
    try {
      await deleteEntry(found.project.id, found.relative)
    } catch (err) {
      throw translate(err, uri)
    }
  }

  async rename(from: URI, to: URI, _opts: IFileOverwriteOptions): Promise<void> {
    const source = this.located(from)
    const target = this.located(to)
    if (source.project.id !== target.project.id)
      throw createFileSystemProviderError(
        "A file cannot be moved between projects",
        FileSystemProviderErrorCode.Unavailable
      )
    try {
      await renameEntry(source.project.id, source.relative, target.relative)
    } catch (err) {
      throw translate(err, from)
    }
  }

  watch(uri: URI, _opts: IWatchOptions): IDisposable {
    const found = locate(uri.path)
    if (!found) return { dispose() {} }
    const { project } = found
    let entry = this.watches.get(project.id)
    if (!entry) {
      const stop = watchProject(project.id, (batch) => {
        if (batch.overflow) {
          this.changes.fire([
            { type: FileChangeType.UPDATED, resource: URI.file(absolutePath(project.cwd, "")) },
          ])
          return
        }
        const settled: IFileChange[] = []
        const pending: Promise<void>[] = []
        for (const event of batch.events) {
          const resource = URI.file(absolutePath(project.cwd, event.path))
          if (event.kind === "change") {
            settled.push({ type: FileChangeType.UPDATED, resource })
            continue
          }
          pending.push(
            statFile(project.id, event.path).then(
              () => {
                settled.push({ type: FileChangeType.ADDED, resource })
              },
              () => {
                settled.push({ type: FileChangeType.DELETED, resource })
              }
            )
          )
        }
        void Promise.all(pending).then(() => {
          if (settled.length > 0) this.changes.fire(settled)
        })
      })
      entry = { count: 0, stop }
      this.watches.set(project.id, entry)
    }
    entry.count += 1
    return {
      dispose: () => {
        const current = this.watches.get(project.id)
        if (!current) return
        current.count -= 1
        if (current.count > 0) return
        current.stop()
        this.watches.delete(project.id)
      },
    }
  }
}
