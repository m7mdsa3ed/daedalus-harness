/* ── Permission, in the transcript ──
   The one thing the turn is waiting on is drawn where the turn is: at the tail
   of the transcript, beside `InlineElicitation`, on the shared card in
   `agent-request.tsx`. The two are the same event to a reader — the agent has
   stopped and you are what it is waiting for — and they should not be two
   objects in two places on screen.

   It lived on the composer shelf for a while, as a one-line row with its
   evidence folded away, and the shelf is the wrong home for it: the shelf is
   for *state* you consult while typing (the queue, the todos, what is running),
   and it is capped and scrolled as such. A question is not state. It is the end
   of the transcript — the last thing that happened — and the evidence for it (a
   diff, a plan, the arguments) is what you have to read before answering, so it
   wants the flow's full width and the room to be read in place, not a fraction
   of a shelf above the box you type into.

   The card keeps a fold for its evidence, because "what is being approved" runs
   from a two-line command to a forty-step plan; what changes with it is the
   default. A plan opens (see `PlanApproval` below) and everything else stays
   folded behind a row that already names the act in full. */
import * as React from "react"
import type * as acp from "@daedalus/acp"
import {
  CheckIcon,
  ChevronDownIcon,
  ClipboardListIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Shortcut } from "@/components/shortcut"
import {
  AgentRequestActions,
  AgentRequestBody,
  AgentRequestCard,
  AgentRequestHeader,
  AgentRequestWell,
  REQUEST_BUTTON,
} from "./agent-request"
import { FileBadge, PlanFullscreen, Prose } from "./tool-parts"
import { KIND_ICONS, KIND_LABELS, ToolCallContent } from "./thread-items"
import type { PendingPermission } from "@/lib/store"
import { isTypingTarget } from "@/lib/shortcuts"
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

/**
 * How many steps a markdown plan proposes: its top-level list items, ordered or
 * bulleted, with fenced code skipped (a shell snippet is full of `- ` lines that
 * are not steps). Indented items are a step's own detail, not steps of their
 * own, so the count is of `^ {0,3}`.
 *
 * It is a *reading* of prose and it can be wrong, which is why it is only ever
 * shown as a count beside a plan that is on screen in full — never as a
 * substitute for it, and never at all when it reads zero.
 */
