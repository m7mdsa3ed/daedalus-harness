/* ── A script that makes tool calls ── the Daedalus agent's `repl`
   (`agent/src/tools/repl.ts`): one call whose input is a JavaScript body and
   whose result is what the script returned. The calls it made are rows of
   their own (`<id>:<n>`), nested under it at view time (`ScriptGroup` in
   lib/transcript-rows), so this reads only the script and its answer.

   The result is text, because it is what the *model* is handed back, and the
   agent writes it in one of three forms — read here, not invented here:
   - the returned value (JSON, or a returned string verbatim);
   - `The script threw:\n<stack>`;
   - a bracketed stop note: `[script cancelled]`, `[script killed after …]`,
     `[the script sandbox exited …]`, or `Could not start the script sandbox: …`.
   Any of them may be followed by `\n\nconsole:\n<lines>`. */
import type { ToolItem } from "../store"
import { asRecord, str, vendorMeta } from "./helpers"
import { bareIdentity, parseMcpToolName } from "./naming"
import { toolOutputText } from "./output"

const NAMES = ["repl"]
const CONSOLE = "\n\nconsole:\n"
const THREW = "The script threw:\n"
const STOPPED = /^(\[(script |the script sandbox )[^\]]*\]|Could not start the script sandbox)/

export interface CodeRun {
  code: string
  language: string
  /** What the script returned, verbatim. Null while it runs, and when it did not return. */
  result: string | null
  /** Why it did not return: the thrown error's stack, or the stop note. */
  error: string | null
  /** The error is a stop (cancel, timeout, crash), not the script throwing. */
  stopped: boolean
  logs: string[]
  /** The tools the script called, most-called first — the agent's own count on
      this row (`_meta.daedalus.repl.calls`), live while it runs. */
  calls: { name: string; count: number }[]
}

type Readable = Pick<ToolItem, "title" | "meta" | "rawInput" | "status"> & Partial<Pick<ToolItem, "name" | "content" | "rawOutput" | "terminal">>

export function extractCodeRun(item: Readable): CodeRun | null {
  const named = bareIdentity(item)
  /* An MCP server's own `repl` tool is that server's, not this shape. */
  if (named === null || !NAMES.includes(named) || parseMcpToolName(item.name ?? item.title)) return null
  const input = asRecord(item.rawInput)
  const code = str(input?.code)
  if (!code) return null
  const settled = item.status === "completed" || item.status === "failed"
  const text = settled ? toolOutputText(item as ToolItem, 200_000).text : ""
  return {
    code,
    language: str(input?.language) ?? "javascript",
    ...parseCodeResult(text, item.status === "failed"),
    calls: callsOf(item.meta),
  }
}

function callsOf(meta: unknown): CodeRun["calls"] {
  const calls = asRecord(asRecord(vendorMeta(meta, "daedalus")?.repl)?.calls)
  if (!calls) return []
  return Object.entries(calls)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

export function parseCodeResult(text: string, failed = false): Pick<CodeRun, "result" | "error" | "stopped" | "logs"> {
  if (!text) return { result: null, error: null, stopped: false, logs: [] }
  /* The last marker, since a returned string may itself contain one. */
  const at = text.lastIndexOf(CONSOLE)
  const body = at === -1 ? text : text.slice(0, at)
  const logs = at === -1 ? [] : text.slice(at + CONSOLE.length).split("\n")
  if (failed) return { result: null, error: body, stopped: false, logs }
  if (body.startsWith(THREW)) return { result: null, error: body.slice(THREW.length), stopped: false, logs }
  if (STOPPED.test(body)) return { result: null, error: body, stopped: true, logs }
  return { result: body, error: null, stopped: false, logs }
}

/** The closed row's line: the answer on one line, or that there was none. */
export function codeRunSummary(run: CodeRun): string | null {
  if (run.error !== null) return run.stopped ? "stopped" : "threw"
  if (run.result === null) return null
  let line = run.result.trim()
  try {
    line = JSON.stringify(JSON.parse(line))
  } catch {
    line = line.split("\n")[0] ?? ""
  }
  return line.length > 44 ? `${line.slice(0, 44)}…` : line
}
