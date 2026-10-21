/* ── An MCP call, and everything without a view of its own ──
   The two live together because they are the same fallback seen from either
   side: an MCP server whose call the harness can read gets the layout below,
   and an unrecognised one falls through to `GenericDetail`. */
import * as React from "react"
import { ChevronRightIcon, PlugZapIcon } from "lucide-react"
import { McpIcon } from "@/components/entity-icon"
import { ToolCallSkeleton } from "@/components/ui/skeletons"
import {
  DetailSection,
  JsonView,
  SmartBlock,
  ToolContentBlocks,
  ToolInput,
  ToolLocations,
  mcpTint,
} from "@/components/tool-parts"
import { TaskProgress } from "@/components/tool-views/subagent"
import { mcpViewOf } from "@/components/tool-views/mcp-registry"
import { useMcpServers } from "@/lib/queries/catalog"
import {
  extractBackgroundTask,
  extractMcpCall,
  mcpAnswer,
  mcpCallLabel,
  mcpServerKey,
  safeJson,
  toolIdentity,
  toolLanguage,
  toolOutputText,
  type McpCall,
} from "@/lib/tools"
import type { ToolItem } from "@/lib/store"
import { cn } from "@/lib/utils"

/**
 * The library row behind an MCP call, by the server's name folded — the one
 * comparison every dialect's spelling agrees on (`GitHub Work` on the row,
 * `mcp__GitHub_Work__…` from Claude Code). Null when the server is not in the
 * library: a runtime's own server, or a thread that outlived the row.
 */
function useMcpServer(call: McpCall | null) {
  const servers = useMcpServers()
  const key = call ? mcpServerKey(call.server) : ""
  return React.useMemo(
    () => (key ? (servers.find((server) => mcpServerKey(server.name) === key) ?? null) : null),
    [servers, key]
  )
}

/**
 * An MCP server's own mark, as the slot a row's step icon takes.
 *
 * A call into an integration used to wear its ACP kind's glyph — a wrench for
 * the `other` Claude Code files every MCP tool under, a terminal for Codex's
 * `execute` — so a transcript of four servers read as four identical marks,
 * where the one fact the row has and the glyph does not is *which* server
 * acted. The library already holds each server's face, so the row wears it
 * (`catalog: false`: a row draws what the row says, and asking every server it
 * mentions for its listing would turn reading a thread into catalog reads).
 *
 * Null for a server nobody in the library names, and the caller keeps its kind
 * glyph — a guess wearing a logo would be worse than a wrench.
 */
export function useMcpMark(
  item: Pick<ToolItem, "title" | "meta" | "rawInput">
): React.ComponentType<{ className?: string }> | null {
  const call = React.useMemo(() => extractMcpCall(item), [item])
  const server = useMcpServer(call)
  return React.useMemo(() => {
    if (!server) return null
    const Mark = ({ className }: { className?: string }) => (
      <McpIcon server={server} catalog={false} className={className} />
    )
    Mark.displayName = `McpMark(${server.name})`
    return Mark
  }, [server])
}

/**
 * The integration that took an MCP call, as a chip on the row's title line.
 *
 * The row leads with the tool — "Get Task" is what happened — and this says
 * where it happened, beside it: two facts, two shapes. Drawn as a chip rather
 * than as the `Server · Tool` run of mono text it used to be, because the pair
 * only reads as a sentence when it is a sentence; when one of them is a *place*,
 * the app's own answer for that is a chip (`CHIP`, the same one a file gets).
 *
 * Text, not a second logo: the row's mark column already wears this server's
 * face, and a 12px copy inside the chip is the same picture twice.
 */
export function McpServerChip({ label }: { label: string }) {
  const tint = mcpTint(label)
  return (
    /* `CHIP`'s geometry with the integration's own colour instead of the muted
       ground — the same size on the same line, one wash per server. Capped and
       elided: a server can be called "Chrome DevTools (Electron)", and the chip
       shares its line with the tool's name — a pill that wrapped would be two
       rows tall in a 24px line box. */
    <span
      className={cn(
        "inline-flex min-w-0 max-w-[8rem] shrink-0 items-center gap-1 rounded-md px-1 py-0.5 font-mono text-xs leading-4",
        tint.wash,
        tint.accent
      )}
      title={`via ${label}`}
    >
      <span className="min-w-0 truncate">{label}</span>
    </span>
  )
}

