/* ── A project file, edited in place in the Preview panel ──
   Monaco on a model of the file's text. The text of an unsaved edit lives in
   `lib/workspace/edit-drafts.ts`, not in here, so switching tabs or toggling
   back to the viewer loses nothing; this component draws a draft and writes it.

   **A save is a write at the version the file was read at** (`expectedVersion`),
   so a file an agent rewrote underneath the reader is a 409 said here — with
   the two ways out, reload what is on disk or write over it — and never an edit
   that silently wins or silently loses. The same version is how the watch
   stream is read: an event on this path is answered by asking for the file's
   version, and only a version that is not the one held means somebody else wrote
   it. A clean draft follows the disk; a dirty one says so and waits.

   Text only. A binary or oversized file has no `content` to edit, and the
   viewer says why instead. */
import * as React from "react"
import type * as Monaco from "monaco-editor"

import { Empty } from "@/components/empty"
import { ErrorNote } from "@/components/error-note"
import { Notice } from "@/components/notice"
import { Button } from "@/components/ui/busy-button"
import { Skeleton } from "@/components/ui/skeleton"
import { captureError, type InlineError } from "@/lib/errors"
import { baseEditorOptions, languageForPath, loadMonaco, syncMonacoTheme, type MonacoApi } from "@/lib/ide/monaco"
import { ApiError } from "@/lib/settings"
import { useTheme } from "@/lib/theme"
import { getDraft, isDirty, setDraft, useDraft } from "@/lib/workspace/edit-drafts"
import { isConflict, readFile, statFile, writeFile } from "@/lib/workspace/fs-api"
import { watchProject } from "@/lib/workspace/watch"

type Load =
  | { state: "loading" }
  | { state: "ready" }
  | { state: "unsupported"; reason: string }
  | { state: "error"; error: InlineError | null }

