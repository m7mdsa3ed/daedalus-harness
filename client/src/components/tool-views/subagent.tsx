/* ── Work handed to something else ──
   A subagent call and the background task a call can leave running behind it.
   They live together because a subagent step draws the task's progress panel
   above its own brief, and `GenericDetail` (`./mcp.tsx`) draws the same panel
   for a runtime whose launcher has no view of its own. */
import * as React from "react"
import { BotIcon } from "lucide-react"
import { AgentIcon } from "@/components/entity-icon"
import { Badge } from "@/components/ui/badge"
import { ToolCallSkeleton } from "@/components/ui/skeletons"
import {
  DetailSection,
  PANE,
  PANE_PAD,
  SmartBlock,
} from "@/components/tool-parts"
import { Prose } from "@/components/prose"
import { ReportBlock } from "@/components/tool-views/report"
import { useTaskEvents, watchTask } from "@/lib/task-events"
import { loadSettings } from "@/lib/settings"
import {
  agentLabel,
  extractAgentMessage,
  extractBackgroundTask,
  extractSubagent,
  taskAgentRows,
  toolOutputText,
  type AskInfo,
  type BackgroundTask,
} from "@/lib/tools"
import type { ToolItem } from "@/lib/store"
import { cn } from "@/lib/utils"

/** Keeps the server's tail alive through quiet stretches (a subagent can run
    for many minutes between journal lines) and backfills anything a missed
    notification or a reload dropped. The push stream is the fast path; this is
    the floor under it. */
const TASK_REFRESH_MS = 90_000

/**
 * Live progress of a background task — work the agent launched and left
 * running past the end of the turn (a Claude Code workflow, say). The turn is
 * over, so no ACP frame will ever carry this; the events come off the server's
 * tail of the task's own journal on disk. Mounting the panel starts that tail
 * (`/api/tasks/watch`), and the module store it fills is keyed by transcript
 * dir, so every peer and every remount reads the same journal.
 */
