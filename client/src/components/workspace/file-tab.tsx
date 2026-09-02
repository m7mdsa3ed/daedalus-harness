/* ── One open file ──
   The editing surface: read, edit, save, and the conflict flow.

   The conflict flow is the part worth keeping careful. Every read carries a
   `version`; every write sends back the version it started from, and the server
   answers 409 rather than overwriting. So there are two ways to learn a file
   moved underneath you — the watcher says so while you type, or the save is
   refused — and both land in the same place: a bar offering reload, compare or
   overwrite. Overwrite is a decision the reader makes, never a retry the client
   does quietly.

   Unsaved text also survives a *reload of the page* (`lib/workspace/buffers.ts`),
   because this app reloads itself on purpose when a service-worker update is
   taken. Losing a buffer to a version bump would be the app eating your work.

   A file that is not text is not an editor: `binary`/`tooLarge` is the server's
   own answer, decided before any content is rendered rather than guessed from
   the extension, and an image is shown as one. */
import * as React from "react"
import { ArrowLeftRightIcon, FileWarningIcon, RefreshCwIcon, SaveIcon, Undo2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useConfirm } from "@/components/confirm-dialog"
import { CodeEditor } from "@/components/workspace/code-editor"
import { DiffEditor } from "@/components/workspace/diff-editor"
import { PanelEmptyState, PanelToolbar } from "@/components/workspace/primitives"
import { describeError, reportError } from "@/lib/errors"
import { consumeReveal, setTabDirty, type Reveal } from "@/lib/ide/editors"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"
import { clearBuffer, loadBuffer, saveBuffer } from "@/lib/workspace/buffers"
import {
  basename,
  isConflict,
  readFile,
  readFileObjectUrl,
  writeFile,
  type WorkspaceFile,
} from "@/lib/workspace/fs-api"
import { watchProject } from "@/lib/workspace/watch"

const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg"])

const extensionOf = (path: string): string => {
  const name = basename(path).toLowerCase()
  return name.includes(".") ? (name.split(".").pop() ?? "") : ""
}

const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

type Conflict = null | "disk-changed" | "save-refused"

