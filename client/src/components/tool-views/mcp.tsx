/* ── An MCP call, and everything without a view of its own ──
   The two live together because they are the same fallback seen from either
   side: an MCP server whose call the harness can read gets the named layout
   below, and an unrecognised one falls through to `GenericDetail`. */
import { ChevronRightIcon, PlugZapIcon } from "lucide-react"
import { ToolCallSkeleton } from "@/components/ui/skeletons"
import {
  DetailSection,
  SmartBlock,
  ToolContentBlocks,
  ToolInput,
  ToolLocations,
} from "@/components/tool-parts"
import { TaskProgress } from "@/components/tool-views/subagent"
import {
  extractBackgroundTask,
  extractMcpCall,
  formatMcpName,
  toolLanguage,
  toolOutputText,
} from "@/lib/tools"
import type { ToolItem } from "@/lib/store"

/**
 * A call into an MCP server: which server, which tool, the arguments as
 * arguments, and the result underneath.
 *
 * Codex reports these as `kind: "execute"`, which used to route them into the
 * shell layout — a `$` prompt in front of `{"server":"…","tool":"…"}`, and the
 * `{result, error}` envelope printed as JSON rather than the result inside it.
 * Naming the server is the point of the header: the question a reader has
 * about an MCP call is which integration acted.
 */
export function McpDetail({ item, active }: { item: ToolItem; active: boolean }) {
  const call = extractMcpCall(item)
  if (!call) return null
  const error = call.error === null || call.error === undefined ? null : call.error
  const args = call.arguments
  const hasArgs = args !== undefined && args !== null && JSON.stringify(args) !== "{}"
  const result = error === null ? (call.result ?? item.rawOutput) : null

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-sm">
        <PlugZapIcon className="size-3 shrink-0 text-muted-foreground" />
        <span className="font-mono text-foreground">{formatMcpName(call.server)}</span>
        {call.tool && (
          <>
            <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" />
            <span className="font-mono text-muted-foreground">{formatMcpName(call.tool)}</span>
          </>
        )}
      </div>
      {hasArgs && (
        <DetailSection label="Arguments">
          {/* The same flat-table-or-JSON reader an ordinary input gets, pointed
              at the arguments rather than at the envelope around them. */}
          <ToolInput item={{ ...item, rawInput: args }} />
        </DetailSection>
      )}
      {error !== null && (
        <DetailSection label="Error">
          <SmartBlock text={textOf(error)} tone="error" />
        </DetailSection>
      )}
      {error === null && (result !== undefined && result !== null) && (
        <DetailSection label={active ? "Result so far" : "Result"}>
          <SmartBlock text={textOf(result)} />
        </DetailSection>
      )}
      {item.content.length > 0 && <ToolContentBlocks item={item} />}
      {active && result === null && error === null && <ToolCallSkeleton className="py-1" />}
    </div>
  )
}

/** Anything an MCP server returned, as text — a string stays a string, a
    content-block array is flattened, and a structure becomes JSON. */
function textOf(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2) ?? ""
  } catch {
    return String(value)
  }
}

/** Everything without a view of its own, an unrecognised MCP tool included:
    what went in, what came back. */
export function GenericDetail({ item, active }: { item: ToolItem; active: boolean }) {
  const failed = item.status === "failed"
  const { text, truncated } = toolOutputText(item)
  const hasInput = JSON.stringify(item.rawInput ?? null) !== "null"
  const task = extractBackgroundTask(item)
  return (
    <>
      {task && (
        <DetailSection label={task.workflowName ? `Task · ${task.workflowName}` : "Background task"}>
          <TaskProgress task={task} />
        </DetailSection>
      )}
      {hasInput && (
        <DetailSection label="Input">
          <ToolInput item={item} />
        </DetailSection>
      )}
      {item.locations.length > 0 && (
        <DetailSection label={item.locations.length === 1 ? "File" : "Files"}>
          <ToolLocations item={item} />
        </DetailSection>
      )}
      {(text.trim() || item.content.length > 0) && (
        <DetailSection label={failed ? "Error" : active ? "Output so far" : "Output"}>
          <ToolContentBlocks item={item} />
          {item.content.length === 0 && (
            <SmartBlock
              text={truncated ? `${text}\n\n… output truncated` : text}
              tone={failed ? "error" : undefined}
              language={toolLanguage(item)}
            />
          )}
        </DetailSection>
      )}
      {!text.trim() && item.content.length === 0 && active && (
        <ToolCallSkeleton className="py-1" />
      )}
    </>
  )
}
