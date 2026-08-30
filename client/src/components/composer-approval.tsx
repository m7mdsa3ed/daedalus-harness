/* ── Permission, on the strip ──
   The card used to block the transcript; now the shelf above the composer owns
   the one thing a turn is waiting on. A reader who has scrolled up to read the
   history no longer collides with the question — the approval sits with the
   other per-turn state, where the plan, the notice and the todos already are.

   Two bands, matching the checklist surfaces: a collapsed row that is always
   visible — the tool being approved and the options that answer it — and an
   expandable evidence band (the diff, the plan, the raw arguments) that opens
   downward into the strip. The strip is a stack, so the buttons can never be
   more than one row tall; the evidence scrolls inside its own cap so a long
   diff cannot push the composer off-screen.

   The frame and buttons are `agent-request.tsx`, shared with the question card:
   the two are the same event to a reader and they should not be two objects on
   screen. Only the accent rail is gone — a strip row is one item among several,
   not the full-width card the transcript version had room to be. */
import * as React from "react"
import type * as acp from "@agentclientprotocol/sdk"
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, WrenchIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import {
  AgentRequestBody,
  AgentRequestWell,
  REQUEST_BUTTON,
} from "./agent-request"
import { ComposerStripItem } from "./composer-strip"
import { FileBadge, Prose } from "./tool-parts"
import { KIND_ICONS, KIND_LABELS, ToolCallContent } from "./thread-items"
import type { PendingPermission } from "@/lib/store"
import { extractPlanProposalFromPermission, toolDescription, toolHeading } from "@/lib/tools"
import { cn } from "@/lib/utils"

/**
 * The option the row gives the primary button to — and, because it is exported,
 * the one Enter answers with from the transcript (see ThreadView's hotkeys).
 * One definition, so the keyboard and the row can never disagree about which
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

function MetaRow({
  label,
  value,
  mono = true,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <>
      <dt className="text-muted-foreground/70">{label}</dt>
      <dd className={cn("min-w-0 break-words", mono ? "font-mono break-all" : "whitespace-pre-wrap")}>
        {value}
      </dd>
    </>
  )
}

export function ComposerApproval({ permission }: { permission: PendingPermission | null }) {
  const [open, setOpen] = React.useState(false)
  if (!permission) return null
  const { request, resolve } = permission
  const call = request.toolCall
  const kind = call.kind ?? "other"
  /* Codex asks "Implement this plan?" as a `switch_mode` permission whose
     `rawInput.plan` is the whole markdown proposal — the point of the row.
     Detect it and render the plan as prose, not as a JSON dump of the wrapper. */
  const plan = extractPlanProposalFromPermission(call)
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
  /* The collapsed row has one line to spend, so it prints whichever of these
     says the most — which means the other one is on screen nowhere. Keep both
     and let Details carry the one the heading did not. */
  const description = toolDescription({
    meta: call._meta,
    rawInput: call.rawInput,
    title: call.title,
  })
  const heading = description ?? call.name ?? call.toolCallId
  /* The file badge rides on the heading row the same way it does on a step row:
     `toolHeading` names the file and strips it out of the prose, so the card
     says "Read" + a `package.json` chip rather than an elided path. */
  const h = toolHeading({
    title: call.title,
    rawInput: call.rawInput,
    meta: call._meta ?? undefined,
    toolKind: call.kind ?? undefined,
    locations: call.locations ?? [],
  })

  return (
    <ComposerStripItem>
      <Collapsible open={open} onOpenChange={setOpen} className="w-full">
        <CollapsibleTrigger
          render={
            <button
              type="button"
              className="flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors hover:bg-accent/40"
            />
          }
        >
          <span className="shrink-0 text-primary">
            <KindIcon aria-hidden className="size-3.5" />
          </span>
          {/* Two lines, one object: the caption says WHY the turn stopped, and
              the line under it names the thing being approved. The caption
              shimmers — this is the one thing on screen that is waiting, the
              same "now" the working line and the live plan step already use. */}
          <span className="min-w-0 flex-1">
            <span className="harness-shimmer block truncate text-[10px] font-semibold tracking-[0.08em] text-primary uppercase">
              Permission needed
            </span>
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 truncate text-xs text-muted-foreground">{heading}</span>
              {h.file && <FileBadge file={h.file} filePath={h.filePath} />}
            </span>
          </span>
          {/* The kind keeps the transcript's step-row right-hand column, at
              caption weight, so the two objects read on the same axis. */}
          {plan ? (
            <span className="shrink-0 text-[10px] tracking-wide text-muted-foreground/70">
              plan
            </span>
          ) : (
            kind !== "other" && (
              <span className="shrink-0 text-[10px] tracking-wide text-muted-foreground/70">
                {KIND_LABELS[kind]}
              </span>
            )
          )}
          <span className="flex shrink-0 items-center gap-1.5">
            <span className="grid size-4 place-items-center">
              <ChevronDownIcon
                aria-hidden
                className={cn(
                  "size-3.5 text-muted-foreground transition-transform duration-200",
                  open && "rotate-180"
                )}
              />
            </span>
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="harness-collapse">
          <AgentRequestBody className="mt-0 space-y-2.5 border-t border-border/40 px-2 pt-2">
            {/* What's actually being approved: the diff or output if the agent
                sent one, otherwise the arguments — never nothing. A plan
                approval is the plan itself, so it wins over both. */}
            {plan ? (
              <AgentRequestWell className="px-3 py-3">
                <Prose text={plan} />
              </AgentRequestWell>
            ) : content.length > 0 ? (
              <ToolCallContent content={content} />
            ) : (
              input && (
                <AgentRequestWell>
                  <CodeBlock value={input} />
                </AgentRequestWell>
              )
            )}

            {/* Evidence rides in a scrolled band: a long diff is read a page at a
                time, and the shelf has no room to grow past the composer. */}
            <div className="max-h-[50vh] space-y-2.5 overflow-auto">
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
                    {call.title && <MetaRow label="Title" value={call.title} mono={false} />}
                    {description && (
                      <MetaRow label="Description" value={description} mono={false} />
                    )}
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
            </div>
          </AgentRequestBody>
        </CollapsibleContent>
      </Collapsible>
      {/* Allows where the eye lands, rejects carried to the far edge by the
          first reject's auto margin — the destructive choice is never adjacent
          to the tempting one. The action row sits OUTSIDE the collapsible so
          the buttons are always reachable, even while the evidence above them
          is what a reader is looking at. */}
      <div className="flex flex-wrap items-center gap-2 px-2 pb-1.5">
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
      </div>
    </ComposerStripItem>
  )
}