export function FileTab({
  projectId,
  tabId,
  path,
  reveal,
  active,
}: {
  projectId: string
  tabId: string
  path: string
  reveal?: Reveal
  /** Only the tab in front binds ⌘S; every tab stays mounted. */
  active: boolean
}) {
  const confirm = useConfirm()

  const [file, setFile] = React.useState<WorkspaceFile | null>(null)
  const [draft, setDraft] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [conflict, setConflict] = React.useState<Conflict>(null)
  const [showDiff, setShowDiff] = React.useState(false)
  const [imageUrl, setImageUrl] = React.useState<string | null>(null)

  const dirty = draft !== null && file != null && draft !== file.content

  /* ── Loading ─────────────────────────────────────────────────────────────── */

  const abort = React.useRef<AbortController | null>(null)
  const load = React.useCallback(
    async (options: { keepDraft?: boolean } = {}) => {
      abort.current?.abort()
      const controller = new AbortController()
      abort.current = controller
      setLoading(true)
      try {
        const next = await readFile(projectId, path, controller.signal)
        if (controller.signal.aborted) return
        setFile(next)
        setError(null)
        setConflict(null)
        if (!options.keepDraft) {
          /* A buffer is restored only when it is *different* from what is on
             disk — otherwise the tab would open "dirty" with nothing to save.
             A stale base version does not block the restore; it becomes the
             conflict, which is the honest thing to show. */
          const stored = loadBuffer(projectId, path)
          if (stored && stored.content !== next.content) {
            setDraft(stored.content)
            if (stored.baseVersion !== next.version) setConflict("disk-changed")
          } else {
            setDraft(next.content ?? null)
            if (stored) clearBuffer(projectId, path)
          }
        }
      } catch (err) {
        if (controller.signal.aborted) return
        const { title, detail } = describeError(err)
        setError(detail ? `${title} — ${detail}` : title)
        setFile(null)
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    },
    [projectId, path]
  )

  React.useEffect(() => {
    void load()
    return () => abort.current?.abort()
  }, [load])

  /* The tab bar draws the dot, and closing a dirty tab asks first — both read
     the store, so this is where the editor tells it. */
  React.useEffect(() => {
    setTabDirty(projectId, tabId, dirty)
  }, [projectId, tabId, dirty])

  /* ── Watching ────────────────────────────────────────────────────────────── */

  const dirtyRef = React.useRef(dirty)
  dirtyRef.current = dirty
  React.useEffect(
    () =>
      watchProject(projectId, (batch) => {
        const touched = batch.events.some(
          (event) => event.path === path || path.startsWith(`${event.path}/`)
        )
        if (!batch.overflow && !touched) return
        /* Clean and untouched by the reader: just take the new content. Dirty:
           say so and let them choose — silently replacing what someone is
           typing because a formatter ran is the worst possible answer. */
        if (dirtyRef.current) setConflict("disk-changed")
        else void load()
      }),
    [projectId, path, load]
  )

  /* An image is `binary` to the file API, so its bytes never arrive through the
     JSON route — they come from `/file-raw`, held as an object URL because an
     `<img>` cannot send the bearer header. */
  React.useEffect(() => {
    if (!file?.binary || !IMAGES.has(extensionOf(path))) return
    const controller = new AbortController()
    let url: string | null = null
    void readFileObjectUrl(projectId, path, controller.signal)
      .then((created) => {
        if (controller.signal.aborted) {
          URL.revokeObjectURL(created)
          return
        }
        url = created
        setImageUrl(created)
      })
      .catch(() => {
        /* Falls through to the "isn't text" card, which is the honest
           fallback — an image that will not load is a file we cannot show. */
      })
    return () => {
      controller.abort()
      if (url) URL.revokeObjectURL(url)
      setImageUrl(null)
    }
  }, [projectId, path, file?.binary, file?.version])

  /* ── Saving ──────────────────────────────────────────────────────────────── */

  const draftRef = React.useRef(draft)
  draftRef.current = draft
  const fileRef = React.useRef(file)
  fileRef.current = file
  const savingRef = React.useRef(saving)
  savingRef.current = saving

  const save = React.useCallback(
    async (options: { force?: boolean } = {}) => {
      const content = draftRef.current
      const current = fileRef.current
      if (content === null || !current || savingRef.current) return
      setSaving(true)
      try {
        const stat = await writeFile(projectId, path, content, {
          expectedVersion: current.version,
          force: options.force,
        })
        setFile({ ...current, ...stat, content })
        setConflict(null)
        clearBuffer(projectId, path)
      } catch (err) {
        if (isConflict(err)) {
          setConflict("save-refused")
          return
        }
        reportError(err, "Couldn't save the file")
      } finally {
        setSaving(false)
      }
    },
    [projectId, path]
  )

  /* The buffer is written on every change, not on an interval: the reload this
     protects against (a service-worker update) does not warn first, so there is
     no moment later at which to flush. */
  const onChange = React.useCallback(
    (value: string) => {
      setDraft(value)
      const current = fileRef.current
      if (!current) return
      if (value === current.content) clearBuffer(projectId, path)
      else saveBuffer(projectId, path, value, current.version)
    },
    [projectId, path]
  )

  const revert = React.useCallback(async () => {
    if (dirtyRef.current) {
      const ok = await confirm({
        title: `Discard changes to ${basename(path)}?`,
        description: "The file is re-read from disk and your edits are lost.",
        confirmLabel: "Discard",
        destructive: true,
      })
      if (!ok) return
    }
    clearBuffer(projectId, path)
    setDraft(null)
    await load()
  }, [confirm, load, path, projectId])

  /* ⌘S while this tab is the one in front. Monaco binds the same chord for the
     caret inside the editor; this is the same action from the tab's scope, and
     it is not `useShortcut` because the IDE's ⌘S is not rebindable app state —
     it is what ⌘S means in every editor there has ever been. */
  React.useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return
      event.preventDefault()
      if (dirtyRef.current) void save()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [active, save])

  /* A reveal is taken once: the request scrolled this tab, and a re-render is
     not a second request. */
  const revealNonce = reveal?.nonce
  React.useEffect(() => {
    if (revealNonce === undefined) return
    consumeReveal(projectId, tabId)
  }, [projectId, tabId, revealNonce])

  /* ── Render ──────────────────────────────────────────────────────────────── */

  if (loading && !file) return <PanelEmptyState>Loading…</PanelEmptyState>
  if (error) {
    return (
      <PanelEmptyState>
        <p className="max-w-sm">{error}</p>
        <Button size="sm" variant="outline" onClick={() => void load()}>
          Try again
        </Button>
      </PanelEmptyState>
    )
  }
  if (!file) return <PanelEmptyState>Nothing to show.</PanelEmptyState>

  const unsupported = file.binary || file.tooLarge
  const isImage = IMAGES.has(extensionOf(path))

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={path}>
          {path}
        </span>
        {!unsupported && (
          <>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={showDiff ? "Stop comparing" : "Compare with the file on disk"}
              title={showDiff ? "Stop comparing" : "Compare with the file on disk"}
              className={cn("size-6", showDiff && "text-primary")}
              onClick={() => setShowDiff((current) => !current)}
            >
              <ArrowLeftRightIcon className="size-3.5" />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Discard changes"
              title="Discard changes"
              className="size-6"
              disabled={!dirty}
              onClick={() => void revert()}
            >
              <Undo2Icon className="size-3.5" />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Save"
              title="Save · ⌘S"
              className={cn("size-6", dirty && "text-primary")}
              disabled={!dirty || saving}
              onClick={() => void save()}
            >
              <SaveIcon className="size-3.5" />
            </Button>
          </>
        )}
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Reload from disk"
          title="Reload from disk"
          className="size-6"
          onClick={() => void revert()}
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </PanelToolbar>

      {conflict && (
        <ConflictBar
          reason={conflict}
          onReload={() => void revert()}
          onCompare={() => setShowDiff(true)}
          onOverwrite={async () => {
            const ok = await confirm({
              title: `Overwrite ${basename(path)}?`,
              description:
                "The file changed on disk after you started editing. Saving replaces those changes with yours.",
              confirmLabel: "Overwrite",
              destructive: true,
            })
            if (!ok) return
            await save({ force: true })
            toast.success("Saved over the file on disk")
          }}
        />
      )}

      {unsupported ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          {isImage && imageUrl && !file.tooLarge ? (
            <img
              src={imageUrl}
              alt={basename(path)}
              className="max-h-full max-w-full rounded-md border border-border/60 object-contain"
            />
          ) : (
            <>
              <FileWarningIcon className="size-6 text-muted-foreground" />
              <div className="space-y-1">
                <p className="text-sm font-medium">
                  {file.tooLarge ? "This file is too large to open here" : "This file isn't text"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {basename(path)} · {formatSize(file.size)}
                </p>
              </div>
            </>
          )}
        </div>
      ) : showDiff ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <DiffEditor original={file.content ?? ""} modified={draft ?? ""} filename={path} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-hidden">
          <CodeEditor
            modelKey={`${projectId}:${path}`}
            value={draft ?? ""}
            filename={path}
            onChange={onChange}
            onSave={() => void save()}
            revealLine={reveal?.line}
            revealEndLine={reveal?.endLine}
            revealNonce={reveal?.nonce}
          />
        </div>
      )}
    </div>
  )
}

function ConflictBar({
  reason,
  onReload,
  onCompare,
  onOverwrite,
}: {
  reason: Exclude<Conflict, null>
  onReload: () => void
  onCompare: () => void
  onOverwrite: () => void
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 bg-muted/40 px-2 py-1.5 text-xs">
      <span className="min-w-0 flex-1">
        {reason === "save-refused"
          ? "This file changed on disk, so the save was refused."
          : "This file changed on disk while you were editing."}
      </span>
      <Button size="xs" variant="ghost" onClick={onCompare}>
        Compare
      </Button>
      <Button size="xs" variant="ghost" onClick={onReload}>
        Reload
      </Button>
      <Button size="xs" variant="outline" onClick={onOverwrite}>
        Overwrite
      </Button>
    </div>
  )
}
