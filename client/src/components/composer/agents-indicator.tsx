/* ── The subagents out working ──
   The count in the footer's cluster, and `runningAgents` — the one reading of
   "who is still out", shared with the working line. */
import { formatCount } from "@/components/composer-strip"
import { Spinner } from "@/components/ui/spinner"
import { useEffect, useMemo, useState } from "react"
import { NetworkIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverTrigger } from "@/components/ui/popover"
import {
  READING_MARK,
  READING_TRIGGER,
  ReadingBubble,
  ReadingFace,
  OpenInInspector,
  READING_LIST,
  ReadingPopoverContent,
} from "@/components/composer/indicator"
import { extractSubagent } from "@/lib/tools"
import { activeSubagents, buildRows } from "@/lib/transcript-rows"
import { type ThreadState, workLive } from "@/lib/store"
import { cn } from "@/lib/utils"

/** One subagent still at work, whichever way its runtime announced it. */
interface RunningAgent {
  id: string
  /** What it was asked — the Task's description, or the RFD's `task`. */
  task: string
  /** Who it is — `code-reviewer`, the RFD's `name`. */
  name?: string
  startedAt: number
}

/**
 * The subagents at work right now. One reading, shared with the transcript:
 * `buildRows` decides which subagent group is `active` (see `subagentActive`
 * in lib/transcript-rows — the turn, the head, its children, and for a
 * background launch whether its owner has spoken since), and this is that
 * list flattened, nested workers included, with each head read for a name
 * and a brief.
 */
export function runningAgents(thread: Pick<ThreadState, "items" | "turnActive">): RunningAgent[] {
  return activeSubagents(buildRows(thread.items, false, thread.turnActive)).map(({ head }) => {
    if (head.kind === "subagent") {
      /* A workflow step is titled by its step and kinded by its workflow; an
         ask's `task` is the description its caller gave it. */
      if (head.workflow) {
        return { id: head.id, task: head.workflow.step || head.task || head.name, name: head.workflow.name, startedAt: head.startedAt }
      }
      return { id: head.id, task: head.task || head.name, name: head.name, startedAt: head.startedAt }
    }
    const call = extractSubagent(head)
    return {
      id: head.id,
      task: call?.description ?? call?.prompt?.split("\n")[0] ?? head.title,
      name: call?.agentType,
      startedAt: head.startedAt,
    }
  })
}

/** Ticks once a second while `active`, so an elapsed time can be drawn live. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

/** What it is doing, in one line: the description its caller gave it (a
    Task's few words), or the first line of a longer brief. The runtime's own
    name for a worker is often a type or a slug (`general-purpose`, `fix`),
    which says what kind of worker it is, not what it was sent to do. */
const agentTitle = (agent: RunningAgent): string => agent.task.split("\n")[0].trim() || agent.name || "Agent"
/** The worker's kind, as a quiet label beside the title — when it adds
    something the title does not already say. */
const agentKind = (agent: RunningAgent): string | undefined =>
  agent.name && agent.name !== agentTitle(agent) ? agent.name : undefined

const formatElapsed = (ms: number): string =>
  ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`

/**
 * How many subagents are out working, beside the checklist and the context
 * ring — a count, and their names and elapsed times in a popover.
 *
 * A subagent's rail is somewhere up in the transcript, often scrolled past and
 * sometimes folded, so while workers are out the cluster says how many. Gone
 * the moment none are running: it is a live count, not a history, and the rail
 * is where the record lives.
 */
export function AgentsIndicator({ thread }: { thread: ThreadState }) {
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the two fields it reads
  const agents = useMemo(() => runningAgents(thread), [thread.items, thread.turnActive])
  const count = agents.length
  /* The clock ticks only while the popover is open AND workers are out: an
     elapsed time nobody is looking at is a re-render a second for nothing. */
  const [open, setOpen] = useState(false)
  const now = useNow(open && count > 0)
  if (count === 0) return null
  const label = `${count} ${count === 1 ? "agent" : "agents"} running`

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className={cn(READING_TRIGGER, "text-primary hover:text-primary")}
            title={`${label} — ${agents.map(agentTitle).join(", ")}`}
            aria-label={label}
          >
            {/* The mark rides inside the pill — one face, not a glyph beside a
                label. Where there is room the count is the words and the bubble
                is not; on a narrow panel the pill is gone, so the count rides
                the bare mark instead. One count, two dresses, never both — both
                from the shared reading parts, so this row is the same shape as
                the four beside it. */}
            <ReadingFace
              icon={<NetworkIcon className={READING_MARK} />}
              label={label}
              after={<ReadingBubble>{formatCount(count)}</ReadingBubble>}
            />
          </Button>
        }
      />
      <ReadingPopoverContent
        heading={label}
        headingClassName="harness-shimmer text-primary"
        action={<OpenInInspector tab="agents" label="Open agents panel" onOpen={() => setOpen(false)} />}
      >
        <ul className={cn("-mx-1 space-y-1 px-1", READING_LIST)}>
          {agents.map((agent) => (
            /* One line each: what the worker is doing (its description), its
               kind beside it, its clock. The whole brief is a hover away
               (`title`), and whole in the Agents panel. */
            <li key={agent.id} className="flex items-center gap-2 text-sm" title={agent.task}>
              <span className="grid size-5 shrink-0 place-items-center">
                <Spinner aria-hidden className="size-3.5 text-primary" />
              </span>
              <span className="flex min-w-0 flex-1 items-baseline gap-1.5 leading-5">
                {agentKind(agent) && (
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">{agentKind(agent)}</span>
                )}
                <span className="min-w-0 truncate text-foreground">{agentTitle(agent)}</span>
              </span>
              <span className="shrink-0 text-xs leading-5 tabular-nums text-muted-foreground">
                {formatElapsed(now - agent.startedAt)}
              </span>
            </li>
          ))}
        </ul>
      </ReadingPopoverContent>
    </Popover>
  )
}
