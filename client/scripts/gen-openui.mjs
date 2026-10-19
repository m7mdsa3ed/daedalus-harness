/* ── OpenUI prompt generator ──
   Writes ../server/src/openui-prompt.ts, the server's copy of the generated
   OpenUI system prompt — folded into every runtime's spawn instructions as the
   drawn-answers trailer (server/src/personas.ts). Run with `pnpm openui` (or `pnpm openui --check` to
   fail if the checked-in copy has drifted).

   Why this crosses the repo boundary at all: the component table lives in
   `src/lib/openui/library.tsx` because that is where the *renderers* are, and
   the prompt the model is given must be generated from that same table —
   `defineComponent` keeps only the spec in a form Node can read, which is what
   makes running it under the client's own esbuild possible. The server cannot
   import the file itself (it is React, TSX, and a different project), so the
   generated text travels as a plain `.ts` string the server compiles.

   This is the `gen-themes.mjs` shape: the input is code, the output is checked
   in, and the transformation is this script rather than the build. It is not
   part of `build.sh` — a component is added by editing the library and running
   `pnpm openui`, so the diff that adds a component and the diff that changes
   the prompt are one commit.

   Pinned to the versions in `client/package.json`: the language has moved
   between minor versions (v0.5 adds reactive state), so a floating range would
   make the generated prompt drift without a diff. */

import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const OUT = join(ROOT, "..", "server", "src", "openui-prompt.ts")
/* Inside `node_modules`: the bundle keeps its imports external (so it links
   against the client's own copies of the language, zod and react), which means
   Node resolves them from wherever the file sits — so it has to sit here. */
const TMP_DIR = join(ROOT, "node_modules", ".cache")
const TMP = join(TMP_DIR, "openui-prompt.mjs")

/* ── The prompt's options ──
   Every flag here decides what the model is told it may write, and the client
   only draws a subset of it:

   — `inlineMode: true` is what makes a fenced block legal at all. Without it
     the generated prompt insists the ENTIRE reply is openui-lang, which is
     wrong for a coding agent whose usual answer is prose;
   — `toolCalls: false` and `bindings: false` are the inertness guarantee. No
     `Query`/`Mutation` is advertised, so the language has no way to name a tool
     — and the renderer passes no `toolProvider`, so one could not run if it
     did. A view composes what the model already knows;
   — `editMode: false`: each answer draws its own view, so there is no previous
     program to patch. */
const PROMPT_OPTIONS = {
  inlineMode: true,
  toolCalls: false,
  bindings: false,
  editMode: false,
  additionalRules: [
    /* The first rule earns its place: a model asked for a UI reaches for
       `name = value` arguments, because that is how every other structured lane
       in this harness (JSON tool calls, an XML-ish tag, a fenced YAML block)
       spells a field. The language has NO named arguments — they are read as
       extra positional args, the prop comes out null, and the component is
       dropped with a validation error. Leading with the prohibition and a
       worked counter-example is the only thing that has held. */
    "Arguments are POSITIONAL ONLY. Write `Section(\"Builds\", \"412 today\")` — NEVER `Section(title=\"Builds\", text=\"412 today\")` and never with `:` either. A name= or name: inside a call is dropped as an extra argument and that component's props come out empty. Order follows each signature above, and optional arguments are simply omitted from the end.",
    "Use plain prose for ordinary questions, explanations, and facts. When a structured answer is clearer as a view, put the complete OpenUI program inside exactly one fenced code block tagged `openui-lang`; never emit OpenUI statements as unfenced prose. The first line INSIDE the fence must be `root = Stack([...])` (with the equals sign), followed by any component definitions. Do not write `root Stack(...)`, and do not put prose inside the fence.",
    "Reach for a fenced block ONLY when the answer is a structure that reads better drawn than described: a comparison, a trend, a handful of figures, a status board. A question, an explanation or a single fact is prose.",
    "Nothing in a generated program can read a file, run a command or fetch anything. Compose the view from what is already in this conversation; never write a Query, a Mutation or an Action.",
    "Keep the prose around a fence short: the block is drawn inline, in the answer it belongs to.",
    "Write plain ASCII in the program. No smart quotes or arrows inside the fence.",
    /* The model composes for a wall and the reader is often on a phone. These
       are composition rules, not layout instructions: the components already
       reflow themselves (`@panel-*`), so all the model has to get right is the
       shape and the size. */
    "Every standalone component fills the available width. Use side-by-side layouts only for an intentional comparison or a small related group; otherwise keep components full-width and stacked.",
    /* No component names: a thread may switch groups off (`uiGroups`), and a rule that
       names one would teach it to a model that was told it does not exist. */
    "The view may be read on a phone. Prefer shapes that survive a narrow column, rather than a wide custom layout. Keep every label and title short.",
    "Keep the program to roughly a dozen statements. A long fence is harder to follow and likelier to be cut off before `root` — and a program with no `root` draws nothing at all.",
  ],
  /* Layout-only: the example is shown whatever groups are on, and `layout` is the one
     group that always is. */
  examples: [
    `root = Stack([title, summary, log])
title = Section("Build health", "The last 24 hours.")
summary = Card("Failures", "Seven, down from nine", [cause])
cause = Section("Most common", "The e2e stage timing out.")
log = Details("Raw log", [entry])
entry = Section("unit", "Passed.")`,
  ],
}

