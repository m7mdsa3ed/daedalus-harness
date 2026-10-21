/* ── A layout per MCP tool ──
   `McpDetail` is the layout every MCP call gets, and it is the right one for
   most of them: which server acted, the arguments, the result. A tool whose
   result has a shape worth drawing — a table of libraries, a task with its
   status, a list of pages — registers a component here instead, keyed by the
   pair the call already names.

   The match is on the *leaf* name inside the server, never the flattened one:
   Clickup's `create_task` arrives as `mcp__clickup__create_task` from Claude
   Code and OpenCode and as `mcp.clickup.create_task` from Codex, and one entry
   answers all three. Case and `-`/`_` are folded in `mcpViewOf`, because a
   server's own spelling of its tools is not consistent enough to be a key.

   A registered `Detail` is handed the parsed `McpCall` rather than the item, so
   it cannot depend on which dialect named it. A server whose answer is only
   sometimes the shape worth drawing says so on the entry (`when`) rather than
   drawing an empty pane: the check runs on the whole call, so an entry that
   does not recognise this one leaves the call to the generic layout.

   Adding a UI is one entry in `MCP_TOOL_VIEWS`:

     { server: "context7", tool: "resolve-library-id", Detail: LibrarySearchDetail }

   and the component itself, taking `{ call, item, active }`. No dispatch, no
   `ToolView` member, no edit to `index.tsx`. */

import type * as React from "react"
import type { ToolItem } from "@/lib/store"
import type { McpCall } from "@/lib/tools"

export type McpToolViewProps = {
  item: ToolItem
  /** The call as either dialect described it: server, tool, arguments, result. */
  call: McpCall
  /** True while the call is still producing — a layout draws its own skeleton. */
  active: boolean
}

export type McpToolView = {
  /** The server name as the call carries it. Omit to match every server. */
  server?: string
  /** The tool's leaf name inside that server. Omit to match every tool on it. */
  tool?: string
  /** Whether this call is the shape the view draws. Omit to take them all — a
      view that cannot read an answer should say so here and let the generic
      layout through, rather than draw a heading over nothing. */
  when?: (call: McpCall) => boolean
  Detail: React.ComponentType<McpToolViewProps>
}

/** Read top to bottom, first match wins — so a `{server, tool}` entry outranks a
    server-wide one, and a server-wide one outranks a tool-wide one over all
    servers. Empty until a server earns a layout: the generic reader is not a
    placeholder, it is the default. */
export const MCP_TOOL_VIEWS: McpToolView[] = []

/* `create_task`, `create-task` and `Create_Task` are one key. */
const key = (value: string): string => value.trim().toLowerCase().replace(/[_\s]+/g, "-")

export function mcpViewOf(call: McpCall): McpToolView | null {
  const server = key(call.server)
  const tool = key(call.tool)
  return (
    MCP_TOOL_VIEWS.find(
      (entry) =>
        (entry.server === undefined || key(entry.server) === server) &&
        (entry.tool === undefined || key(entry.tool) === tool) &&
        (entry.when?.(call) ?? true)
    ) ?? null
  )
}
