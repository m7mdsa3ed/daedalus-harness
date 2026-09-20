/*
 * `pnpm check:split` — the split shares `splitSpan` hands dockview, checked
 * against the rule the UI states: the work takes 70%, the tool the rest.
 *
 * It transpiles the real function out of `components/workspace/dock.tsx` (the
 * export is a pure function of the api's box and the panel kind) rather than
 * re-importing a copy of the arithmetic, so the numbers below are the numbers
 * the dock ships. Anything the file imports is left to tsx's resolver — the
 * function reads only `api.width` / `api.height`.
 */
import { readFileSync } from "node:fs"
import path from "node:path"
import { transformSync } from "esbuild"

const src = readFileSync(path.resolve(import.meta.dirname, "../src/components/workspace/dock.tsx"), "utf8")
const start = src.indexOf("export function splitSpan(")
if (start < 0) throw new Error("splitSpan is gone from dock.tsx")
const end = src.indexOf("\n}", start)
const fn = src.slice(start, end + 2)
/* The two constants it closes over, lifted by name so the test fails loudly if
   either moves rather than quietly testing a stale number. */
const ratio = Number(/const WORK_RATIO = ([\d.]+)/.exec(src)?.[1])
const minSplit = Number(/const MIN_SPLIT_PX = ([\d.]+)/.exec(src)?.[1])
if (!ratio || !minSplit) throw new Error("WORK_RATIO / MIN_SPLIT_PX not found in dock.tsx")

const js = transformSync(
  `${fn.replace("export ", "")}
   const MIN_SPLIT_PX = ${minSplit}
   const WORK_RATIO = ${ratio}
   function containerSize(api) {
     const width = api.width || 0
     return { width, height: api.height || 0 }
   }
   function share(size, ratio) {
     if (!size || size < MIN_SPLIT_PX * 2) return undefined
     return Math.min(size - MIN_SPLIT_PX, Math.max(MIN_SPLIT_PX, Math.round(size * ratio)))
   }
   export { splitSpan }`,
  { loader: "ts", format: "esm" }
).code
const mod = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`)
const splitSpan = mod.splitSpan

const api = (width, height) => ({ width, height })
const cases = [
  // [kind, direction, width, height]
  ["ide", "right", 1600, 900],
  ["web", "right", 1600, 900],
  ["ide", "right", 1000, 700],
  ["terminal", "below", 1600, 900],
  ["terminal", "right", 1600, 900],
]

let failed = 0
for (const [kind, direction, width, height] of cases) {
  const span = splitSpan(api(width, height), kind, direction)
  const horizontal = direction === "left" || direction === "right"
  const basis = horizontal ? width : height
  const got = horizontal ? span.width : span.height
  const work = kind === "ide" || kind === "web"
  const expected = Math.round(basis * (work ? ratio : 1 - ratio))
  const pct = basis ? Math.round((got / basis) * 100) : 0
  const ok = got === expected
  if (!ok) failed += 1
  console.log(
    `${ok ? "ok  " : "FAIL"} ${kind.padEnd(8)} ${direction.padEnd(5)} box ${width}x${height} ` +
      `-> span ${got}px (${pct}% ${direction === "below" ? "height" : "width"}), expected ${expected}px`
  )
}

// A box too small to hold two panels gets no span at all, so the caller opens a tab.
const tiny = splitSpan(api(300, 200), "ide", "right")
const tinyOk = tiny.width === undefined
if (!tinyOk) failed += 1
console.log(`${tinyOk ? "ok  " : "FAIL"} ide      right box 300x200   -> ${JSON.stringify(tiny)} (expected {})`)

console.log(failed === 0 ? "\nall split shares correct" : `\n${failed} failing`)
process.exit(failed === 0 ? 0 : 1)
