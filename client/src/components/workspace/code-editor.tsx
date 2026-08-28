/* ── CodeMirror ──
   The text surface for the editor panel.

   CodeMirror rather than Monaco, which is what the plan defaulted to. Two
   reasons, both about this app specifically. Monaco does not support mobile
   browsers — that is upstream's own position, not a gap someone will close —
   and this client is a PWA people install on a phone. And "load it lazily" does
   not spare them: the service worker precaches every built .js chunk (see
   vite.config), so
   a lazy chunk is still downloaded and cached on install by every user
   including the ones who only ever read a transcript. CodeMirror is an order of
   magnitude smaller, and its touch handling is the reason it exists.

   The theme is written in app tokens rather than imported from a published
   one, for the same reason `index.css` writes the highlight.js palette by hand:
   a custom theme has to move the code colours with it, and someone else's grey
   stays grey. The syntax hues are deliberately the same values the transcript
   uses for fenced code, so a file and a diff of that file in a tool call read
   as the same language.

   Grammars load on demand through `@codemirror/language-data`, so opening a
   `.ts` file does not also ship Rust. */
import * as React from "react"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language"
import { languages } from "@codemirror/language-data"
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search"
import { Compartment, EditorState, type Extension } from "@codemirror/state"
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder as cmPlaceholder,
} from "@codemirror/view"
import { tags as t } from "@lezer/highlight"

/** Same two-hue scheme as the transcript's fenced code: warm for literals, cool
    for structure, weight and opacity for the rest. Enough separation to read
    by, quiet enough that a long file is not a fruit salad. */
const highlightStyle = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--cm-comment)", fontStyle: "italic" },
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.modifier, t.self, t.null, t.bool], color: "var(--cm-keyword)", fontWeight: "500" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--cm-string)" },
  { tag: [t.number, t.integer, t.float, t.atom], color: "var(--cm-number)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], color: "var(--cm-function)", fontWeight: "500" },
  { tag: [t.propertyName, t.attributeName, t.variableName], color: "var(--cm-property)" },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: "var(--cm-type)" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: "var(--cm-punctuation)" },
  { tag: [t.tagName], color: "var(--cm-keyword)" },
  { tag: [t.heading], color: "var(--cm-function)", fontWeight: "600" },
  { tag: [t.link, t.url], color: "var(--cm-number)", textDecoration: "underline" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: [t.strong], fontWeight: "600" },
  { tag: [t.invalid], color: "var(--destructive)" },
])

/** Chrome only — every colour is a CSS variable resolved from the app theme, so
    light/dark and any custom palette follow without a second theme object. */
const baseTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "12px",
    backgroundColor: "transparent",
    color: "var(--foreground)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono, ui-monospace, monospace)",
    lineHeight: "1.6",
    /* A sideways swipe that reaches the end must not become the browser's
       back-gesture — the same bargain the transcript's code blocks make. */
    overscrollBehaviorX: "contain",
  },
  ".cm-content": { caretColor: "var(--foreground)", paddingBlock: "8px" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    border: "none",
    color: "color-mix(in oklch, var(--muted-foreground) 70%, transparent)",
  },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--foreground)" },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklch, var(--muted) 40%, transparent)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in oklch, var(--primary) 22%, transparent)",
  },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in oklch, var(--primary) 14%, transparent)" },
  ".cm-panels": {
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    border: "1px solid var(--border)",
  },
  ".cm-searchMatch": { backgroundColor: "color-mix(in oklch, var(--primary) 20%, transparent)" },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "color-mix(in oklch, var(--primary) 40%, transparent)",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    border: "1px solid var(--border)",
  },
})

export const editorBaseExtensions = (): Extension[] => [
  baseTheme,
  syntaxHighlighting(highlightStyle),
  EditorView.lineWrapping,
]

/** The grammar for a filename, loaded on demand. Null when nothing matches —
    plain text is a fine answer, and a wrong grammar is not. */
export async function languageFor(filename: string): Promise<Extension | null> {
  const description = LanguageDescription.matchFilename(languages, filename)
  if (!description) return null
  try {
    const support = await description.load()
    return support
  } catch {
    return null
  }
}

