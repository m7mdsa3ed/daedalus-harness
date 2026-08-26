import type * as acp from "@agentclientprotocol/sdk"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { ShieldQuestionIcon } from "lucide-react"
import type { ReactNode } from "react"

import { Button } from "@/components/ui/button"
import type { PendingPermission } from "@/lib/store"
import { cn } from "@/lib/utils"

function prettyJson(value: unknown): string | null {
  if (value === undefined || value === null) return null
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex min-w-0 gap-2">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-words">{value}</span>
    </div>
  )
}

function CodeBlock({ value }: { value: string }) {
  return (
    <pre className="max-h-40 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[11px] whitespace-pre-wrap">
      {value}
    </pre>
  )
}

function ToolCallDetail({ content }: { content: acp.ToolCallContent }) {
  if (content.type === "content") {
    if (content.content.type === "text") {
      return (
        <div className="prose prose-sm max-w-none text-xs">
          <Markdown remarkPlugins={[remarkGfm]}>{content.content.text}</Markdown>
        </div>
      )
    }
    return <CodeBlock value={prettyJson(content.content) ?? "[unsupported content]"} />
  }
  if (content.type === "diff") {
    return (
      <div className="overflow-hidden rounded-md border border-border/60 font-mono text-[11px]">
        <div className="truncate border-b border-border/60 bg-muted/40 px-2 py-1 text-muted-foreground">
          {content.path}
        </div>
        {content.oldText != null && content.oldText !== "" && (
          <pre className="max-h-32 overflow-auto bg-red-500/10 p-2 whitespace-pre-wrap text-red-700 dark:text-red-300">
            {content.oldText}
          </pre>
        )}
        <pre className="max-h-32 overflow-auto bg-green-500/10 p-2 whitespace-pre-wrap text-green-700 dark:text-green-300">
          {content.newText}
        </pre>
      </div>
    )
  }
  if (content.type === "terminal") {
    return (
      <DetailRow
        label="Terminal"
        value={<span className="font-mono break-all">{content.terminalId}</span>}
      />
    )
  }
  return <CodeBlock value={prettyJson(content) ?? "[unsupported content]"} />
}

const KIND_LABELS: Record<string, string> = {
  read: "read",
  edit: "edit",
  delete: "delete",
  move: "move",
  search: "search",
  execute: "run",
  think: "think",
  fetch: "fetch",
  switch_mode: "mode",
  other: "tool",
}

export function InlineToolApproval({ permission }: { permission: PendingPermission }) {
  const { request, resolve } = permission
  const call = request.toolCall
  const input = prettyJson(call.rawInput)
  const output = prettyJson(call.rawOutput)

  return (
    <div
      aria-live="polite"
      className="rounded-xl border border-ring/25 bg-card/70 p-3 shadow-xs"
      role="group"
    >
      <div className="flex items-center gap-2">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
          <ShieldQuestionIcon className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-5 font-medium">Approval required</p>
          <p className="truncate text-xs text-muted-foreground">
            {call.title || call.name || call.toolCallId}
          </p>
        </div>
        <span className="harness-shimmer shrink-0 text-[11px] text-primary">pending</span>
      </div>

      <div className="mt-3 space-y-1.5 rounded-lg bg-muted/35 p-2.5 text-xs">
        <DetailRow label="Session" value={<span className="font-mono break-all">{request.sessionId}</span>} />
        <DetailRow label="Call ID" value={<span className="font-mono break-all">{call.toolCallId}</span>} />
        <DetailRow label="Name" value={<span className="font-mono break-all">{call.name ?? "—"}</span>} />
        <DetailRow label="Kind" value={KIND_LABELS[call.kind ?? "other"] ?? KIND_LABELS.other} />
        <DetailRow label="Status" value={call.status ?? "pending"} />
        <DetailRow label="Title" value={call.title ?? "—"} />
      </div>

      {(input || output) && (
        <div className="mt-3 space-y-2">
          {input && (
            <section>
              <p className="mb-1 text-[11px] tracking-wide text-muted-foreground uppercase">Raw input</p>
              <CodeBlock value={input} />
            </section>
          )}
          {output && (
            <section>
              <p className="mb-1 text-[11px] tracking-wide text-muted-foreground uppercase">Raw output</p>
              <CodeBlock value={output} />
            </section>
          )}
        </div>
      )}

      {((call.locations?.length ?? 0) > 0 || (call.content?.length ?? 0) > 0) && (
        <div className="mt-3 space-y-2">
          {(call.locations?.length ?? 0) > 0 && (
            <section>
              <p className="mb-1 text-[11px] tracking-wide text-muted-foreground uppercase">Locations</p>
              <ul className="space-y-0.5 font-mono text-[11px] text-muted-foreground">
                {(call.locations ?? []).map((location, index) => (
                  <li key={`${location.path}-${index}`} className="truncate">
                    {location.path}
                    {location.line != null && `:${location.line}`}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {(call.content?.length ?? 0) > 0 && (
            <section>
              <p className="mb-1 text-[11px] tracking-wide text-muted-foreground uppercase">Call details</p>
              <div className="space-y-2">
                {(call.content ?? []).map((content, index) => (
                  <ToolCallDetail key={index} content={content} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      <div className="mt-3 grid gap-1.5 sm:grid-cols-2">
        {request.options.map((option) => (
          <Button
            key={option.optionId}
            variant={
              option.kind.startsWith("allow")
                ? "default"
                : option.kind.startsWith("reject")
                  ? "destructive"
                  : "outline"
            }
            className={cn("h-auto min-h-7 justify-between px-2 py-1 text-xs")}
            onClick={() => resolve({ outcome: { outcome: "selected", optionId: option.optionId } })}
          >
            <span>{option.name}</span>
            <span className="text-[10px] opacity-70">{option.kind.replaceAll("_", " ")}</span>
          </Button>
        ))}
      </div>
    </div>
  )
}
