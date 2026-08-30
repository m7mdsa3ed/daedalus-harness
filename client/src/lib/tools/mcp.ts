/* ── MCP calls ── a call into an MCP server, in either of the two forms
   runtimes send. */
import type { ToolItem } from "../store"
import { asRecord, str } from "./helpers"
import { parseMcpToolName, toolIdentity } from "./naming"

/**
 * A call into an MCP server, in either of the two forms runtimes send.
 *
 * Claude Code and OpenCode flatten the server into the tool name
 * (`mcp__<server>__<tool>`) and pass the arguments as the raw input; Codex
 * keeps them apart — `mcp.<server>.<tool>` as the title, `{server, tool,
 * arguments}` as the input, `{result, error}` as the output, and `kind:
 * "execute"`, which is what used to route an MCP call into the shell layout
 * and print a `$` prompt in front of nothing.
 */
export interface McpCall {
  server: string
  tool: string
  arguments?: unknown
  result?: unknown
  error?: unknown
}

export function extractMcpCall(
  item: Pick<ToolItem, "title" | "meta" | "rawInput"> & { rawOutput?: unknown }
): McpCall | null {
  const input = asRecord(item.rawInput)
  const output = asRecord(item.rawOutput)
  const flagged = asRecord(item.meta)?.is_mcp_tool_call === true

  const server = str(input?.server)
  const tool = str(input?.tool)
  if (server && tool && (flagged || "arguments" in (input ?? {}))) {
    return {
      server,
      tool,
      arguments: input?.arguments,
      result: output?.result,
      error: output?.error ?? undefined,
    }
  }

  const name = toolIdentity(item)
  if (!name) return null
  const dotted = /^mcp\.([^.]+)\.(.+)$/.exec(name)
  if (dotted) {
    return {
      server: dotted[1],
      tool: dotted[2],
      arguments: item.rawInput,
      result: output?.result ?? item.rawOutput,
      error: output?.error ?? undefined,
    }
  }
  const parsed = parseMcpToolName(name)
  if (!parsed) return null
  return { server: parsed.server, tool: parsed.tool, arguments: item.rawInput, result: item.rawOutput }
}
