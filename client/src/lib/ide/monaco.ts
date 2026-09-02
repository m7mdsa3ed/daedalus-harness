/* ── Monaco, the official one ──
   `monaco-editor` from npm, imported exactly as Microsoft ships it. No
   `@codingame/monaco-vscode-api`, no service overrides, no extension host: the
   harness draws its own explorer and its own source control (see
   `components/workspace/file-explorer.tsx` and `scm-view.tsx`), and Monaco is
   asked for the one thing it is actually the best in the world at — the text
   surface and the diff.

   Two consequences worth stating, because they are what the workbench cost:

   - **There is no global to initialize.** Monaco has no "services initialize
     once per page" rule, so an editor is an ordinary component: mount it,
     dispose it, mount three. The IDE panel is a normal panel again — nothing is
     parked in a detached holder, and a second project is a second panel.
   - **Workers need no wiring.** Since 0.56 every worker Monaco starts is
     declared as `new Worker(new URL(…, import.meta.url))` inside the package,
     which is precisely the shape Vite compiles into a worker chunk. Defining
     `MonacoEnvironment.getWorker` would *override* that with paths we would
     then have to keep true by hand, so we deliberately define nothing.

   The module is loaded through `loadMonaco()` and never imported statically by
   anything a reader loads: it is a couple of megabytes, and the transcript must
   not carry it. `lib/ide/open.ts` is the seam that keeps it that way. */
import type * as Monaco from "monaco-editor"

export type MonacoApi = typeof Monaco

let pending: Promise<MonacoApi> | null = null

/** The editor library, downloaded on first use. One import per page. */
export function loadMonaco(): Promise<MonacoApi> {
  pending ??= import("monaco-editor").then((monaco) => {
    /* A file is opened alone, without its project's `tsconfig` or its
       `node_modules`, so TypeScript's own type checking here would underline
       every import in the file as missing. Syntax errors are still real. */
    for (const defaults of [
      monaco.typescript.typescriptDefaults,
      monaco.typescript.javascriptDefaults,
    ]) {
      defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false })
    }
    defineThemes(monaco)
    return monaco
  })
  return pending
}

/* ── Colour ──
   The editor wears the app's palette, which is written in `oklch()` and in
   `color-mix()` — neither of which Monaco's theme format takes, since it wants
   a hex string per key. So each token is resolved through the one thing that
   understands every CSS colour syntax there is: the browser. A 1×1 canvas is
   painted with the value and the pixel read back.

   The fallbacks are not decoration. `fillStyle` silently keeps its previous
   value when handed something it cannot parse, so a browser without `oklch`
   support would otherwise paint the whole theme in whatever colour came before
   it. Each lookup states what it means to fail. */

const CANVAS_SIZE = 1
let ctx: CanvasRenderingContext2D | null | undefined

function context(): CanvasRenderingContext2D | null {
  if (ctx !== undefined) return ctx
  const canvas = document.createElement("canvas")
  canvas.width = CANVAS_SIZE
  canvas.height = CANVAS_SIZE
  ctx = canvas.getContext("2d", { willReadFrequently: true })
  return ctx
}

const hex = (value: number): string => value.toString(16).padStart(2, "0")

/** Any CSS colour → `#rrggbb`, or null when the browser cannot parse it. */
export function cssColorToHex(color: string): string | null {
  const target = context()
  if (!target || !color.trim()) return null
  /* `fillStyle` ignores an assignment it cannot parse rather than throwing, so
     validity is tested by assigning over two *different* sentinels: a value
     that took holds in both cases, one that was rejected leaves the sentinels
     showing through. Without this, an unparsed colour would silently paint in
     whatever the previous one was. */
  target.fillStyle = "#ff00ff"
  target.fillStyle = color
  const first = target.fillStyle
  target.fillStyle = "#00ff00"
  target.fillStyle = color
  if (first !== target.fillStyle) return null
  target.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE)
  target.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE)
  try {
    const [r, g, b, a] = target.getImageData(0, 0, 1, 1).data
    if (a === 0) return null
    return `#${hex(r)}${hex(g)}${hex(b)}`
  } catch {
    /* A tainted canvas cannot happen here — nothing external is drawn — but a
       browser that refuses `getImageData` is a browser with no theme. */
    return null
  }
}

