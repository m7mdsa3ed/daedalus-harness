import { ChevronRightIcon, WrenchIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { PendingPermission } from "@/lib/store"
import { cn } from "@/lib/utils"
import { KIND_ICONS, KIND_LABELS, ToolCallContent } from "./thread-items"

/* The card answers one question — "may I do this?" — so the thing being done is
   the headline and the buttons are the only other thing with weight. Ids, status
   and raw payloads are debugging material: they live behind <details>. */

function prettyJson(value: unknown): string | null {
  if (value === undefined || value === null) return null
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function CodeBlock({ value }: { value: string }) {
  return (
    <pre className="max-h-48 overflow-auto rounded-md border border-border/50 bg-muted/40 px-2.5 py-2 font-mono text-[11px] whitespace-pre-wrap">
      {value}
    </pre>
  )
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 font-mono break-all">{value}</dd>
    </>
  )
}

export function InlineToolApproval({ permission }: { permission: PendingPermission }) {
  const { request, resolve } = permission
  const call = request.toolCall
  const kind = call.kind ?? "other"
  const KindIcon = KIND_ICONS[kind] ?? WrenchIcon
  const input = prettyJson(call.rawInput)
  const output = prettyJson(call.rawOutput)
  const locations = call.locations ?? []
  const content = call.content ?? []
  /* Emphasise the narrow "yes" over the standing one — an agent that lists
     allow_always first shouldn't get the primary button for it by accident. */
  const primaryId =
    request.options.find((o) => o.kind === "allow_once")?.optionId ??
    request.options.find((o) => o.kind.startsWith("allow"))?.optionId

  return (
    <div
      aria-live="polite"
      role="group"
      className="overflow-hidden rounded-xl border border-primary/30 bg-card/70 shadow-xs"
    >
      <div className="flex items-start gap-2.5 p-3">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
          <KindIcon className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="harness-shimmer text-[11px] tracking-wide text-primary uppercase">
            Permission needed
          </p>
          <p className="mt-0.5 font-mono text-xs leading-5 break-words">
            {call.title || call.name || call.toolCallId}
          </p>
        </div>
        {/* Same right-hand kind column the transcript's step rows scan on. */}
        <span className="shrink-0 text-[11px] leading-5 text-muted-foreground/60">
          {KIND_LABELS[kind] ?? KIND_LABELS.other}
        </span>
      </div>

      <div className="space-y-2 px-3 pb-3">
        {locations.length > 0 && (
          <ul className="space-y-0.5 font-mono text-[11px] text-muted-foreground/80">
            {locations.map((location, index) => (
              <li key={`${location.path}-${index}`} className="truncate">
                {location.path}
                {location.line != null && `:${location.line}`}
              </li>
            ))}
          </ul>
        )}

        {/* What's actually being approved: the diff or output if the agent sent
            one, otherwise the arguments — never nothing. */}
        {content.length > 0 ? <ToolCallContent content={content} /> : input && <CodeBlock value={input} />}

        <details className="group/details">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
            <ChevronRightIcon className="size-3 transition-transform group-open/details:rotate-90" />
            Details
          </summary>
          <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11px]">
            <MetaRow label="Session" value={request.sessionId} />
            <MetaRow label="Call ID" value={call.toolCallId} />
            <MetaRow label="Name" value={call.name ?? "—"} />
            <MetaRow label="Status" value={call.status ?? "pending"} />
          </dl>
          {content.length > 0 && input && (
            <div className="mt-2">
              <p className="mb-1 text-[11px] tracking-wide text-muted-foreground uppercase">Raw input</p>
              <CodeBlock value={input} />
            </div>
          )}
          {output && (
            <div className="mt-2">
              <p className="mb-1 text-[11px] tracking-wide text-muted-foreground uppercase">Raw output</p>
              <CodeBlock value={output} />
            </div>
          )}
        </details>
      </div>

      <div className="flex flex-wrap gap-1.5 border-t border-border/50 bg-muted/25 px-3 py-2.5">
        {request.options.map((option) => (
          <Button
            key={option.optionId}
            size="lg"
            variant={
              option.optionId === primaryId
                ? "default"
                : option.kind.startsWith("reject")
                  ? "destructive"
                  : option.kind.startsWith("allow")
                    ? "secondary"
                    : "outline"
            }
            className={cn(option.optionId === primaryId && "font-medium")}
            onClick={() => resolve({ outcome: { outcome: "selected", optionId: option.optionId } })}
          >
            {option.name}
          </Button>
        ))}
      </div>
    </div>
  )
}
