import { CheckIcon, ChevronRightIcon, WrenchIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { PendingPermission } from "@/lib/store"
import { cn } from "@/lib/utils"
import { KIND_ICONS, KIND_LABELS, ToolCallContent } from "./thread-items"

/* The card answers one question — "may I do this?" — so the thing being done is
   the headline and the actions are the other thing with weight. Ids, status and
   raw payloads are debugging material: they live behind <details>. The actions
   split spatially: allows on the left where the eye lands, rejects pushed to
   the far edge, so the destructive choice is never adjacent to the tempting one. */

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
    <pre className="max-h-56 overflow-auto rounded-lg border border-border/50 bg-muted/30 px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-foreground/90">
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
      className="animate-in slide-in-from-bottom-1 fade-in zoom-in-[0.99] overflow-hidden rounded-xl border border-primary/30 bg-card/80 shadow-md shadow-primary/5 backdrop-blur-sm duration-200"
    >
      <div className="flex items-start gap-3 p-3.5 pb-3">
        <span className="relative grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-primary ring-1 ring-primary/15 ring-inset">
          <KindIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="harness-shimmer text-[10px] font-medium tracking-widest text-primary uppercase">
              Permission needed
            </p>
            {/* Same right-hand kind column the transcript's step rows scan on,
                dressed as a chip now that the card owns this strip of screen. */}
            <span className="shrink-0 rounded-full border border-border/50 bg-muted/30 px-2 py-px text-[10px] leading-4 tracking-wide text-muted-foreground">
              {KIND_LABELS[kind] ?? KIND_LABELS.other}
            </span>
          </div>
          <p className="mt-1 font-mono text-[13px] leading-snug break-words">
            {call.title || call.name || call.toolCallId}
          </p>
        </div>
      </div>

      <div className="space-y-2.5 px-3.5 pb-3.5">
        {locations.length > 0 && (
          <ul className="flex flex-wrap gap-1">
            {locations.map((location, index) => (
              <li
                key={`${location.path}-${index}`}
                title={location.path}
                className="max-w-full truncate rounded-md border border-border/40 bg-muted/30 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
              >
                {location.path}
                {location.line != null && (
                  <span className="pl-1 text-muted-foreground/60">:{location.line}</span>
                )}
              </li>
            ))}
          </ul>
        )}

        {/* What's actually being approved: the diff or output if the agent sent
            one, otherwise the arguments — never nothing. */}
        {content.length > 0 ? <ToolCallContent content={content} /> : input && <CodeBlock value={input} />}

        <details className="group/details pt-0.5">
          <summary className="-mx-1 inline-flex w-fit cursor-pointer list-none items-center gap-1 rounded px-1 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground">
            <ChevronRightIcon className="size-3 transition-transform group-open/details:rotate-90" />
            Details
          </summary>
          <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11px]">
            <MetaRow label="Session" value={request.sessionId} />
            <MetaRow label="Call ID" value={call.toolCallId} />
            <MetaRow label="Name" value={call.name ?? "—"} />
            <MetaRow label="Status" value={call.status ?? "pending"} />
          </dl>
          {output && (
            <div className="mt-2.5">
              <p className="mb-1 text-[10px] font-medium tracking-widest text-muted-foreground uppercase">
                Raw output
              </p>
              <CodeBlock value={output} />
            </div>
          )}
          {content.length > 0 && input && (
            <div className="mt-2.5">
              <p className="mb-1 text-[10px] font-medium tracking-widest text-muted-foreground uppercase">
                Raw input
              </p>
              <CodeBlock value={input} />
            </div>
          )}
        </details>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-t border-border/50 bg-muted/25 px-3.5 py-2.5">
        {/* The reject side starts at the first reject — that button's leading
            auto margin carries it and everything after it to the opposite edge
            of the bar, so deny never sits beside its tempting affirmative. */}
        {(() => {
          const rejectStart = request.options.findIndex((o) => o.kind.startsWith("reject"))
          return request.options.map((option, index) => {
            const primary = option.optionId === primaryId
            const rejecting = option.kind.startsWith("reject")
            const allowing = option.kind.startsWith("allow")
            const OptionIcon = rejecting ? XIcon : allowing ? CheckIcon : null
            return (
              <Button
                key={option.optionId}
                size="default"
                variant={
                  primary ? "default" : rejecting ? "destructive" : allowing ? "secondary" : "outline"
                }
                className={cn(primary && "font-semibold", index === rejectStart && "ms-auto")}
                onClick={() =>
                  resolve({ outcome: { outcome: "selected", optionId: option.optionId } })
                }
              >
                {OptionIcon && (
                  <OptionIcon data-icon="inline-start" className="size-3.5 opacity-80" />
                )}
                {option.name}
              </Button>
            )
          })
        })()}
      </div>
    </div>
  )
}