/**
 * A call into an MCP server: which server, which tool, the arguments as
 * arguments, and the answer underneath.
 *
 * Codex reports these as `kind: "execute"`, which used to route them into the
 * shell layout — a `$` prompt in front of `{"server":"…","tool":"…"}` — and the
 * `{result, error}` envelope printed as JSON rather than the result inside it.
 * Naming the server is the point of the header: the question a reader has about
 * an MCP call is which integration acted.
 *
 * The answer is `mcpAnswer`'s: MCP hands back `{content:[{type:"text",text}],
 * structuredContent, isError}`, and drawn as it arrived the reply was an
 * escaped string three folds deep inside a JSON tree — so it is flattened here,
 * and a server that answers a document still gets the tree (`SmartBlock` is what
 * makes it one). `structuredContent` is the answer only when the server sent no
 * text at all; it never draws a section of its own, so a call's pane is the same
 * pane whatever the server chose to put the answer in.
 *
 * A server whose result has a shape of its own registers a component in
 * `mcp-registry.tsx`, and it is drawn instead of this. What is left here is the
 * default every other call keeps — which is why a registered view is asked for
 * by name and not by a `ToolView` member: an MCP tool is one file's entry.
 */
export function McpDetail({ item, active }: { item: ToolItem; active: boolean }) {
  const call = extractMcpCall(item)
  if (!call) return null
  const registered = mcpViewOf(call)
  if (registered) {
    const { Detail } = registered
    return <Detail item={item} call={call} active={active} />
  }
  const error = call.error === null || call.error === undefined ? null : call.error
  const args = call.arguments
  const hasArgs = args !== undefined && args !== null && JSON.stringify(args) !== "{}"
  const answer = mcpAnswer(call, item.rawOutput)
  const label = mcpCallLabel(call)
  const failed = answer.failed || error !== null || item.status === "failed"
  /* The failure the server reported lives beside the result in MCP's envelope,
     and Codex hoists it into the call's own output — either way it is the
     answer when there is nothing else to show. */
  const text = answer.text.trim() ? answer.text : error === null ? "" : textOf(error)
  const document = failed ? undefined : answer.document
  const structured = error === null ? answer.structured : undefined

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm leading-5">
        <PlugZapIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-mono text-foreground">{label.server}</span>
        {label.tool && (
          <>
            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="font-mono text-muted-foreground">{label.tool}</span>
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
      {failed && text.trim() && (
        <DetailSection label="Error">
          <SmartBlock text={text} tone="error" />
        </DetailSection>
      )}
      {!failed && (text.trim() || item.content.length > 0 || structured != null) && (
        <DetailSection label={active ? "Result so far" : "Result"}>
          {document !== undefined ? (
            <JsonView value={document} text={text} preview={1} />
          ) : text.trim() ? (
            <SmartBlock text={text} />
          ) : item.content.length > 0 ? (
            <ToolContentBlocks item={item} />
          ) : (
            /* A server that answered only machine-readably: the answer is the
               structured half, and it draws where the answer always draws —
               not as a section of its own, because a call's pane is the same
               pane whatever the server chose to send. */
            <JsonView value={structured} text={safeJson(structured)} preview={1} />
          )}
        </DetailSection>
      )}
      {failed && item.content.length > 0 && <ToolContentBlocks item={item} />}
      {active && !text.trim() && item.content.length === 0 && <ToolCallSkeleton className="py-1" />}
    </div>
  )
}

/** Anything a result held, as text — a string stays a string, a structure
    becomes JSON. Only the error path needs this: the answer itself is read by
    `mcpAnswer`, which knows the envelope's shape. */
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
