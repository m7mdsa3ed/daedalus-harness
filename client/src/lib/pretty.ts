/* ── Pretty-printing a code block ──
   The one door from "a fence and its language" to "the same code, laid out".
   Prettier's standalone build runs in the browser; each grammar is its own
   dynamic import, so a transcript that never formats a block pays for none of
   it, and one that formats JSON does not load the TypeScript parser.

   A language is *supported* by what Prettier can parse, never guessed from the
   text: a block with no declared language, or one Prettier has no parser for
   (python, bash, sql), gets no button rather than a guess that rewrites it.
   A parse failure is an answer too — the block stays as written. */
import type { Plugin } from "prettier"

interface Grammar {
  parser: string
  plugins: () => Promise<Plugin[]>
}

const babel = async () =>
  [(await import("prettier/plugins/babel")).default, (await import("prettier/plugins/estree")).default] as Plugin[]
const typescript = async () =>
  [
    (await import("prettier/plugins/typescript")).default,
    (await import("prettier/plugins/estree")).default,
  ] as Plugin[]
const postcss = async () => [(await import("prettier/plugins/postcss")).default] as Plugin[]
const html = async () => [(await import("prettier/plugins/html")).default] as Plugin[]
const markdown = async () => [(await import("prettier/plugins/markdown")).default] as Plugin[]
const yaml = async () => [(await import("prettier/plugins/yaml")).default] as Plugin[]
const graphql = async () => [(await import("prettier/plugins/graphql")).default] as Plugin[]

const GRAMMARS: Record<string, Grammar> = {
  json: { parser: "json", plugins: babel },
  json5: { parser: "json5", plugins: babel },
  jsonc: { parser: "jsonc", plugins: babel },
  javascript: { parser: "babel", plugins: babel },
  js: { parser: "babel", plugins: babel },
  jsx: { parser: "babel", plugins: babel },
  mjs: { parser: "babel", plugins: babel },
  cjs: { parser: "babel", plugins: babel },
  typescript: { parser: "typescript", plugins: typescript },
  ts: { parser: "typescript", plugins: typescript },
  tsx: { parser: "typescript", plugins: typescript },
  mts: { parser: "typescript", plugins: typescript },
  cts: { parser: "typescript", plugins: typescript },
  css: { parser: "css", plugins: postcss },
  scss: { parser: "scss", plugins: postcss },
  less: { parser: "less", plugins: postcss },
  html: { parser: "html", plugins: html },
  vue: { parser: "vue", plugins: html },
  markdown: { parser: "markdown", plugins: markdown },
  md: { parser: "markdown", plugins: markdown },
  yaml: { parser: "yaml", plugins: yaml },
  yml: { parser: "yaml", plugins: yaml },
  graphql: { parser: "graphql", plugins: graphql },
}

/** `code` as a fenced block that cannot be broken out of: a fence closes only
    on a run at least as long as the one that opened it, so one longer than any
    backtick run in the payload is safe. */
export function fencedBlock(code: string, language: string): string {
  const fence = "`".repeat(Math.max(3, ...(code.match(/`+/g) ?? []).map((run) => run.length + 1)))
  return fence + language + "\n" + code.replace(/\n$/, "") + "\n" + fence
}

/** Whether a fence's language is one Prettier can lay out. Cheap and
    synchronous, so a block can decide to draw its button without loading
    anything. */
export function canPrettify(language: string | undefined): boolean {
  return !!language && language.toLowerCase() in GRAMMARS
}

/** The code laid out by Prettier. Rejects when the code does not parse (a
    snippet with a `...` in it, a fragment) — the caller keeps the original and
    says why. */
export async function prettify(code: string, language: string): Promise<string> {
  const grammar = GRAMMARS[language.toLowerCase()]
  if (!grammar) throw new Error(`No formatter for ${language}`)
  const [{ format }, plugins] = await Promise.all([import("prettier/standalone"), grammar.plugins()])
  const out = await format(code, { parser: grammar.parser, plugins })
  return out.replace(/\n$/, "")
}
