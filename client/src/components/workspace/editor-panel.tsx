/* ── Editor ──
   One panel, four modes: `text`, `diff`, `preview`, `unsupported`. A diff is a
   way of looking at a file, not another kind of thing to look at, and an image
   is what the editor does when the bytes are not editable text — so they are
   modes here rather than panel types of their own. That is what keeps save,
   dirty state and the conflict flow from existing in three slightly different
   versions.

   `unsupported` is decided from the server's own answer (`binary` / `tooLarge`)
   before any content is rendered, not guessed at from an extension.

   The conflict flow is the interesting part. Every read carries a `version`;
   every write sends back the version it started from, and the server answers
   409 rather than overwriting. So there are two ways to learn a file moved
   underneath you — the watcher says so while you type, or the save is refused —
   and both land in the same place: a bar offering reload, compare or overwrite.
   Overwrite is a decision the user makes, never a retry the client does. */
import * as React from "react"
import type { IDockviewPanelProps } from "dockview-react"
import {
  ArrowLeftRightIcon,
  EyeIcon,
  FileWarningIcon,
  PencilLineIcon,
  RefreshCwIcon,
  SaveIcon,
  Undo2Icon,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Prose } from "@/components/thread-items"
import { useConfirm } from "@/components/confirm-dialog"
import { CodeEditor } from "@/components/workspace/code-editor"
import { DiffEditor } from "@/components/workspace/diff-editor"
import { useDock } from "@/components/workspace/dock"
import { useHotkey } from "@/hooks/use-hotkey"
import { describeError, reportError } from "@/lib/errors"
import { KEYS } from "@/lib/shortcuts"
import { useStore } from "@/lib/store"
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
import { gitFileAt } from "@/lib/workspace/git-api"
import { panelId } from "@/lib/workspace/panels"
import { consumeReveal, onReveal } from "@/lib/workspace/reveal"
import { watchProject } from "@/lib/workspace/watch"

/** Extensions rendered as something other than code. Everything else that is
    text goes to the editor; everything that is not is `unsupported`. */
const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"])
const MARKDOWN = new Set(["md", "markdown", "mdx"])

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

