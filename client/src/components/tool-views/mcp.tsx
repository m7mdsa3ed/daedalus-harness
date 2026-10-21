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

/** The server's face at the scale of a pane's head: a 24px tile, so the mark is
    the first thing the eye lands on and the layout has a left edge to hang
    from. A server the library does not name keeps a plug, not a guess. */
function ServerMark({ call }: { call: McpCall }) {
  const server = useMcpServer(call)
  return (
    <span
      aria-hidden
      className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted"
    >
      {server ? (
        <McpIcon server={server} catalog={false} className="size-4" />
      ) : (
        <PlugZapIcon className="size-3.5 text-muted-foreground" />
      )}
    </span>
  )
}

/**
 * The head of a call's pane: which integration, which tool, and — quiet, on the
 * right, where a wide panel has room for it — the name the agent actually
 * invoked, because that is the thing you paste into a configuration or grep for
 * in a journal. The same three facts the row says, at reading size.
 */
function CallHead({ item, call }: { item: ToolItem; call: McpCall }) {
  const label = mcpCallLabel(call)
  const invoked = item.name ?? toolIdentity(item) ?? ""
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm leading-6">
      <ServerMark call={call} />
      <span className="shrink-0 font-mono text-foreground">{label.server}</span>
      {label.tool && (
        <>
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate font-mono text-muted-foreground">{label.tool}</span>
        </>
      )}
      {invoked && (
        <span
          title={invoked}
          className="ml-auto hidden min-w-0 truncate font-mono text-xs text-muted-foreground/70 @panel-sm:block"
        >
          {invoked}
        </span>
      )}
    </div>
  )
}

/**
 * A call into an MCP server, laid out as the exchange it is: the head names the
 * integration, the arguments stand in their own column, and the answer sits
 * beside them — a request on the left and its reply on the right, stacking into
 * one column when the panel is narrow (`@panel-sm`, so a chat squeezed beside a
 * terminal does not get a 10rem result well).
 *
 * The answer is `mcpAnswer`'s: MCP hands back `{content:[{type:"text",text}],
 * structuredContent, isError}`, and drawn as it arrived the reply was an
 * escaped string three folds deep inside a JSON tree. Flattened, a server that
 * answers a document gets the tree it deserves with its length in the label,
 * and a server that answers prose gets the prose.
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
  const args = call.arguments
  const hasArgs = args !== undefined && args !== null && JSON.stringify(args) !== "{}"
  const answer = mcpAnswer(call, item.rawOutput)
  const error = call.error === null || call.error === undefined ? null : call.error
  const failed = answer.failed || error !== null
  /* The failure the server reported lives beside the result in MCP's envelope,
     and Codex hoists it into the call's own output — either way it is the
     answer when there is nothing else to show. */
  const text = answer.text.trim() ? answer.text : error === null ? "" : textOf(error)
  const document = failed ? undefined : answer.document
  const structured = error === null ? answer.structured : undefined
  const blocks = item.content.length > 0
  const length = Array.isArray(document) ? document.length : null

  return (
    <div className="space-y-2">
      <CallHead item={item} call={call} />
      <div
        className={cn(
          "grid min-w-0 items-start gap-2",
          hasArgs && "@panel-sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]"
        )}
      >
        {hasArgs && (
          <DetailSection label="Arguments">
            {/* The same flat-table-or-JSON reader an ordinary input gets, pointed
                at the arguments rather than at the envelope around them. */}
            <ToolInput item={{ ...item, rawInput: args }} />
          </DetailSection>
        )}
        <div className="min-w-0 space-y-2">
          {failed && text.trim() && (
            <DetailSection label="Error">
              <SmartBlock text={text} tone="error" />
            </DetailSection>
          )}
          {/* The answer, once. A runtime that sent it as ACP content blocks has
              already put it on screen — the same text, drawn by the same
              reader — so the `Result` section is for the dialect that keeps the
              reply on the call itself. */}
          {!failed && (blocks || text.trim()) && (
            <DetailSection
              label={`${active ? "Result so far" : "Result"}${length === null ? "" : ` · ${length}`}`}
            >
              {blocks ? (
                <ToolContentBlocks item={item} />
              ) : document !== undefined ? (
                <JsonView value={document} text={text} preview={1} />
              ) : (
                <SmartBlock text={text} />
              )}
            </DetailSection>
          )}
          {/* The machine-readable half of the same answer: folded at the root,
              because it is what a reader opens when they want the fields rather
              than the sentence the server wrote about them. */}
          {structured !== undefined && structured !== null && (
            <DetailSection label="Structured content">
              <JsonView value={structured} text={safeJson(structured)} preview={0} />
            </DetailSection>
          )}
          {active && !text.trim() && !blocks && <ToolCallSkeleton className="py-1" />}
        </div>
      </div>
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
