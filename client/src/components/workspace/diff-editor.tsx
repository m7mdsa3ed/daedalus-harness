/* ── Side-by-side comparison ──
   Monaco's own diff editor. `components/ui/diff-view.tsx` stays what it is — a
   dependency-free line LCS for the small diffs a tool call reports inline in a
   transcript. It is the right thing there and the wrong thing here: a
   whole-file comparison wants syntax colour, scroll sync and a viewport that
   does not render ten thousand lines to show you three.

   Both sides are read-only. This surface is for *seeing* what differs; editing
   happens in the file tab, which owns the dirty state and the save. Two places
   that can both write one buffer is how they come to disagree.

   Two opt-ins, for the thread inspector's review: `review` puts a "+" in the
   gutter of the line under the pointer (a click there — with the selection, if
   the line is inside one — is a comment's anchor) and marks the lines already
   commented; `onLineChanges` hands out Monaco's own hunks whenever it
   recomputes them, which is what the hunk actions act on. */
import * as React from "react"
import type * as Monaco from "monaco-editor"

import { baseEditorOptions, languageForPath, loadMonaco, syncMonacoTheme, type MonacoApi } from "@/lib/ide/monaco"
import { useTheme } from "@/lib/theme"
import { useCoarsePointer } from "@/hooks/use-device"

export interface ReviewAnchor {
  side: "original" | "modified"
  line: number
  endLine: number
  /** The lines, as they read now. */
  code: string
}

export interface DiffReview {
  /** Lines already carrying a comment. */
  marks: readonly Omit<ReviewAnchor, "code">[]
  onComment: (anchor: ReviewAnchor) => void
}

export function DiffEditor({
  original,
  modified,
  filename,
  review,
  inline = false,
  onLineChanges,
  editorRef,
}: {
  /** The left side: HEAD, the index, or a turn's starting tree. */
  original: string
  /** The right side: what is there now. */
  modified: string
  filename: string
  review?: DiffReview
  /** One stacked column whatever the width — for a diff drawn inside a list. */
  inline?: boolean
  onLineChanges?: (changes: Monaco.editor.ILineChange[]) => void
  /** The live instance, for a caller that reveals a hunk. */
  editorRef?: React.RefObject<Monaco.editor.IStandaloneDiffEditor | null>
}) {
  const host = React.useRef<HTMLDivElement>(null)
  const editor = React.useRef<Monaco.editor.IStandaloneDiffEditor | null>(null)
  const api = React.useRef<MonacoApi | null>(null)
  const [ready, setReady] = React.useState(false)
  const { resolved } = useTheme()
  /* Two panes side by side need room; on a phone, and in a narrow panel, they
     are stacked into one inline diff instead. The pointer answers "phone", the
     panel's own width answers "narrow" — so this reads both. */
  const coarse = useCoarsePointer() || inline
  /* Read through refs by listeners wired once, at creation. */
  const reviewRef = React.useRef(review)
  reviewRef.current = review
  const changesRef = React.useRef(onLineChanges)
  changesRef.current = onLineChanges
  const reviewing = !!review

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
        glyphMargin: reviewing,
      })
      editor.current = instance
      if (editorRef) editorRef.current = instance
      const diff = instance
      diff.onDidUpdateDiff(() => changesRef.current?.(diff.getLineChanges() ?? []))
      if (reviewing) {
        wireGutter(monaco, diff.getOriginalEditor(), "original")
        wireGutter(monaco, diff.getModifiedEditor(), "modified")
      }
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
      if (editorRef) editorRef.current = null
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

  /* The commented lines, per side — re-laid on every model swap, which takes a
     model's decorations with it. */
  const marksKey = JSON.stringify(review?.marks ?? [])
  React.useEffect(() => {
    const monaco = api.current
    const instance = editor.current
    const marks = reviewRef.current?.marks
    if (!monaco || !instance || !marks) return
    const collections = (["original", "modified"] as const).map((side) =>
      (side === "original" ? instance.getOriginalEditor() : instance.getModifiedEditor()).createDecorationsCollection(
        marks
          .filter((mark) => mark.side === side)
          .map((mark) => ({
            range: new monaco.Range(mark.line, 1, mark.endLine, 1),
            options: { isWholeLine: true, className: "review-line-mark", glyphMarginClassName: "review-glyph-mark" },
          }))
      )
    )
    return () => collections.forEach((collection) => collection.clear())
  }, [marksKey, original, modified, ready])

  React.useEffect(() => {
    editor.current?.updateOptions({ renderSideBySide: !coarse })
  }, [coarse, ready])

  React.useEffect(() => {
    const monaco = api.current
    if (monaco) syncMonacoTheme(monaco, resolved === "dark")
  }, [resolved, ready])

  return <div ref={host} className="h-full min-h-0 w-full overflow-hidden" />

  /** The "+" that follows the pointer down the gutter, and the click on it. */
  function wireGutter(monaco: MonacoApi, target: Monaco.editor.ICodeEditor, side: ReviewAnchor["side"]) {
    const hover = target.createDecorationsCollection()
    target.onMouseMove((event) => {
      const line = event.target.position?.lineNumber
      hover.set(
        line
          ? [{ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: "review-glyph-add" } }]
          : []
      )
    })
    target.onMouseLeave(() => hover.clear())
    target.onMouseDown((event) => {
      if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return
      const line = event.target.position?.lineNumber
      const model = target.getModel()
      if (!line || !model) return
      /* A selection the click lands inside is the range; one that ends at
         column 1 of the next line does not claim that line. */
      const selection = target.getSelection()
      let start = line
      let end = line
      if (selection && !selection.isEmpty() && line >= selection.startLineNumber && line <= selection.endLineNumber) {
        start = selection.startLineNumber
        end =
          selection.endColumn === 1 && selection.endLineNumber > start
            ? selection.endLineNumber - 1
            : selection.endLineNumber
      }
      const code = Array.from({ length: end - start + 1 }, (_, i) => model.getLineContent(start + i)).join("\n")
      reviewRef.current?.onComment({ side, line: start, endLine: end, code })
    })
  }
}