function countPlanSteps(markdown: string): number {
  let steps = 0
  let fenced = false
  for (const line of markdown.split("\n")) {
    if (/^\s{0,3}(?:```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    if (/^ {0,3}(?:[-*+]|\d+[.)])\s+\S/.test(line)) steps++
  }
  return steps
}

/** The plan's own title, when it wrote one: the first ATX heading. The agent's
    tool title is "Implement this plan?" — a question, not a name — so the plan's
    own first line says more about *which* plan this is. */
function planTitle(markdown: string): string | null {
  const heading = markdown.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m)
  return heading?.[1]?.trim() || null
}

/**
 * The answers, on the card's own action bar. Shared by both shapes below: the
 * buttons that unblock the agent must look and behave the same whether the
 * thing being approved is a plan or an `rm -rf`, and the digits `ThreadView`
 * binds are counted off this same order.
 *
 * Allows where the eye lands, rejects carried to the far edge by the first
 * reject's auto margin — the destructive choice is never adjacent to the
 * tempting one. The bar sits OUTSIDE the evidence fold, so the buttons are
 * always reachable while the evidence above them is what a reader is looking
 * at.
 */
function PermissionOptions({
  request,
  resolve,
  optionsRef,
}: {
  request: PendingPermission["request"]
  resolve: PendingPermission["resolve"]
  optionsRef: React.RefObject<HTMLDivElement | null>
}) {
  const primaryId = primaryPermissionOption(request.options)
  const rejectStart = request.options.findIndex((o) => o.kind.startsWith("reject"))
  return (
    <AgentRequestActions ref={optionsRef}>
      {request.options.map((option, index) => {
        const primary = option.optionId === primaryId
        const rejecting = option.kind.startsWith("reject")
        const allowing = option.kind.startsWith("allow")
        const OptionIcon = rejecting ? XIcon : allowing ? CheckIcon : null
        return (
          <Button
            key={option.optionId}
            size="sm"
            data-primary-option={primary ? "" : undefined}
            variant={
              primary ? "default" : rejecting ? "destructive" : allowing ? "secondary" : "outline"
            }
            className={index === rejectStart ? `${REQUEST_BUTTON} ms-auto` : REQUEST_BUTTON}
            onClick={() => resolve({ outcome: { outcome: "selected", optionId: option.optionId } })}
          >
            {OptionIcon && <OptionIcon aria-hidden className="size-3.5" />}
            {option.name}
            {/* The keys ThreadView binds while a permission is open: the
                option's own digit, and Enter for the primary. Shown on the
                button they answer — a shortcut nobody can see is a shortcut
                nobody uses — and hidden on touch, where there is no keyboard
                to hint at. */}
            {(index < 9 || primary) && (
              <Shortcut
                className="ms-0.5 hidden sm:inline-flex"
                keys={[...(index < 9 ? [String(index + 1)] : []), ...(primary ? ["↵"] : [])]}
                keyClassName="bg-transparent"
              />
            )}
          </Button>
        )
      })}
    </AgentRequestActions>
  )
}

/** The fold every approval's evidence lives behind. A trigger row that reads
    like the transcript's own step rows, and a body that opens downward inside
    the card — never a second card. */
function EvidenceFold({
  open,
  onOpenChange,
  label,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  label: string
  children: React.ReactNode
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger
        render={
          <button
            type="button"
            className="flex w-fit items-center gap-1 text-[11px] text-muted-foreground/80 transition-colors hover:text-foreground"
          />
        }
      >
        <ChevronDownIcon
          aria-hidden
          className={cn("size-3 transition-transform duration-200", open && "rotate-180")}
        />
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent className="harness-collapse">
        <div className="mt-2 space-y-2.5">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * ── Plan approval ──
 * A plan is not a tool call with a payload attached; it is a document you are
 * being asked to agree to, and the two want opposite defaults. Every other
 * approval names a small, legible act ("Read package.json", "Bash: git status")
 * that the card's header states in full, so its evidence is folded away and the
 * answer is one keystroke. A plan states nothing in one line — the whole of it
 * *is* the question — so folding it put the user one chevron away from
 * approving a document they had not read.
 *
 * So this shape leads with the plan, in prose, the moment the question arrives,
 * and the fold is there to put it *away* once read. The header carries what a
 * plan has instead of a target — its own title and how many steps it proposes.
 * In the transcript the plan can simply be as long as it is; only past half the
 * panel does it scroll inside its own band, so the answers below it are never
 * pushed off the screen the card arrived on.
 */
function PlanApproval({
  permission,
  plan,
  open,
  setOpen,
  optionsRef,
}: {
  permission: PendingPermission
  plan: string
  open: boolean
  setOpen: (open: boolean) => void
  optionsRef: React.RefObject<HTMLDivElement | null>
}) {
  const { request, resolve } = permission
  const title = planTitle(plan) ?? request.toolCall.title ?? "Implement this plan?"
  const steps = countPlanSteps(plan)
  return (
    <AgentRequestCard aria-live="assertive" aria-label={`Plan ready for review: ${title}`}>
      <AgentRequestHeader
        icon={ClipboardListIcon}
        label="Plan ready for review"
        aside={
          steps > 0 && (
            <span className="shrink-0 text-[10px] tracking-wide text-muted-foreground/70">
              {steps} {steps === 1 ? "step" : "steps"}
            </span>
          )
        }
      >
        {title}
      </AgentRequestHeader>
      <AgentRequestBody>
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleContent className="harness-collapse">
            <AgentRequestWell className="max-h-[calc(var(--panel-h,100svh)*0.5)] overflow-auto overscroll-contain px-3 py-3">
              <Prose text={plan} />
            </AgentRequestWell>
          </CollapsibleContent>
          {/* Under the plan, not above it: while it is open this is the way out
              of a long read, and that belongs at the end of what it closes.
              Beside it, the way *in* to a longer one — the band above stops at
              half the panel, and a plan can be longer than that is worth
              scrolling through in a column. */}
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <CollapsibleTrigger
              render={
                <button
                  type="button"
                  className="flex w-fit items-center gap-1 text-[11px] text-muted-foreground/80 transition-colors hover:text-foreground"
                />
              }
            >
              <ChevronDownIcon
                aria-hidden
                className={cn("size-3 transition-transform duration-200", open && "rotate-180")}
              />
              {open ? "Hide the plan" : "Show the plan"}
            </CollapsibleTrigger>
            <PlanFullscreen plan={plan} title={title} />
          </div>
        </Collapsible>
      </AgentRequestBody>
      <PermissionOptions request={request} resolve={resolve} optionsRef={optionsRef} />
    </AgentRequestCard>
  )
}

/**
 * The transcript's permission card: what stopped the turn, what is being asked
 * for, the evidence, the answers. Rendered at the tail of the flow while
 * `thread.permission` is set, and gone the moment it is answered — by this
 * device or another.
 */
export function InlineApproval({ permission }: { permission: PendingPermission | null }) {
  /* Codex asks "Implement this plan?" as a `switch_mode` permission whose
     `rawInput.plan` is the whole markdown proposal, and Claude Code asks the
     same thing as `ExitPlanMode`. Read before the hooks below, because the
     fold's initial state differs for it. */
  const plan = permission ? extractPlanProposalFromPermission(permission.request.toolCall) : null
  const isPlan = plan !== null
  const [open, setOpen] = React.useState(false)
  /* When a new request arrives — keyed on its id, so a second ask refocuses —
     move focus to the primary option so Enter/Space answer it without a pointer
     trip, unless the user is mid-keystroke in an input, where stealing focus
     would eat what they were typing. `isTypingTarget` is the same guard the
     digit shortcuts use. The buttons render in the same commit as the request,
     so the post-render effect finds them.
     The same effect sets the fold, because this component outlives one request:
     a plan arrives open and everything else arrives folded, and neither may
     inherit what the user did to the request before it. */
  const optionsRef = React.useRef<HTMLDivElement>(null)
  const requestId = permission?.requestId
  React.useEffect(() => {
    if (!requestId) return
    setOpen(isPlan)
    if (isTypingTarget(document.activeElement)) return
    const target =
      optionsRef.current?.querySelector<HTMLButtonElement>("[data-primary-option]") ??
      optionsRef.current?.querySelector<HTMLButtonElement>("button")
    target?.focus()
    // `isPlan` is a property of this request, so it cannot change under a
    // stable id — it is read, not depended on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId])
  if (!permission) return null
  if (plan !== null) {
    return (
      <PlanApproval
        permission={permission}
        plan={plan}
        open={open}
        setOpen={setOpen}
        optionsRef={optionsRef}
      />
    )
  }
  const { request, resolve } = permission
  const call = request.toolCall
  const kind = call.kind ?? "other"
  const KindIcon = KIND_ICONS[kind] ?? WrenchIcon
  const input = prettyJson(call.rawInput)
  const output = prettyJson(call.rawOutput)
  const locations = call.locations ?? []
  const content = call.content ?? []
  /* The header has one line to spend, so it prints whichever of these says the
     most — which means the other one is on screen nowhere. Keep both and let
     Details carry the one the heading did not. */
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
    /* A live region: the card appears mid-turn with no focus change of its own,
       so without the announcement a screen reader never hears that the agent
       stopped to ask. Assertive because the turn is blocked on the answer. */
    <AgentRequestCard aria-live="assertive" aria-label={`Permission needed: ${heading}`}>
      <AgentRequestHeader
        icon={KindIcon}
        label="Permission needed"
        aside={
          kind !== "other" && (
            <span className="shrink-0 text-[10px] tracking-wide text-muted-foreground/70">
              {KIND_LABELS[kind]}
            </span>
          )
        }
      >
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="min-w-0 break-words">{heading}</span>
          {h.file && <FileBadge file={h.file} filePath={h.filePath} />}
        </span>
      </AgentRequestHeader>
      <AgentRequestBody>
        {/* What's actually being approved: the diff or output if the agent sent
            one, otherwise the arguments — never nothing. It is the point of the
            card, so unlike the fold below it is not behind anything; the band
            scrolls past half the panel so a long diff cannot carry the answers
            off the bottom of the screen. */}
        <div className="max-h-[calc(var(--panel-h,100svh)*0.5)] space-y-2.5 overflow-auto overscroll-contain">
          {content.length > 0 ? (
            <ToolCallContent content={content} />
          ) : (
            input && (
              <AgentRequestWell>
                <CodeBlock value={input} />
              </AgentRequestWell>
            )
          )}
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
        </div>

        <EvidenceFold open={open} onOpenChange={setOpen} label="Details">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[11px]">
            {call.title && <MetaRow label="Title" value={call.title} mono={false} />}
            {description && <MetaRow label="Description" value={description} mono={false} />}
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
        </EvidenceFold>
      </AgentRequestBody>
      <PermissionOptions request={request} resolve={resolve} optionsRef={optionsRef} />
    </AgentRequestCard>
  )
}
