/* ── Work handed to something else ──
   A subagent call and the background task a call can leave running behind it.
   They live together because a subagent step draws the task's progress panel
   above its own brief, and `GenericDetail` (`./mcp.tsx`) draws the same panel
   for a runtime whose launcher has no view of its own. */
import * as React from "react"
import { BotIcon } from "lucide-react"
import { ToolCallSkeleton } from "@/components/ui/skeletons"
import {
  DetailSection,
  PANE,
  PANE_MAX_H,
  PANE_PAD,
  Prose,
  SmartBlock,
} from "@/components/tool-parts"
import { useTaskEvents, watchTask } from "@/lib/task-events"
import { loadSettings } from "@/lib/settings"
import {
  extractBackgroundTask,
  extractSubagent,
  taskAgentRows,
  taskFindings,
  toolOutputText,
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
  const findings = taskFindings(rows)
  const finished = rows.filter((row) => row.done).length

  if (rows.length === 0) {
    return (
      <p className={cn("text-[11px] text-muted-foreground/70", !unreachable && "harness-shimmer")}>
        {unreachable
          ? "Couldn't follow this task's journal on the server."
          : "Waiting for the task's journal…"}
      </p>
    )
  }
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
        {task.summary && (
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{task.summary}</span>
        )}
        <span className="shrink-0 tabular-nums text-muted-foreground/70">
          {finished}/{rows.length} agents finished
        </span>
      </div>
      <ul className="space-y-0.5">
        {rows.map((row, index) => (
          <li key={row.agentId} className="flex items-center gap-2 text-[11px]">
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                row.failed
                  ? "bg-destructive"
                  : row.done
                    ? "bg-primary"
                    : "harness-node-active bg-primary"
              )}
            />
            {/* The journal's agent ids are hashes; their order is the readable
                identity. The real id stays on the tooltip for cross-reference
                with the transcript dir. */}
            <span
              title={row.agentId}
              className={cn("font-mono", row.done ? "text-muted-foreground" : "harness-shimmer")}
            >
              agent {index + 1}
            </span>
            <span className={cn("text-[10px]", row.failed ? "text-destructive" : "text-muted-foreground/60")}>
              {row.failed ? "failed" : row.done ? "finished" : "running"}
            </span>
          </li>
        ))}
      </ul>
      {findings.length > 0 && (
        <div className={cn(PANE, "max-h-56 overflow-auto")}>
          <ul className="divide-y divide-border/40">
            {findings.map((title, index) => (
              <li key={index} className="px-2.5 py-1 text-[11px] text-muted-foreground">
                {title}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// ─── Subagents ───────────────────────────────────────────────────────────────

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

  return (
    <div className="space-y-2">
      {task && (
        <DetailSection label={task.workflowName ? `Task · ${task.workflowName}` : "Background task"}>
          <TaskProgress task={task} />
        </DetailSection>
      )}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
        <BotIcon className="size-3 shrink-0 text-muted-foreground/60" />
        {call.agentType && <span className="font-mono text-foreground">{call.agentType}</span>}
        {call.model && <span className="text-muted-foreground/70">{call.model}</span>}
        {/* Codex reports a subagent's lifecycle rather than its prompt — the
            activity IS the whole content of the call, so it is not optional
            chrome the way the rest of this row is. */}
        {call.activity && <span className="text-muted-foreground/70">{call.activity}</span>}
        {call.state && <span className="text-muted-foreground/70">{call.state}</span>}
        {call.elapsedSeconds !== undefined && (
          <span className="tabular-nums text-muted-foreground/70">{formatSeconds(call.elapsedSeconds)}</span>
        )}
        {call.description && <span className="text-muted-foreground">{call.description}</span>}
        {call.sessionId && (
          <span className="ml-auto font-mono text-muted-foreground/50" title="The child session the task ran in">
            {call.sessionId}
          </span>
        )}
      </div>
      {call.prompt && (
        <DetailSection label="Brief">
          <div className={cn(PANE_MAX_H, PANE_PAD, "overflow-auto")}>
            <Prose text={call.prompt} />
          </div>
        </DetailSection>
      )}
    </div>
  )
}

/** The report: the parsed `<task_result>` when the runtime wrapped it (OpenCode),
    else whatever the call returned. */
export function SubagentReport({ item, active }: { item: ToolItem; active: boolean }) {
  const call = extractSubagent(item)
  const task = extractBackgroundTask(item)
  if (!call) return null
  const raw = toolOutputText(item)
  const text = call.result ?? raw.text
  const truncated = call.result ? false : raw.truncated
  const failed = item.status === "failed" || call.state === "error" || call.state === "failed"

  if (!text.trim()) {
    return active && !task ? <ToolCallSkeleton className="py-1" /> : null
  }
  return (
    <DetailSection label={failed ? "Error" : active ? "Report so far" : "Report"}>
      <SmartBlock text={truncated ? `${text}\n\n… output truncated` : text} tone={failed ? "error" : undefined} />
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