export function FileEditor({ projectId, path, line }: { projectId: string; path: string; line?: number }) {
  const host = React.useRef<HTMLDivElement>(null)
  const editor = React.useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const api = React.useRef<MonacoApi | null>(null)
  const { resolved } = useTheme()
  const draft = useDraft(projectId, path)
  const dirty = isDirty(draft)

  const [load, setLoad] = React.useState<Load>({ state: "loading" })
  const [editorReady, setEditorReady] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [conflict, setConflict] = React.useState(false)
  const [external, setExternal] = React.useState(false)
  const [gone, setGone] = React.useState(false)
  const [saveError, setSaveError] = React.useState<InlineError | null>(null)

  /* The model's text and the draft are written together, in this order: the
     draft first, so the change event the model raises reads a draft that
     already says the same thing and has nothing to add. */
  const adopt = React.useCallback(
    (text: string, version: string) => {
      setDraft(projectId, path, { text, base: text, version })
      const model = editor.current?.getModel()
      if (model && model.getValue() !== text) model.setValue(text)
      setConflict(false)
      setExternal(false)
      setGone(false)
    },
    [projectId, path]
  )

  /** What is on disk, read into the draft — dropping whatever was typed. */
  const reload = React.useCallback(async () => {
    setSaveError(null)
    try {
      const file = await readFile(projectId, path)
      if (file.content === undefined) {
        setLoad({ state: "unsupported", reason: file.tooLarge ? "This file is too large to edit." : "This is a binary file, so there is nothing to edit." })
        return
      }
      adopt(file.content, file.version)
    } catch (err) {
      setSaveError(captureError(err, "Couldn't read the file"))
    }
  }, [projectId, path, adopt])

  /* The first read — unless an unsaved edit is already held for this file. */
  React.useEffect(() => {
    const controller = new AbortController()
    setLoad({ state: "loading" })
    setConflict(false)
    setExternal(false)
    setGone(false)
    setSaveError(null)
    if (getDraft(projectId, path)) {
      setLoad({ state: "ready" })
      return
    }
    readFile(projectId, path, controller.signal).then(
      (file) => {
        if (file.content === undefined) {
          setLoad({ state: "unsupported", reason: file.tooLarge ? "This file is too large to edit." : "This is a binary file, so there is nothing to edit." })
          return
        }
        setDraft(projectId, path, { text: file.content, base: file.content, version: file.version })
        setLoad({ state: "ready" })
      },
      (err) => {
        if (!controller.signal.aborted) setLoad({ state: "error", error: captureError(err, "Couldn't open the file") })
      }
    )
    return () => controller.abort()
  }, [projectId, path])

  const save = React.useCallback(
    async (force = false) => {
      const held = getDraft(projectId, path)
      if (!held || (!force && !isDirty(held))) return
      setSaving(true)
      setSaveError(null)
      try {
        const stat = await writeFile(projectId, path, held.text, { expectedVersion: held.version, force })
        /* Typing went on while the write was in flight: what was written is the
           new base, and what is on screen now is still the draft. */
        const latest = getDraft(projectId, path)
        setDraft(projectId, path, { text: latest?.text ?? held.text, base: held.text, version: stat.version })
        setConflict(false)
        setExternal(false)
        setGone(false)
      } catch (err) {
        if (isConflict(err)) setConflict(true)
        else setSaveError(captureError(err, "Couldn't save the file"))
      } finally {
        setSaving(false)
      }
    },
    [projectId, path]
  )
  /* Read by the editor's keybinding, which is wired once. */
  const saveRef = React.useRef(save)
  saveRef.current = save

  const revert = React.useCallback(() => {
    const held = getDraft(projectId, path)
    if (!held) return
    setDraft(projectId, path, { ...held, text: held.base })
    const model = editor.current?.getModel()
    if (model && model.getValue() !== held.base) model.setValue(held.base)
  }, [projectId, path])

  /* The editor, once there is a draft to put in it. */
  const ready = load.state === "ready"
  React.useEffect(() => {
    if (!ready) return
    let live = true
    let instance: Monaco.editor.IStandaloneCodeEditor | null = null
    let model: Monaco.editor.ITextModel | null = null
    void loadMonaco().then((monaco) => {
      const held = getDraft(projectId, path)
      if (!live || !host.current || !held) return
      api.current = monaco
      syncMonacoTheme(monaco, document.documentElement.classList.contains("dark"))
      model = monaco.editor.createModel(held.text, languageForPath(monaco, path))
      instance = monaco.editor.create(host.current, { ...baseEditorOptions(), model })
      editor.current = instance
      model.onDidChangeContent(() => {
        const current = getDraft(projectId, path)
        const text = model!.getValue()
        if (current && current.text !== text) setDraft(projectId, path, { ...current, text })
      })
      instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveRef.current())
      setEditorReady(true)
    })
    return () => {
      live = false
      setEditorReady(false)
      instance?.dispose()
      model?.dispose()
      editor.current = null
    }
  }, [ready, projectId, path])

  React.useEffect(() => {
    if (api.current) syncMonacoTheme(api.current, resolved === "dark")
  }, [resolved, editorReady])

  /* A line asked for by a search result. */
  React.useEffect(() => {
    if (!editorReady || line === undefined) return
    const instance = editor.current
    instance?.revealLineInCenter(line)
    instance?.setPosition({ lineNumber: line, column: 1 })
  }, [editorReady, line])

  /* The disk moving under the editor. An event on this path (or a batch too big
     to list) is answered with the file's version, and only a version that is not
     the one held is news. */
  React.useEffect(() => {
    if (!ready) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const check = async () => {
      const held = getDraft(projectId, path)
      if (!held) return
      try {
        const stat = await statFile(projectId, path)
        const now = getDraft(projectId, path)
        if (!now || stat.version === now.version) return
        if (isDirty(now)) setExternal(true)
        else await reload()
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) setGone(true)
      }
    }
    const stop = watchProject(projectId, (batch) => {
      if (!batch.overflow && !batch.events.some((event) => event.path === path)) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void check(), 200)
    })
    return () => {
      if (timer) clearTimeout(timer)
      stop()
    }
  }, [ready, projectId, path, reload])

  if (load.state === "loading")
    return (
      <div className="p-3">
        <Skeleton className="h-64 w-full" />
      </div>
    )
  if (load.state === "error") return <ErrorNote error={load.error} className="m-2.5" />
  if (load.state === "unsupported")
    return (
      <div className="p-2.5">
        <Empty size="sm">{load.reason}</Empty>
      </div>
    )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-8 shrink-0 items-center gap-1 border-b px-2 py-1 text-xs">
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {gone ? "Deleted or renamed on disk" : dirty ? "Unsaved changes" : "Saved - Ctrl/Cmd+S to save"}
        </span>
        <Button size="xs" variant="ghost" disabled={!dirty || saving} onClick={revert} title="Put back the text as it was last saved">
          Revert
        </Button>
        <Button size="xs" loading={saving} disabled={!dirty} onClick={() => void save()}>
          Save
        </Button>
      </div>
      {conflict && (
        <Notice
          tone="warn"
          title="The file changed on disk"
          className="m-1.5"
          action={
            <span className="flex shrink-0 gap-1">
              <Button size="xs" variant="outline" onClick={() => void reload()}>
                Reload
              </Button>
              <Button size="xs" variant="outline" onClick={() => void save(true)}>
                Overwrite
              </Button>
            </span>
          }
        >
          Someone wrote this file since it was opened. Reload takes what is on disk and drops your edits; Overwrite
          saves yours over it.
        </Notice>
      )}
      {external && !conflict && (
        <Notice
          tone="info"
          title="Changed on disk"
          className="m-1.5"
          action={
            <Button size="xs" variant="outline" onClick={() => void reload()}>
              Reload
            </Button>
          }
        >
          This file was written while you have unsaved edits. Saving will ask before it writes over it.
        </Notice>
      )}
      {gone && (
        <Notice
          tone="warn"
          title="This file is gone"
          className="m-1.5"
          action={
            <Button size="xs" variant="outline" onClick={() => void save(true)}>
              Write it again
            </Button>
          }
        >
          It was deleted or renamed outside this panel. Your text is still here.
        </Notice>
      )}
      <ErrorNote error={saveError} className="m-1.5" />
      <div ref={host} className="min-h-0 flex-1 overflow-hidden" />
    </div>
  )
}
