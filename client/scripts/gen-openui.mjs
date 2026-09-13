/* ── OpenUI prompt generator ──
   Writes ../agent/src/openui-prompt.ts, the runtime's copy of the generated
   OpenUI system prompt. Run with `pnpm openui` (or `pnpm openui --check` to
   fail if the checked-in copy has drifted).

   Why this crosses the repo boundary at all: the component table lives in
   `src/lib/openui/library.tsx` because that is where the *renderers* are, and
   the prompt the model is given must be generated from that same table —
   `defineComponent` keeps only the spec in a form Node can read, which is what
   makes running it under the client's own esbuild possible. The runtime cannot
   import the file itself (it is React, TSX, and a different project), so the
   generated text travels as a plain `.ts` string the agent compiles.

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
const OUT = join(ROOT, "..", "agent", "src", "openui-prompt.ts")
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
    "Arguments are POSITIONAL ONLY. Write `Stat(\"Builds\", \"412\", \"-2 vs yesterday\")` — NEVER `Stat(label=\"Builds\", value=\"412\")` and never with `:` either. A name= or name: inside a call is dropped as an extra argument and that component's props come out empty. Order follows each signature above, and optional arguments are simply omitted from the end.",
    "Reach for a fenced block ONLY when the answer is a structure that reads better drawn than described: a comparison, a trend, a handful of figures, a status board. A question, an explanation or a single fact is prose.",
    "Nothing in a generated program can read a file, run a command or fetch anything. Compose the view from what is already in this conversation; never write a Query, a Mutation or an Action.",
    "Keep the prose around a fence short: the block is drawn inline, in the answer it belongs to.",
    "Write plain ASCII in the program. No smart quotes or arrows inside the fence.",
    /* The model composes for a wall and the reader is often on a phone. These
       are composition rules, not layout instructions: the components already
       reflow themselves (`@panel-*`), so all the model has to get right is the
       shape and the size. */
    "The view may be read on a phone. Prefer shapes that survive a narrow column: a StatRow of two to four figures, or a Table/Chart, rather than a wide custom layout. Keep every label and title short.",
    "Keep the program to roughly a dozen statements. A long fence is harder to follow and likelier to be cut off before `root` — and a program with no `root` draws nothing at all.",
  ],
  examples: [
    `root = Stack([title, cards, big])
title = Section("Build health", "The last 24 hours.")
cards = StatRow([builds, fails])
builds = Stat("Builds", "412")
fails = Stat("Failures", "7", "-2 vs yesterday")
big = Table(["Stage", "Pass rate"], [["unit", "99%"], ["e2e", "94%"]])`,
  ],
}

const ENTRY = `
import { openuiLibrary } from "@/lib/openui/library"
process.stdout.write(openuiLibrary.prompt(${JSON.stringify(PROMPT_OPTIONS)}))
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

/** The file as it would be written, so `--check` and the write agree. */
function render(prompt) {
  return `/* GENERATED by client/scripts/gen-openui.mjs — do not edit.
 *
 * The runtime's copy of the OpenUI system prompt, generated from the component
 * library the client draws it with (client/src/lib/openui/library.tsx).
 * Re-run \`pnpm openui\` in client/ after any change to that library; the
 * generated text must describe exactly the components the reader will get.
 *
 * It is a string and not a runtime import on purpose: the library is React,
 * TSX and a different project, and this file is compiled into the agent's
 * dist/ like any other module.
 *
 * Frame is English and stays English: it is addressed to the model, and the
 * rest of the prompt it is folded into is English too.
 */
export const OPENUI_PROMPT = ${JSON.stringify(prompt)};
`
}

const prompt = await generate()
const rendered = render(prompt)

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
