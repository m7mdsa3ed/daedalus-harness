/* ── The subagents out working ──
   The count in the footer's cluster, and `runningAgents` — the one reading of
   "who is still out", shared with the working line. */
import { useEffect, useMemo, useState } from "react"
import { BotIcon, LoaderCircleIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  READING_MARK,
  READING_TRIGGER,
  ReadingBubble,
  ReadingFace,
} from "@/components/composer/indicator"
import { extractSubagent } from "@/lib/tools"
import { activeSubagents, buildRows } from "@/lib/transcript-rows"
import { type ThreadState } from "@/lib/store"
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
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

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
            title={`${label} — ${agents.map((agent) => agent.name ?? agent.task).join(", ")}`}
            aria-label={label}
          >
            {/* The mark rides inside the pill — one face, not a glyph beside a
                label. Where there is room the count is the words and the bubble
                is not; on a narrow panel the pill is gone, so the count rides
                the bare mark instead. One count, two dresses, never both — both
                from the shared reading parts, so this row is the same shape as
                the four beside it. */}
            <ReadingFace
              icon={<BotIcon className={READING_MARK} />}
              label={label}
              after={<ReadingBubble>{count > 9 ? "9+" : count}</ReadingBubble>}
            />
          </Button>
        }
      />
      <PopoverContent align="end" side="top" className="w-72 gap-2">
        <p className="harness-shimmer font-medium text-primary">{label}</p>
        <ul className="-mx-1 max-h-[min(50svh,20rem)] space-y-0.5 overflow-y-auto overscroll-contain px-1">
          {agents.map((agent) => (
            <li key={agent.id} className="flex items-start gap-2 text-xs">
              <span className="grid size-5 shrink-0 place-items-center">
                <LoaderCircleIcon aria-hidden className="size-3.5 animate-spin text-primary" />
              </span>
              <span className="min-w-0 flex-1 leading-5 break-words text-foreground">
                {agent.name && <span className="font-mono text-muted-foreground">{agent.name} </span>}
                {agent.task}
              </span>
              <span className="shrink-0 text-[11px] leading-5 tabular-nums text-muted-foreground/60">
                {formatElapsed(now - agent.startedAt)}
              </span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
