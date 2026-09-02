/* ── Side-by-side comparison ──
   Monaco's own diff editor. `components/ui/diff-view.tsx` stays what it is — a
   dependency-free line LCS for the small diffs a tool call reports inline in a
   transcript. It is the right thing there and the wrong thing here: a
   whole-file comparison wants syntax colour, scroll sync and a viewport that
   does not render ten thousand lines to show you three.

   Both sides are read-only. This surface is for *seeing* what differs; editing
   happens in the file tab, which owns the dirty state and the save. Two places
   that can both write one buffer is how they come to disagree. */
import * as React from "react"
import type * as Monaco from "monaco-editor"

import { baseEditorOptions, languageForPath, loadMonaco, syncMonacoTheme, type MonacoApi } from "@/lib/ide/monaco"
import { useTheme } from "@/lib/theme"
import { useCoarsePointer } from "@/hooks/use-mobile"

export function DiffEditor({
  original,
  modified,
  filename,
}: {
  /** The left side: HEAD, the index, or a turn's starting tree. */
  original: string
  /** The right side: what is there now. */
  modified: string
  filename: string
}) {
  const host = React.useRef<HTMLDivElement>(null)
  const editor = React.useRef<Monaco.editor.IStandaloneDiffEditor | null>(null)
  const api = React.useRef<MonacoApi | null>(null)
  const [ready, setReady] = React.useState(false)
  const { resolved } = useTheme()
  /* Two panes side by side need room; on a phone, and in a narrow panel, they
     are stacked into one inline diff instead. The pointer answers "phone", the
     panel's own width answers "narrow" — so this reads both. */
  const coarse = useCoarsePointer()

  React.useEffect(() => {
    let live = true
    let instance: Monaco.editor.IStandaloneDiffEditor | null = null
    void loadMonaco().then((monaco) => {
      if (!live || !host.current) return
      api.current = monaco
      syncMonacoTheme(monaco, document.documentElement.classList.contains("dark"))
      instance = monaco.editor.createDiffEditor(host.current, {
        ...baseEditorOptions(),
        readOnly: true,
        originalEditable: false,
        renderSideBySide: !coarse,
        /* A file with three changed lines in a thousand is unreadable as a
           thousand lines; the unchanged runs fold with a few lines of context. */
        hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 6 },
        renderOverviewRuler: false,
      })
      editor.current = instance
      setReady(true)
    })
    return () => {
      live = false
      /* The models are this component's — they name nothing outside it — so
         they go when it does, unlike a file tab's. */
      const model = instance?.getModel()
      instance?.dispose()
      model?.original.dispose()
      model?.modified.dispose()
      editor.current = null
      setReady(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  React.useEffect(() => {
    const monaco = api.current
    const instance = editor.current
    if (!monaco || !instance) return
    const language = languageForPath(monaco, filename)
    const previous = instance.getModel()
    instance.setModel({
      original: monaco.editor.createModel(original, language),
      modified: monaco.editor.createModel(modified, language),
    })
    previous?.original.dispose()
    previous?.modified.dispose()
  }, [original, modified, filename, ready])

  React.useEffect(() => {
    editor.current?.updateOptions({ renderSideBySide: !coarse })
  }, [coarse, ready])

  React.useEffect(() => {
    const monaco = api.current
    if (monaco) syncMonacoTheme(monaco, resolved === "dark")
  }, [resolved, ready])

  return <div ref={host} className="h-full min-h-0 w-full overflow-hidden" />
}
