import * as React from "react"
import type * as acp from "@agentclientprotocol/sdk"
import { CheckIcon, ChevronRightIcon, WrenchIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  AgentRequestActions,
  AgentRequestBody,
  AgentRequestCard,
  AgentRequestHeader,
  AgentRequestWell,
  REQUEST_BUTTON,
} from "./agent-request"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import type { PendingPermission } from "@/lib/store"
import { KIND_ICONS, KIND_LABELS, ToolCallContent } from "./thread-items"

/* ── Permission card ──
   The card answers one question — "may I do this?" — so the thing being done is
   the headline and the actions are the other thing with weight. Ids, status and
   raw payloads are debugging material: they live behind <details>. The actions
   split spatially: allows on the left where the eye lands, rejects pushed to
   the far edge, so the destructive choice is never adjacent to the tempting one.

   The frame — accent rail, tinted body, tinted action bar, pill buttons — is
   `agent-request.tsx`, shared with the question card. The two are the same
   event to a reader (the turn has stopped, you are what it is waiting for) and
   they should not be two different objects on screen. What is local to this
   file is only what a permission actually is: the tool, what it wants to touch,
   and the options the agent offered. */

/**
 * The option the card gives the primary button to — and, because it is exported,
 * the one Enter answers with from the transcript (see ThreadView's hotkeys).
 * One definition, so the keyboard and the card can never disagree about which
 * "yes" is the default.
 *
 * Emphasise the narrow yes over the standing one: an agent that lists
 * allow_always first shouldn't get the primary button for it by accident.
 */
export function primaryPermissionOption(
  options: acp.RequestPermissionRequest["options"]
): string | undefined {
  return (
    options.find((o) => o.kind === "allow_once")?.optionId ??
    options.find((o) => o.kind.startsWith("allow"))?.optionId
  )
}

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
    <pre className="max-h-56 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-foreground/90">
      {value}
    </pre>
  )
}

/** The caption-tier heading the tool-call details already use, so a section
    means the same thing wherever it appears. */
function Label({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="text-[10px] font-semibold tracking-[0.08em] uppercase text-muted-foreground/50">
      {children}
    </h4>
  )
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground/70">{label}</dt>
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
  const primaryId = primaryPermissionOption(request.options)
  /* The reject side starts at the first reject — that button's leading auto
     margin carries it and everything after it to the opposite edge of the row,
     so deny never sits beside its tempting affirmative. */
  const rejectStart = request.options.findIndex((o) => o.kind.startsWith("reject"))

  return (
    <AgentRequestCard>
      <AgentRequestHeader
        icon={KindIcon}
        label="Permission needed"
        /* The kind keeps the right-hand column the transcript's step rows are
           scanned on, at caption weight. */
        aside={
          <span className="shrink-0 text-[10px] tracking-wide text-muted-foreground/70">
            {KIND_LABELS[kind] ?? KIND_LABELS.other}
          </span>
        }
      >
        {call.title || call.name || call.toolCallId}
      </AgentRequestHeader>

      <AgentRequestBody>
        {locations.length > 0 && (
          <ul className="flex flex-wrap gap-1">
            {locations.map((location, index) => (
              <li
                key={`${location.path}-${index}`}
                title={location.path}
                className="max-w-full truncate rounded-md bg-background/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
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
        {content.length > 0 ? (
          <ToolCallContent content={content} />
        ) : (
          input && (
            <AgentRequestWell>
              <CodeBlock value={input} />
            </AgentRequestWell>
          )
        )}

        <details className="group/details">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-[11px] text-muted-foreground/80 transition-colors hover:text-foreground">
            <ChevronRightIcon
              aria-hidden
              className="size-3 transition-transform group-open/details:rotate-90"
            />
            Details
          </summary>
          <div className="mt-2 space-y-2.5">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[11px]">
              <MetaRow label="Session" value={request.sessionId} />
              <MetaRow label="Call ID" value={call.toolCallId} />
              <MetaRow label="Name" value={call.name ?? "—"} />
              <MetaRow label="Status" value={call.status ?? "pending"} />
            </dl>
            {output && (
              <section className="space-y-1">
                <Label>Raw output</Label>
                <AgentRequestWell>
                  <CodeBlock value={output} />
                </AgentRequestWell>
              </section>
            )}
            {content.length > 0 && input && (
              <section className="space-y-1">
                <Label>Raw input</Label>
                <AgentRequestWell>
                  <CodeBlock value={input} />
                </AgentRequestWell>
              </section>
            )}
          </div>
        </details>
      </AgentRequestBody>

      {/* Allows where the eye lands, rejects carried to the far edge by the
          first reject's auto margin — the destructive choice is never adjacent
          to the tempting one. */}
      <AgentRequestActions>
        {request.options.map((option, index) => {
          const primary = option.optionId === primaryId
          const rejecting = option.kind.startsWith("reject")
          const allowing = option.kind.startsWith("allow")
          const OptionIcon = rejecting ? XIcon : allowing ? CheckIcon : null
          return (
            <Button
              key={option.optionId}
              size="sm"
              variant={
                primary ? "default" : rejecting ? "destructive" : allowing ? "secondary" : "outline"
              }
              className={index === rejectStart ? `${REQUEST_BUTTON} ms-auto` : REQUEST_BUTTON}
              onClick={() =>
                resolve({ outcome: { outcome: "selected", optionId: option.optionId } })
              }
            >
              {OptionIcon && <OptionIcon aria-hidden className="size-3.5" />}
              {option.name}
              {/* The keys ThreadView binds while a permission is open: the
                  option's own digit, and Enter for the primary. Shown on the
                  button they answer — a shortcut nobody can see is a shortcut
                  nobody uses — and hidden on touch, where there is no keyboard
                  to hint at. */}
              {(index < 9 || primary) && (
                <KbdGroup className="ms-0.5 hidden sm:inline-flex">
                  {index < 9 && <Kbd className="bg-transparent">{index + 1}</Kbd>}
                  {primary && <Kbd className="bg-transparent">↵</Kbd>}
                </KbdGroup>
              )}
            </Button>
          )
        })}
      </AgentRequestActions>
    </AgentRequestCard>
  )
}