const ENTRY = `
import { openuiLibrary } from "@/lib/openui/library"
import { UI_GROUPS } from "@/lib/openui/groups"
process.stdout.write(JSON.stringify({ prompt: openuiLibrary.prompt(${JSON.stringify(PROMPT_OPTIONS)}), groups: UI_GROUPS.map(({ id, label }) => ({ id, label })) }))
`

async function generate() {
  mkdirSync(TMP_DIR, { recursive: true })
  const built = await build({
    stdin: { contents: ENTRY, resolveDir: ROOT, loader: "ts" },
    bundle: true,
    platform: "node",
    format: "esm",
    jsx: "automatic",
    /* External: the language and recharts are the client's own copies, and a
       second bundled react would be a second React. Only the entry and its
       local imports are compiled. */
    packages: "external",
    alias: { "@": join(ROOT, "src") },
    /* The Map's Google Maps half is a lazy browser-only chunk (it touches `window` and imports CSS);
       the prompt needs only the specs, so it is compiled as nothing. */
    plugins: [
      {
        name: "stub-google-map",
        setup(b) {
          b.onResolve({ filter: /\/(google-map|place-photo)$/ }, () => ({ path: "google-map", namespace: "stub" }))
          b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export default () => null; export const usePlacePhoto = () => undefined", loader: "js" }))
        },
      },
    ],
    logLevel: "silent",
    write: false,
  })
  writeFileSync(TMP, built.outputFiles[0].text)
  try {
    return execFileSync(process.execPath, [TMP], { encoding: "utf8" })
  } finally {
    rmSync(TMP, { force: true })
  }
}

/** Cut the prompt where a thread's `uiGroups` can cut it: a frame head, one
    "### <label>" section per group (signatures, then that group's notes) and a
    tail. The walk is over the known labels and never a generic "### " match,
    because the tail has "###" headings of its own. A label that is missing or out
    of order throws — the split must never quietly drop a group. */
function split(prompt, groups) {
  let from = -1
  const starts = groups.map(({ id, label }) => {
    const at = prompt.indexOf(`\n### ${label}\n`, from + 1)
    if (at < 0) throw new Error(`group "${id}": no "### ${label}" heading in the generated prompt (or out of order)`)
    from = at
    return at + 1
  })
  const last = starts[starts.length - 1]
  const tailAt = prompt.indexOf("\n## ", last)
  if (tailAt < 0) throw new Error("no section after the last group: the tail was not found")
  const sections = Object.fromEntries(
    groups.map(({ id }, i) => [id, prompt.slice(starts[i], i + 1 < groups.length ? starts[i + 1] : tailAt + 1)]),
  )
  return { head: prompt.slice(0, starts[0]), sections, tail: prompt.slice(tailAt + 1), order: groups.map(({ id }) => id) }
}

/** The file as it would be written, so `--check` and the write agree. */
function render(prompt, parts) {
  return `/* GENERATED by client/scripts/gen-openui.mjs — do not edit.
 *
 * The server's copy of the OpenUI system prompt, generated from the component
 * library the client draws it with (client/src/lib/openui/library.tsx), and
 * folded into every runtime's spawn instructions (personas.ts). Re-run
 * \`pnpm openui\` in client/ after any change to that library; the generated
 * text must describe exactly the components the reader will get.
 *
 * It is a string and not a runtime import on purpose: the library is React,
 * TSX and a different project, and this file is compiled into the server's
 * dist/ like any other module.
 *
 * Frame is English and stays English: it is addressed to the model, and the
 * rest of the prompt it is folded into is English too.
 */
export const OPENUI_PROMPT = ${JSON.stringify(prompt)};

/* The same prompt cut for a thread's \`uiGroups\`: head + the chosen sections in
 * OPENUI_GROUP_ORDER + tail is OPENUI_PROMPT when every group is chosen. */
export const OPENUI_FRAME_HEAD = ${JSON.stringify(parts.head)};
export const OPENUI_GROUPS: Record<string, string> = ${JSON.stringify(parts.sections, null, 2)};
export const OPENUI_FRAME_TAIL = ${JSON.stringify(parts.tail)};
export const OPENUI_GROUP_ORDER: string[] = ${JSON.stringify(parts.order)};
`
}

const { prompt, groups } = JSON.parse(await generate())
const parts = split(prompt, groups)
/* The cut loses nothing: the pieces, joined, are the prompt. */
if (parts.head + parts.order.map((id) => parts.sections[id]).join("") + parts.tail !== prompt) throw new Error("the split does not reassemble into the prompt")
const rendered = render(prompt, parts)

if (process.argv.includes("--check")) {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : ""
  if (current !== rendered) {
    console.error("openui-prompt.ts is out of date. Run `pnpm openui` in client/.")
    process.exit(1)
  }
  console.log(`openui-prompt.ts ok (${prompt.length} chars)`)
} else {
  writeFileSync(OUT, rendered)
  console.log(`openui-prompt.ts written (${prompt.length} chars)`)
}
