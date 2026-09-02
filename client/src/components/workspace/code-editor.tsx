/* ── The text surface ──
   Monaco, mounted the ordinary way: create it into a div, dispose it on
   unmount. There is no global to initialize and nothing to park — that was the
   workbench's constraint, not the editor's.

   Two things are deliberate.

   **The document is the model's, not React's.** `value` seeds it and replaces
   it when it genuinely differs (a reload, a discard), but keystrokes in between
   belong to Monaco. Pushing every character through state and back would fight
   the editor for the cursor on every keypress.

   **The model outlives the mount, keyed by URI.** A tab scrolled out of the
   dock and back is the same model, so its undo history and its folds are still
   there. The model is disposed only when the *tab* closes, which is the panel's
   call and not this component's. */
import * as React from "react"
import type * as Monaco from "monaco-editor"

import { baseEditorOptions, languageForPath, loadMonaco, syncMonacoTheme, type MonacoApi } from "@/lib/ide/monaco"
import { useTheme } from "@/lib/theme"

export interface CodeEditorProps {
  /** Identifies the model. Same value ⇒ same buffer, undo history included. */
  modelKey: string
  value: string
  /** Only used to pick the grammar. */
  filename: string
  readOnly?: boolean
  onChange?: (value: string) => void
  /** ⌘S with the caret inside the editor. */
  onSave?: () => void
  /** 1-based, inclusive. Scrolls there and puts the caret on it. */
  revealLine?: number
  /** Last line of the revealed span; the span is tinted until the first edit. */
  revealEndLine?: number
  /** Changes per request, so asking twice actually scrolls twice. */
  revealNonce?: number
}

/** Models live as long as their tab, so two components showing one file (a
    split, a re-mount) share a buffer instead of forking it. */
const models = new Map<string, Monaco.editor.ITextModel>()

export function disposeCodeModel(modelKey: string): void {
  const model = models.get(modelKey)
  if (!model) return
  models.delete(modelKey)
  model.dispose()
}

function modelFor(
  monaco: MonacoApi,
  modelKey: string,
  value: string,
  filename: string
): Monaco.editor.ITextModel {
  const existing = models.get(modelKey)
  if (existing && !existing.isDisposed()) return existing
  const model = monaco.editor.createModel(
    value,
    languageForPath(monaco, filename),
    /* Opaque on purpose: the key holds a project id and a path, and a `#` or a
       `?` in a filename would otherwise become a fragment or a query, so two
       different files could land on one URI. */
    monaco.Uri.parse(`daedalus:/${encodeURIComponent(modelKey)}`)
  )
  models.set(modelKey, model)
  return model
}

export function CodeEditor({
  modelKey,
  value,
  filename,
  readOnly,
  onChange,
  onSave,
  revealLine,
  revealEndLine,
  revealNonce,
}: CodeEditorProps) {
  const host = React.useRef<HTMLDivElement>(null)
  const editor = React.useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const api = React.useRef<MonacoApi | null>(null)
  const decorations = React.useRef<Monaco.editor.IEditorDecorationsCollection | null>(null)
  /* The model outlives the editor, so its content listener has to come off when
     this component does: a tab closed and reopened four times would otherwise
     report every keystroke four times. */
  const contentListener = React.useRef<Monaco.IDisposable | null>(null)
  const [ready, setReady] = React.useState(false)
  const { resolved } = useTheme()

  /* Handlers in refs: the editor is built once, and rebuilding it on a new
     callback identity would cost the cursor, the selection and the scroll. */
  const onChangeRef = React.useRef(onChange)
  onChangeRef.current = onChange
  const onSaveRef = React.useRef(onSave)
  onSaveRef.current = onSave
  const valueRef = React.useRef(value)
  valueRef.current = value

  React.useEffect(() => {
    let live = true
    let instance: Monaco.editor.IStandaloneCodeEditor | null = null
    void loadMonaco().then((monaco) => {
      if (!live || !host.current) return
      api.current = monaco
      syncMonacoTheme(monaco, document.documentElement.classList.contains("dark"))
      const model = modelFor(monaco, modelKey, valueRef.current, filename)
      instance = monaco.editor.create(host.current, {
        ...baseEditorOptions(),
        model,
        readOnly,
      })
      editor.current = instance
      decorations.current = instance.createDecorationsCollection([])
      instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSaveRef.current?.())
      contentListener.current = model.onDidChangeContent(() => {
        if (models.get(modelKey) !== model) return
        onChangeRef.current?.(model.getValue())
        /* The tint describes the file *as the tool call saw it*; once a line
           has been typed into, the range is a claim about text nobody read. */
        decorations.current?.clear()
      })
      setReady(true)
    })
    return () => {
      live = false
      decorations.current = null
      contentListener.current?.dispose()
      contentListener.current = null
      instance?.dispose()
      editor.current = null
      setReady(false)
    }
    /* Built once per (mount, tab). `value`, `readOnly` and the theme are pushed
       in by the effects below rather than by rebuilding. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelKey])

  React.useEffect(() => {
    const monaco = api.current
    const instance = editor.current
    if (!monaco || !instance) return
    const model = instance.getModel()
    if (!model) return
    monaco.editor.setModelLanguage(model, languageForPath(monaco, filename))
  }, [filename, ready])

  React.useEffect(() => {
    editor.current?.updateOptions({ readOnly: !!readOnly })
  }, [readOnly, ready])

  React.useEffect(() => {
    const monaco = api.current
    if (monaco) syncMonacoTheme(monaco, resolved === "dark")
  }, [resolved, ready])

  /* An outside change replaces the document through `pushEditOperations`, not
     `setValue`: the latter throws away the undo stack, so a reload after a
     rejected save would leave the reader unable to get their text back. */
  React.useEffect(() => {
    const instance = editor.current
    const model = instance?.getModel()
    if (!model || model.getValue() === value) return
    model.pushEditOperations(
      [],
      [{ range: model.getFullModelRange(), text: value }],
      () => null
    )
  }, [value, ready])

  React.useEffect(() => {
    const monaco = api.current
    const instance = editor.current
    const model = instance?.getModel()
    if (!monaco || !instance || !model || !revealLine) return
    /* Clamped: the line came from a tool that may have read a different version
       of the file, and an out-of-range line should land at the end rather than
       throw and leave the panel blank. */
    const lines = model.getLineCount()
    const clamp = (line: number) => Math.min(Math.max(1, line), lines)
    const from = clamp(revealLine)
    const to = revealEndLine && revealEndLine > revealLine ? clamp(revealEndLine) : from
    instance.setSelection(new monaco.Range(from, 1, from, 1))
    /* Scrolled to the *start* of the span even when the span is taller than the
       viewport: the top of what was read is where reading begins, and centring
       a 400-line range would show its middle and nothing else. */
    instance.revealLineNearTop(from, monaco.editor.ScrollType.Immediate)
    decorations.current?.set(
      to > from
        ? [
            {
              range: new monaco.Range(from, 1, to, model.getLineMaxColumn(to)),
              options: { isWholeLine: true, className: "daedalus-reveal-band" },
            },
          ]
        : []
    )
    instance.focus()
  }, [revealLine, revealEndLine, revealNonce, ready])

  return <div ref={host} className="h-full min-h-0 w-full overflow-hidden" />
}