export function TaskProgress({ task }: { task: BackgroundTask }) {
  const events = useTaskEvents(task.transcriptDir)
  const [unreachable, setUnreachable] = React.useState(false)
  React.useEffect(() => {
    const settings = loadSettings()
    if (!settings) return
    let cancelled = false
    const ask = () =>
      watchTask(settings, task.transcriptDir).then(
        () => !cancelled && setUnreachable(false),
        () => !cancelled && setUnreachable(true)
      )
    void ask()
    const timer = setInterval(() => void ask(), TASK_REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [task.transcriptDir])

  const rows = taskAgentRows(events)
  const finished = rows.filter((row) => row.done).length

  if (rows.length === 0) {
    return (
      <p className={cn("text-xs text-muted-foreground", !unreachable && "harness-shimmer")}>
        {unreachable
          ? "Couldn't follow this task's journal on the server."
          : "Waiting for the task's journal…"}
      </p>
    )
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        {task.summary && (
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{task.summary}</span>
        )}
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {finished}/{rows.length} agents finished
        </span>
      </div>
      <ul className="space-y-1">
        {rows.map((row, index) => (
          <li key={row.agentId} className="flex items-center gap-2 text-xs leading-5">
            <span aria-hidden className="grid h-5 w-3 shrink-0 place-items-center">
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  row.failed
                    ? "bg-destructive"
                    : row.done
                      ? "bg-primary"
                      : "harness-node-active bg-primary"
                )}
              />
            </span>
            {/* The journal's agent ids are hashes; their order is the readable
                identity. The real id stays on the tooltip for cross-reference
                with the transcript dir. */}
            <span
              title={row.agentId}
              className={cn("font-mono", row.done ? "text-muted-foreground" : "harness-shimmer")}
            >
              agent {index + 1}
            </span>
            <span className={cn("text-xs", row.failed ? "text-destructive" : "text-muted-foreground")}>
              {row.failed ? "failed" : row.done ? "finished" : "running"}
            </span>
          </li>
        ))}
      </ul>
      {rows.some((row) => row.done && row.result !== undefined) && (
        <div className="space-y-2">
          {rows.map((row, index) => {
            if (!row.done || row.result === undefined) return null
            return (
              <div key={row.agentId} className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">Agent {index + 1} result</p>
                <BackgroundAgentResult value={row.result} />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function BackgroundAgentResult({ value }: { value: unknown }) {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value)
  return <ReportBlock text={text} />
}

// ─── Subagents ───────────────────────────────────────────────────────────────

/**
 * Which pair answered an ask — the one worker in a transcript that is not the
 * thread's own agent, said on the row rather than left to the brief.
 *
 * An ask draws as a plain subagent (its spawn carries no workflow `_meta`), so
 * it shares a row with every Task a runtime launches: same mark, same brief,
 * same rail, same report. What it cannot share is the reader's assumption that
 * the worker is the agent they are talking to — so the row wears the asked
 * agent's own mark (the server's `AgentDef.icon`, through `AgentIcon`) and the
 * `agent · profile` pair in the app's accent, while the title stays the errand
 * the caller described. Replayed, it says the names the pair had when it was
 * asked: those ride the journal, and the profile may have been renamed since.
 */
export function AskAgentChip({ ask }: { ask: AskInfo }) {
  const pair = [ask.agent, ask.profile].filter(Boolean).join(" · ")
  if (!pair) return null
  return (
    <Badge
      variant="secondary"
      title={`Answered by ${ask.agent ?? "another agent"}${ask.profile ? ` on ${ask.profile}` : ""}`}
      className="harness-part-in min-w-0 shrink bg-primary/10 text-primary"
    >
      <AgentIcon agentId={ask.agentId} className="size-3 rounded-full" />
      <span className="min-w-0 truncate">{pair}</span>
    </Badge>
  )
}

/**
 * Work handed to another agent: who, what it was asked, what it said back.
 *
 * In two halves, because a subagent with a transcript of its own draws that
 * transcript BETWEEN them (`SubagentStep` in thread-items: brief, then the
 * rail of what it did, then the report) — the order the work happened in.
 * `SubagentDetail` is the two back to back, for a step drawn on its own.
 *
 * The prompt is the interesting half and it is long, so it gets its own
 * bordered block rather than a row in the key/value table an unknown tool
 * would have got — where a five-paragraph brief rendered as one unwrapped
 * cell. A live background task (a workflow that outlives the turn) still shows
 * its own progress panel above all of this.
 */
export function SubagentBrief({ item }: { item: ToolItem }) {
  const call = extractSubagent(item)
  const task = extractBackgroundTask(item)
  if (!call) return null
  /* Not `description`: that is what the row is titled (`stepNameOf`), and a
     line under a title that says the title again is the line a phone can
     least afford. */
  const facts = [
    /* An ask's own row names the pair above this (`AskAgentChip`), and the raw
       `agent` argument it carries is an id half the time — the name is already
       on the line the detail hangs under. */
    call.ask ? undefined : call.agentType,
    call.model,
    // Codex reports a lifecycle rather than a prompt — the activity IS the
    // content of the call, so it is not optional chrome the way the rest is.
    call.activity,
    call.state,
    call.elapsedSeconds !== undefined ? formatSeconds(call.elapsedSeconds) : undefined,
  ].filter(Boolean)

  return (
    <div className="space-y-2">
      {task && (
        <DetailSection label={task.workflowName ? `Task · ${task.workflowName}` : "Background task"}>
          <TaskProgress task={task} />
        </DetailSection>
      )}
      {(facts.length > 0 || call.sessionId) && (
        <div className="flex min-w-0 items-center gap-1 text-xs leading-5 text-muted-foreground">
          <BotIcon className="size-3 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">{facts.join(" · ")}</span>
          {call.sessionId && (
            <span
              className="ml-auto max-w-[40%] shrink truncate font-mono text-muted-foreground"
              title={`The child session the task ran in: ${call.sessionId}`}
            >
              {call.sessionId}
            </span>
          )}
        </div>
      )}
      {call.prompt && <BriefSection text={call.prompt} />}
    </div>
  )
}

/** How tall a folded brief stands — a few lines, enough to know what was asked. */
const BRIEF_FOLD = "max-h-24"

/**
 * What a worker was asked, folded to its first few lines with a fade and one
 * button to read the rest. Not a scroll box: a brief sits inside the
 * transcript's own scroller, and a scroller inside a scroller is where a
 * thumb on a phone gets stuck — the page stops moving and the brief starts.
 * Shared with the subagent rows that carry their brief on the session rather
 * than on a call (`SubagentBody`).
 */
export function BriefSection({ text, label = "Brief" }: { text: string; label?: string }) {
  const [full, setFull] = React.useState(false)
  const body = React.useRef<HTMLDivElement>(null)
  const [overflows, setOverflows] = React.useState(false)
  /* Watched, not measured once: prose can grow after it mounts (a highlighted
     block, an image), and a fold that missed it clips with no way to open. */
  React.useLayoutEffect(() => {
    const el = body.current
    if (!el) return
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el.firstElementChild ?? el)
    return () => observer.disconnect()
  }, [text, full])

  return (
    <DetailSection label={label}>
      <div className={cn(PANE_PAD, "min-w-0")}>
        <div
          ref={body}
          className={cn(
            "min-w-0 overflow-hidden",
            !full && BRIEF_FOLD,
            !full && overflows && "[mask-image:linear-gradient(to_bottom,black_60%,transparent)]"
          )}
        >
          <Prose text={text} />
        </div>
        {(overflows || full) && (
          <button
            type="button"
            onClick={() => setFull((value) => !value)}
            className="mt-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {full ? "Show less" : "Show full brief"}
          </button>
        )}
      </div>
    </DetailSection>
  )
}

/** The report: the parsed `<task_result>` when the runtime wrapped it (OpenCode),
    else whatever the call returned. */
export function SubagentReport({ item, active }: { item: ToolItem; active: boolean }) {
  const call = extractSubagent(item)
  const task = extractBackgroundTask(item)
  if (!call) return null
  const raw = toolOutputText(item, Number.MAX_SAFE_INTEGER)
  const text = call.result ?? raw.text
  const truncated = call.result ? false : raw.truncated
  const failed = item.status === "failed" || call.state === "error" || call.state === "failed"

  if (!text.trim()) {
    return active && !task ? <ToolCallSkeleton className="py-1" /> : null
  }
  return (
    <DetailSection label={failed ? "Error" : active ? "Report so far" : "Report"}>
      <ReportBlock text={truncated ? `${text}\n\n… output truncated` : text} tone={failed ? "error" : undefined} />
    </DetailSection>
  )
}

export function SubagentDetail({ item, active }: { item: ToolItem; active: boolean }) {
  return (
    <div className="space-y-2">
      <SubagentBrief item={item} />
      <SubagentReport item={item} active={active} />
    </div>
  )
}

const formatSeconds = (seconds: number): string =>
  seconds < 60 ? `${Math.round(seconds)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`

/** A follow-up to a subagent: what was said, then what came back. Claude Code
    answers with one status line (a miss is an error to read, a resume names the
    agent it woke); our runtime answers with the child's whole report. */
export function AgentMessageDetail({ item, active }: { item: ToolItem; active: boolean }) {
  const call = extractAgentMessage(item)
  if (!call) return null
  const failed = item.status === "failed" || call.delivered === false
  return (
    <div className="space-y-2">
      {call.message && <BriefSection text={call.message} label="Message" />}
      {call.resumed && !failed ? (
        <p className="text-xs text-muted-foreground">
          Resumed agent {agentLabel(call.resumed)}. Its work continues as a subagent of this thread.
        </p>
      ) : call.reply ? (
        <DetailSection label={failed ? "Not delivered" : "Reply"}>
          <SmartBlock text={call.reply} tone={failed ? "error" : undefined} />
        </DetailSection>
      ) : (
        active && <ToolCallSkeleton className="py-1" />
      )}
    </div>
  )
}