export function EditorPanel({
  api,
  params,
}: IDockviewPanelProps<{ projectId: string; path: string; comparison?: string }>) {
  const { projectId, path, comparison } = params
  const dock = useDock()
  const confirm = useConfirm()
  const { state } = useStore()
  const project = state.projects.find((candidate) => candidate.id === projectId)

  const [file, setFile] = React.useState<WorkspaceFile | null>(null)
  const [draft, setDraft] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [conflict, setConflict] = React.useState<Conflict>(null)
  /* Two sources for the left-hand side of a comparison. Without a `comparison`
     param it is what is on disk, which is the "what have I typed" diff the
     toolbar button asks for. With one it is a git revision, fetched below —
     same panel, same mode, different left side. */
  const [showDiff, setShowDiff] = React.useState(!!comparison)
  const [baseline, setBaseline] = React.useState<string | null>(null)
  /* `api.isActive` is read once per render, not subscribed to — a panel that
     becomes active does not re-render on its own, so ⌘S would stay bound to
     whichever editor happened to be in front when React last ran. */
  const [active, setActive] = React.useState(api.isActive)
  React.useEffect(() => {
    const disposable = api.onDidActiveChange((event) => setActive(event.isActive))
    return () => disposable.dispose()
  }, [api])

  /* A reveal can arrive before this panel exists (the click that opened it) or
     while it is already open, so both paths are handled: consume on every load,
     and subscribe for the ones that land later. */
  const [reveal, setReveal] = React.useState<{ line: number; column?: number; nonce: number } | null>(
    null
  )
  const takeReveal = React.useCallback(() => {
    const pending = consumeReveal(projectId, path)
    if (pending) setReveal((current) => ({ ...pending, nonce: (current?.nonce ?? 0) + 1 }))
  }, [projectId, path])
  React.useEffect(() => {
    takeReveal()
    return onReveal(takeReveal)
  }, [takeReveal])

  /* The image preview. Fetched with the bearer header and held as an object
     URL, because an <img> cannot send one — and revoked when the panel moves
     on, or the blob stays alive for the life of the document. */
  const [imageUrl, setImageUrl] = React.useState<string | null>(null)

  const dirty = draft !== null && file != null && draft !== file.content
  /* Markdown opens rendered, because that is what you usually want a README
     for — but it is a *mode*, not a verdict. Deriving it from `!dirty` (the
     first cut of this) meant the file could only become editable once it was
     already edited, which is not a state you can reach. */
  const canPreview = MARKDOWN.has(extensionOf(path))
  const [preview, setPreview] = React.useState(canPreview)

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
             disk — otherwise the panel would open "dirty" with nothing to save.
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

  /* ── Title, dirty marker, close guard ────────────────────────────────────── */

  React.useEffect(() => {
    api.setTitle(`${dirty ? "● " : ""}${basename(path) || "Editor"}`)
  }, [api, path, dirty])

  const dirtyRef = React.useRef(dirty)
  dirtyRef.current = dirty
  React.useEffect(
    () =>
      /* The dock routes every close through here, which is the whole reason the
         default tab was replaced. Discarding is explicit; there is no timeout
         and no "saving in the background". */
      dock.registerCloseGuard(panelId({ kind: "editor", projectId, path, comparison }), async () => {
        if (!dirtyRef.current) return true
        const discard = await confirm({
          title: `Discard changes to ${basename(path)}?`,
          description: "The edits in this panel have not been written to disk.",
          confirmLabel: "Discard",
          destructive: true,
        })
        if (discard) clearBuffer(projectId, path)
        return discard
      }),
    [dock, confirm, projectId, path, comparison]
  )

  /* ── Watching ────────────────────────────────────────────────────────────── */

  React.useEffect(
    () =>
      watchProject(projectId, (batch) => {
        const touched = batch.events.some(
          (event) => event.path === path || path.startsWith(`${event.path}/`)
        )
        if (!batch.overflow && !touched) return
        /* Clean and untouched by the user: just take the new content. Dirty:
           say so and let them choose — silently replacing what someone is
           typing because a formatter ran is the worst possible answer. */
        if (dirtyRef.current) setConflict("disk-changed")
        else void load()
      }),
    [projectId, path, load]
  )

  /* The git side of a comparison. Fetched once per (path, comparison): a
     revision does not change, so re-reading it on every keystroke would be
     pure waste — and a missing file on that side is a real answer (the file is
     new), which renders as an empty left pane rather than an error. */
  React.useEffect(() => {
    if (!comparison || comparison === "worktree") {
      setBaseline(null)
      return
    }
    let cancelled = false
    void gitFileAt(projectId, path, comparison === "staged" ? "staged" : "head")
      .then((result) => {
        if (!cancelled) setBaseline(result.content)
      })
      .catch(() => {
        if (!cancelled) setBaseline("")
      })
    return () => {
      cancelled = true
    }
  }, [projectId, path, comparison])

  /* An image is `binary` to the file API, so its bytes never arrive through
     the JSON route — they come from `/file-raw`, and only for the extensions
     the server is willing to name a content type for. */
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

  const save = React.useCallback(
    async (options: { force?: boolean } = {}) => {
      const content = draftRef.current
      const current = fileRef.current
      if (content === null || !current || saving) return
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
    [projectId, path, saving]
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

  // ⌘S while this panel is the one in front. The editor binds it too, for when
  // the caret is inside it; this is the same action from the toolbar's scope.
  useHotkey(
    KEYS.save,
    (event) => {
      event.preventDefault()
      void save()
    },
    { enabled: active && dirty }
  )

  /* ── Render ──────────────────────────────────────────────────────────────── */

  if (!project) return <Centered>This project no longer exists.</Centered>
  if (loading && !file) return <Centered>Loading…</Centered>
  if (error) {
    return (
      <Centered>
        <p className="max-w-sm">{error}</p>
        <Button size="sm" variant="outline" onClick={() => void load()}>
          Try again
        </Button>
      </Centered>
    )
  }
  if (!file) return <Centered>Nothing to show.</Centered>

  const unsupported = file.binary || file.tooLarge
  const isImage = IMAGES.has(extensionOf(path))
  const compareLabel =
    comparison === "staged"
      ? "Compare with the staged version"
      : comparison === "head"
        ? "Compare with the last commit"
        : "Compare with the file on disk"

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1">
        <span
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground"
          title={path}
        >
          {path}
        </span>
        {!unsupported && canPreview && (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={preview ? "Edit the source" : "Render the markdown"}
            title={preview ? "Edit the source" : "Render the markdown"}
            className={cn("size-6", preview && "text-primary")}
            onClick={() => setPreview((current) => !current)}
          >
            {preview ? <PencilLineIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
          </Button>
        )}
        {!unsupported && (
          <>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={showDiff ? "Stop comparing" : compareLabel}
              title={showDiff ? "Stop comparing" : compareLabel}
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
              title={`Save · ${KEYS.save}`}
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
      </div>

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
          <DiffEditor
            original={comparison ? (baseline ?? "") : (file.content ?? "")}
            modified={draft ?? ""}
            filename={path}
          />
        </div>
      ) : preview && !reveal ? (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <Prose text={draft ?? ""} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-hidden">
          <CodeEditor
            value={draft ?? ""}
            filename={path}
            onChange={onChange}
            onSave={() => void save()}
            revealLine={reveal?.line}
            revealColumn={reveal?.column}
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

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 p-8 text-center text-xs text-muted-foreground">
      {children}
    </div>
  )
}
