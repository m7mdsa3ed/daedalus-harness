/* ── Output ── anything a runtime calls "output", as text. */
import type { ToolItem } from "../store"
import { asRecord, str } from "./helpers"

/** Anything a runtime calls "output", as text. Flattens ACP content arrays,
    falls back to pretty JSON, and reports whether it had to cut. */
export function stringifyOutput(
  value: unknown,
  max = 20_000
): { text: string; truncated: boolean } {
  let text: string
  if (typeof value === "string") text = value
  else if (value === undefined || value === null) text = ""
  else if (Array.isArray(value)) {
    const blocks = value
      .map((entry) => {
        const record = asRecord(entry)
        if (!record) return typeof entry === "string" ? entry : null
        const inner = asRecord(record.content)
        return str(inner?.text) ?? str(record.text) ?? null
      })
      .filter((entry): entry is string => entry !== null)
    text = blocks.length === value.length ? blocks.join("\n") : safeJson(value)
  } else {
    const record = asRecord(value)
    // The common single-field wrappers: {output}, {stdout}, {text}, {result}.
    /* The single-field wrappers a runtime puts its output inside:
       `{output}`, `{stdout, stderr}`, `{text}`, `{result}`, and Codex's
       `{formatted_output, exit_code}` — printing the JSON around any of them
       shows the reader the envelope instead of the letter.

       `text`, not `str`: an empty string is a real answer here — a command
       that printed nothing — and treating it as absent fell through to
       stringifying the wrapper, so a silent success rendered as
       `{"formatted_output": "", "exit_code": 0}`. */
    const text_ = (key: string): string | null =>
      record && typeof record[key] === "string" ? (record[key] as string) : null
    const streams = record
      ? ["stdout", "stderr"]
          .map(text_)
          .filter((part): part is string => part !== null && part.length > 0)
      : []
    const unwrapped =
      text_("output") ??
      text_("formatted_output") ??
      (streams.length > 0 ? streams.join("\n") : (text_("stdout") ?? text_("stderr"))) ??
      text_("text") ??
      text_("result")
    if (unwrapped !== null) text = unwrapped
    /* Codex's MCP envelope, `{result: {content: [{type: "text", text}],
       structuredContent}, error}`: the letter is two levels down and the
       inner one is a content array, which the array branch above already
       reads. Recursing keeps every runtime's web search on one parser — the
       harness's own server answers a numbered list as text, and it was
       reaching the reader as escaped JSON with no results in it. */
    else if (record && (asRecord(record.result) || Array.isArray(record.result)))
      return stringifyOutput(record.result, max)
    else if (record && Array.isArray(record.content)) return stringifyOutput(record.content, max)
    else text = safeJson(value)
  }
  return text.length > max
    ? { text: text.slice(0, max), truncated: true }
    : { text, truncated: false }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? ""
  } catch {
    return String(value)
  }
}

/** The text a tool produced: `rawOutput` when the agent sent one, else the
    text it streamed into `content`. */
export function toolOutputText(item: ToolItem, max = 20_000): { text: string; truncated: boolean } {
  // A terminal's stream beats both, and beats them even mid-run: it is the
  // only source that exists while the command is still printing, and at the
  // end it is the same bytes `rawOutput.formatted_output` repeats.
  if (item.terminal && item.terminal.data.length > 0) {
    const data = item.terminal.data
    return data.length > max
      ? { text: data.slice(0, max), truncated: true }
      : { text: data, truncated: false }
  }
  if (item.rawOutput !== undefined && item.rawOutput !== null) {
    return stringifyOutput(item.rawOutput, max)
  }
  const text = item.content
    .map((block) =>
      block.type === "content" && block.content.type === "text" ? block.content.text : ""
    )
    .filter(Boolean)
    .join("\n")
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false }
}

export const toolFailed = (item: ToolItem): boolean => item.status === "failed"
