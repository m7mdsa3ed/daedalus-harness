/* ── Terminal streams ── shell runs that arrive as a terminal handle rather
   than as content. */
import type { ToolItem } from "../store"
import { asRecord, str } from "./helpers"

/**
 * A shell run that arrives as a terminal rather than as content.
 *
 * Codex announces every command as `content: [{type:"terminal"}]` and then
 * streams the bytes through `_meta.terminal_output_delta` on later updates —
 * unconditionally, whether or not the client claimed the terminal capability.
 * Nothing in ACP's own fields carries that output, so a client that only reads
 * `content`/`rawOutput` shows an empty box for the entire run and a
 * `{formatted_output, exit_code}` blob at the end.
 *
 * The deltas are *deltas*: `_meta` is merged key-wise per update, so the last
 * chunk would be the only chunk that survived. They are accumulated into the
 * item as they arrive instead — which is also what makes replay work, since a
 * replayed thread runs the same reducer over the same journaled updates.
 */
export interface TerminalState {
  /** Everything the command has printed so far. */
  data: string
  /** Set once the process exits; `null` means "exited, no code reported". */
  exitCode?: number | null
  /** Signal name, when the runtime reported one. */
  signal?: string | null
}

export function applyTerminalMeta(
  prev: TerminalState | undefined,
  meta: unknown
): TerminalState | undefined {
  const record = asRecord(meta)
  if (!record) return prev
  let next = prev

  const append = (chunk: string | null) => {
    if (chunk === null) return
    next = { ...(next ?? { data: "" }), data: (next?.data ?? "") + chunk }
  }

  // A snapshot replaces; a delta appends. Codex sends whichever mode the
  // client's capabilities selected, and the completion update may repeat the
  // whole aggregated output as a snapshot — replacing is what keeps that from
  // doubling the log.
  const snapshot = asRecord(record.terminal_output)
  if (snapshot) next = { ...(next ?? { data: "" }), data: str(snapshot.data) ?? "" }
  append(str(asRecord(record.terminal_output_delta)?.data))
  // MCP servers stream progress notifications the same way. It is log output
  // for the same call, so it lands in the same buffer rather than inventing a
  // second pane nobody would look at.
  const mcpDelta = str(asRecord(record.mcp_output_delta)?.data)
  if (mcpDelta !== null) append(next?.data ? `\n${mcpDelta}` : mcpDelta)

  const exit = asRecord(record.terminal_exit)
  if (exit) {
    next = {
      ...(next ?? { data: "" }),
      exitCode: typeof exit.exit_code === "number" ? exit.exit_code : null,
      signal: str(exit.signal),
    }
  }
  return next
}

/** True when the agent said "this call is a terminal" — the content block is a
    handle, not a payload, so rendering it as one prints `[terminal]`. */
export const hasTerminalContent = (item: Pick<ToolItem, "content">): boolean =>
  item.content.some((block) => block.type === "terminal")