/** A CSS custom property as it resolves *on the document*, colour-converted.
    `#rrggbb` — the form Monaco's `colors` map takes. */
function token(name: string, fallback: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name)
  return cssColorToHex(raw.trim()) ?? fallback
}

/** The same value for a **token rule**, which takes its hex *without* the hash:
    Monaco parses a rule colour as `Color.fromHex("#" + value)`, so a leading
    one makes `##rrggbb` and the rule is dropped on the floor. */
function ruleToken(name: string, fallback: string): string {
  return token(name, fallback).replace(/^#/, "")
}

export const THEME_DARK = "daedalus-dark"
export const THEME_LIGHT = "daedalus-light"

/**
 * Build both themes from the app's current palette.
 *
 * Called at load and again whenever the palette moves (`syncMonacoTheme`), so a
 * custom theme carries the editor with it instead of leaving it on someone
 * else's grey — the mistake the old `--cm-*` block was written to avoid and
 * then made a second copy of. The syntax hues are the transcript's own
 * (`--code-*` in `index.css`), so a file and a fenced block of that file read
 * as the same language.
 */
function defineThemes(monaco: MonacoApi): void {
  for (const [name, base] of [
    [THEME_LIGHT, "vs"],
    [THEME_DARK, "vs-dark"],
  ] as const) {
    const dark = name === THEME_DARK
    /* Both themes are built from the palette as it is *right now*, and only one
       of them is the one on screen. The other is built from the same values —
       which is fine, because `syncMonacoTheme` redefines them on every change,
       and the wrong-mode theme is never the one selected. */
    monaco.editor.defineTheme(name, {
      base,
      inherit: true,
      rules: [
        { token: "", foreground: ruleToken("--foreground", dark ? "#e6e6e6" : "#1a1a1a") },
        { token: "comment", foreground: ruleToken("--code-comment", dark ? "#8b8b8b" : "#6f6f6f"), fontStyle: "italic" },
        { token: "keyword", foreground: ruleToken("--code-keyword", dark ? "#c4a7f7" : "#7c5bd4") },
        { token: "keyword.control", foreground: ruleToken("--code-keyword", dark ? "#c4a7f7" : "#7c5bd4") },
        { token: "operator", foreground: ruleToken("--code-punctuation", dark ? "#a6a6a6" : "#565656") },
        { token: "delimiter", foreground: ruleToken("--code-punctuation", dark ? "#a6a6a6" : "#565656") },
        { token: "string", foreground: ruleToken("--code-string", dark ? "#8fd4a4" : "#2e7d51") },
        { token: "regexp", foreground: ruleToken("--code-string", dark ? "#8fd4a4" : "#2e7d51") },
        { token: "number", foreground: ruleToken("--code-number", dark ? "#e5b27a" : "#a2643a") },
        { token: "constant", foreground: ruleToken("--code-number", dark ? "#e5b27a" : "#a2643a") },
        { token: "type", foreground: ruleToken("--code-type", dark ? "#e0a8d8" : "#a3529b") },
        { token: "type.identifier", foreground: ruleToken("--code-type", dark ? "#e0a8d8" : "#a3529b") },
        { token: "identifier", foreground: ruleToken("--foreground", dark ? "#e6e6e6" : "#1a1a1a") },
        { token: "attribute.name", foreground: ruleToken("--code-property", dark ? "#96c8dd" : "#3b7f9c") },
        { token: "variable", foreground: ruleToken("--code-property", dark ? "#96c8dd" : "#3b7f9c") },
        { token: "function", foreground: ruleToken("--code-function", dark ? "#8db4ef" : "#3b62c0") },
        { token: "tag", foreground: ruleToken("--code-keyword", dark ? "#c4a7f7" : "#7c5bd4") },
        { token: "invalid", foreground: ruleToken("--destructive", "#d64545") },
      ],
      colors: {
        /* The editor is drawn *inside* a panel, so its ground is the panel's
           and not a colour of its own — anything else reads as a rectangle
           pasted onto the app. */
        "editor.background": token("--card", dark ? "#1a1a1a" : "#ffffff"),
        "editor.foreground": token("--foreground", dark ? "#e6e6e6" : "#1a1a1a"),
        "editorGutter.background": token("--card", dark ? "#1a1a1a" : "#ffffff"),
        "editorLineNumber.foreground": token("--muted-foreground", dark ? "#7a7a7a" : "#8a8a8a"),
        "editorLineNumber.activeForeground": token("--foreground", dark ? "#e6e6e6" : "#1a1a1a"),
        "editor.lineHighlightBackground": token("--muted", dark ? "#242424" : "#f4f4f5"),
        "editorCursor.foreground": token("--foreground", dark ? "#e6e6e6" : "#1a1a1a"),
        "editorIndentGuide.background1": token("--border", dark ? "#2e2e2e" : "#e5e5e5"),
        "editorWidget.background": token("--popover", dark ? "#1f1f1f" : "#ffffff"),
        "editorWidget.border": token("--border", dark ? "#2e2e2e" : "#e5e5e5"),
        "editorSuggestWidget.background": token("--popover", dark ? "#1f1f1f" : "#ffffff"),
        "editorHoverWidget.background": token("--popover", dark ? "#1f1f1f" : "#ffffff"),
        "input.background": token("--input", dark ? "#242424" : "#ffffff"),
        "focusBorder": token("--ring", dark ? "#4a4a4a" : "#b4b4b4"),
        "scrollbarSlider.background": token("--border", dark ? "#2e2e2e" : "#e5e5e5"),
      },
    })
  }
}

/**
 * Point every live editor at the theme matching the app's mode.
 *
 * `setTheme` is global to Monaco, which is right: the app has one palette, so
 * two editors in two panels can never want different colours. Redefining first
 * is what makes a *palette* change (not just light↔dark) land.
 */
export function syncMonacoTheme(monaco: MonacoApi, dark: boolean): void {
  defineThemes(monaco)
  monaco.editor.setTheme(dark ? THEME_DARK : THEME_LIGHT)
}

/* ── Which language a file is ──
   Monaco's own registry, not a table of our own: every language it ships
   declares its extensions and its bare filenames, so asking it is the one
   answer that cannot drift from what it can actually colour. Unknown is
   `plaintext` — a wrong grammar is worse than none. */
export function languageForPath(monaco: MonacoApi, path: string): string {
  const name = (path.split("/").pop() ?? path).toLowerCase()
  const languages = monaco.languages.getLanguages()
  for (const language of languages) {
    if (language.filenames?.some((candidate) => candidate.toLowerCase() === name)) return language.id
  }
  /* Longest extension first, so `.d.ts` is not answered by `.ts` and
     `.blade.php` not by `.php`. */
  let best: { id: string; length: number } | null = null
  for (const language of languages) {
    for (const extension of language.extensions ?? []) {
      const suffix = extension.toLowerCase()
      if (!name.endsWith(suffix)) continue
      if (best && best.length >= suffix.length) continue
      best = { id: language.id, length: suffix.length }
    }
  }
  if (best) return best.id
  for (const language of languages) {
    if (language.filenamePatterns?.some((pattern) => matchesPattern(name, pattern))) return language.id
  }
  return "plaintext"
}

/** The tiny glob subset Monaco's `filenamePatterns` actually use (`*` only). */
function matchesPattern(name: string, pattern: string): boolean {
  const escaped = pattern
    .toLowerCase()
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
  return new RegExp(`^${escaped}$`).test(name)
}

/** Options every editor in the app shares. A reader's preferences (font size,
    wrapping) are the app's, so they are stated here once rather than per
    call site. */
export function baseEditorOptions(): Monaco.editor.IStandaloneEditorConstructionOptions {
  return {
    fontSize: 12.5,
    lineHeight: 1.6,
    fontFamily: "var(--font-mono, ui-monospace, monospace)",
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    automaticLayout: true,
    smoothScrolling: true,
    renderLineHighlight: "line",
    renderWhitespace: "selection",
    guides: { bracketPairs: "active" },
    padding: { top: 8, bottom: 8 },
    scrollbar: { useShadows: false, verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
    /* The panel is often narrow — beside a transcript, or a phone in
       portrait — and a horizontal scrollbar in a 320px column is not reading. */
    wordWrap: "on",
    tabSize: 2,
    fixedOverflowWidgets: true,
  }
}
