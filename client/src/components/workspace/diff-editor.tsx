/* Side-by-side comparison, on CodeMirror's own merge view.

   `components/ui/diff-view.tsx` stays what it is — a dependency-free line LCS
   for the small diffs a tool call reports inline in the transcript. It is the
   right thing there and the wrong thing here: a whole-file comparison wants
   syntax colour, scroll sync and a viewport that does not render ten thousand
   lines to show you three. */
import * as React from "react"
import { MergeView } from "@codemirror/merge"
import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"

import { editorBaseExtensions, languageFor } from "@/components/workspace/code-editor"

export function DiffEditor({
  original,
  modified,
  filename,
}: {
  /** What is on disk (or the comparison's left side). */
  original: string
  /** What you have. */
  modified: string
  filename: string
}) {
  const host = React.useRef<HTMLDivElement | null>(null)
  const [support, setSupport] = React.useState<Awaited<ReturnType<typeof languageFor>>>(null)

  React.useEffect(() => {
    let cancelled = false
    void languageFor(filename).then((loaded) => {
      if (!cancelled) setSupport(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [filename])

  React.useEffect(() => {
    if (!host.current) return
    const extensions = [
      ...editorBaseExtensions(),
      ...(support ? [support] : []),
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
    ]
    const view = new MergeView({
      parent: host.current,
      a: { doc: original, extensions },
      b: { doc: modified, extensions },
      /* Both sides read-only: this panel is for seeing what differs. Editing
         happens in the text mode, which owns the dirty state and the save —
         two places that can both mutate one buffer is how they disagree. */
      collapseUnchanged: { margin: 3, minSize: 6 },
      gutter: true,
    })
    return () => view.destroy()
  }, [original, modified, support])

  return <div ref={host} className="h-full min-h-0 w-full overflow-auto" />
}