export interface CodeEditorProps {
  value: string
  filename: string
  readOnly?: boolean
  placeholder?: string
  onChange?: (value: string) => void
  /** ⌘S inside the editor, where the caret is. */
  onSave?: () => void
  /** 1-based. Scrolls to it and puts the caret there; see `lib/workspace/reveal`. */
  revealLine?: number
  revealColumn?: number
  /** Changes whenever a reveal is requested again for the same line, so asking
      twice actually scrolls twice. */
  revealNonce?: number
}

/**
 * A controlled-ish editor: `value` seeds the document and replaces it whenever
 * it changes from the outside (a reload, a discard), but keystrokes in between
 * are the editor's own. Pushing every keystroke back through React state and
 * down again would fight the editor for the cursor on every character.
 */
export function CodeEditor({
  value,
  filename,
  readOnly,
  placeholder,
  onChange,
  onSave,
  revealLine,
  revealColumn,
  revealNonce,
}: CodeEditorProps) {
  const host = React.useRef<HTMLDivElement | null>(null)
  const view = React.useRef<EditorView | null>(null)
  const language = React.useRef(new Compartment())
  const editable = React.useRef(new Compartment())

  // Handlers in refs: the view is built once, and rebuilding it on every render
  // would lose the cursor, the selection, the undo history and the scroll.
  const onChangeRef = React.useRef(onChange)
  onChangeRef.current = onChange
  const onSaveRef = React.useRef(onSave)
  onSaveRef.current = onSave

  React.useEffect(() => {
    if (!host.current) return
    const instance = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          highlightSelectionMatches(),
          drawSelection(),
          history(),
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                onSaveRef.current?.()
                return true
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            indentWithTab,
          ]),
          ...(placeholder ? [cmPlaceholder(placeholder)] : []),
          ...editorBaseExtensions(),
          language.current.of([]),
          editable.current.of([
            EditorView.editable.of(!readOnly),
            EditorState.readOnly.of(!!readOnly),
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current?.(update.state.doc.toString())
          }),
        ],
      }),
    })
    view.current = instance
    return () => {
      instance.destroy()
      view.current = null
    }
    // Built once per mount. `value`/`readOnly` are pushed in by the effects
    // below rather than by rebuilding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  React.useEffect(() => {
    let cancelled = false
    void languageFor(filename).then((support) => {
      if (cancelled || !view.current) return
      view.current.dispatch({
        effects: language.current.reconfigure(support ?? []),
      })
    })
    return () => {
      cancelled = true
    }
  }, [filename])

  React.useEffect(() => {
    const instance = view.current
    if (!instance) return
    instance.dispatch({
      effects: editable.current.reconfigure([
        EditorView.editable.of(!readOnly),
        EditorState.readOnly.of(!!readOnly),
      ]),
    })
  }, [readOnly])

  React.useEffect(() => {
    const instance = view.current
    if (!instance) return
    const current = instance.state.doc.toString()
    if (current === value) return
    /* Replacing the whole document only when it genuinely differs: this fires
       for a reload or a discard, never for the user's own typing, which has
       already updated the doc before `value` comes back around. */
    instance.dispatch({
      changes: { from: 0, to: instance.state.doc.length, insert: value },
    })
  }, [value])

  React.useEffect(() => {
    const instance = view.current
    if (!instance || !revealLine) return
    /* Clamped, because the line came from a compiler that may have been reading
       a different version of the file — an out-of-range line should land at the
       end rather than throw and leave the panel blank. */
    const target = Math.min(Math.max(1, revealLine), instance.state.doc.lines)
    const line = instance.state.doc.line(target)
    const position = Math.min(line.from + Math.max(0, (revealColumn ?? 1) - 1), line.to)
    instance.dispatch({
      selection: { anchor: position },
      effects: EditorView.scrollIntoView(position, { y: "center" }),
    })
    instance.focus()
  }, [revealLine, revealColumn, revealNonce])

  return <div ref={host} className="h-full min-h-0 w-full overflow-hidden" />
}
