/* ── How far the agent's checklist has got ──
   The reading, and the one place that decides which of the thread's items IS
   the checklist — a `todos` tool call, or failing that the thread's own ACP
   plan. */
import { useMemo } from "react"
import { CheckCircle2Icon, CircleDashedIcon, LoaderCircleIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  READING_MARK,
  READING_TRIGGER,
  ReadingBadge,
  ReadingBubble,
  Ring,
} from "@/components/composer/indicator"
import { extractTodos, toolViewOf } from "@/lib/tools"
import { type PlanItem, type ThreadState, type ToolItem } from "@/lib/store"
import { cn } from "@/lib/utils"

/** One checklist row, in the shape both a plan entry and a todo entry reduce
    to. The two surfaces read from different channels but draw the same row. */
interface ChecklistRowData {
  content: string
  status: "completed" | "in_progress" | "pending"
}

/**
 * The agent's checklist, when it arrives through a tool call instead of ACP's
 * `plan` channel. Claude Code's `TodoWrite` and OpenCode's `todowrite` both
 * send the list as tool *input* and return nothing worth reading, and neither
 * maps to ACP's `plan` channel — so without this the most-repeated call in a
 * long thread has no surface at all. A real ACP plan is NOT read here: it
 * arrives as its own session update, at its own point in the conversation, so
 * the transcript draws it in place (`PlanStep`). This one has no such point —
 * it is the input of a call the agent makes over and over, and a row per
 * revision is what one collapsed reading exists to avoid.
 *
 * `toolViewOf` is the single place that says "this call IS a todo list"; the
 * newest such call wins, so an agent revising its list mid-turn replaces the
 * reading rather than stacking one per revision.
 */
function threadTodos(thread: ThreadState): ChecklistRowData[] | null {
  const todoItem = [...thread.items]
    .reverse()
    // Not a subagent's: a child's checklist is its own, drawn in its rail, and
    // letting it win here handed the reading to whichever worker wrote last.
    .find((item): item is ToolItem => item.kind === "tool" && !item.parentId && toolViewOf(item) === "todos")
  /* Claude Code's ACP adapter now sends TodoWrite as an ACP `plan` update
     rather than a tool call with input, so with no such call the thread's own
     plan (never a subagent's) is the checklist. */
  const planItem = todoItem
    ? null
    : [...thread.items]
        .reverse()
        .find((item): item is PlanItem => item.kind === "plan" && !item.parentId && item.entries.length > 0)
  const todos = todoItem ? extractTodos(todoItem) : planItem ? planItem.entries : null
  return todos && todos.length > 0 ? todos : null
}

/**
 * How far the agent's checklist has got, beside the context ring.
 *
 * A trigger and a popover, not a row: the checklist is the same *kind* of
 * answer as the context reading — one number that is true of the thread right
 * now, wanted at a glance and read in full only when something looks wrong —
 * so it is drawn the same way and stands in the same cluster. It has been a
 * card on the composer's shelf (folded behind a 14px sliver) and a card at the
 * foot of the transcript (a screenful of scrolling from view); both were the
 * whole list, permanently, for a question that is usually "how far along".
 *
 * The ring is the progress and the popover is the steps. The list inside it
 * scrolls — a popover is a fixed surface with a viewport of its own, which is
 * the thing the shelf could not offer without taking the room from the
 * transcript.
 */
export function TodoIndicator({ thread }: { thread: ThreadState }) {
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the one field it reads
  const todos = useMemo(() => threadTodos(thread), [thread.items])
  if (!todos) return null

  const total = todos.length
  const completed = todos.filter((todo) => todo.status === "completed").length
  const current =
    todos.find((todo) => todo.status === "in_progress") ??
    todos.find((todo) => todo.status !== "completed")
  const percent = Math.round((completed / total) * 100)

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className={cn(READING_TRIGGER, "text-primary hover:text-primary")}
            title={`Checklist — ${completed} of ${total} done${current ? ` · ${current.content}` : ""}`}
            aria-label="Checklist"
          >
            <Ring percent={percent} className={READING_MARK} />
            {/* The count rides the mark on a narrow panel and becomes the
                badge's `2/5` where there is room — the same bargain the other
                four readings strike, so the cluster is one row. */}
            <ReadingBubble>{completed}</ReadingBubble>
            <ReadingBadge>
              {completed}/{total}
            </ReadingBadge>
          </Button>
        }
      />
      <PopoverContent align="end" side="top" className="w-72 gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <p className="font-medium">Checklist</p>
          <span className="text-xs tabular-nums text-muted-foreground">
            {completed}/{total}
          </span>
        </div>
        {/* Its own scroll, capped against the panel: a forty-step list is
            longer than a phone. The popover is a fixed surface, so this costs
            the transcript nothing — which is the whole reason the list moved
            here. */}
        <ul className="-mx-1 max-h-[min(50svh,20rem)] space-y-0.5 overflow-y-auto overscroll-contain px-1">
          {todos.map((row, index) => (
            <li key={`${row.content}-${index}`} className="flex items-start gap-2 text-xs">
              <span className="grid size-5 shrink-0 place-items-center">
                {row.status === "completed" ? (
                  <CheckCircle2Icon aria-hidden className="size-3.5 text-primary" />
                ) : row.status === "in_progress" ? (
                  <LoaderCircleIcon aria-hidden className="size-3.5 animate-spin text-primary" />
                ) : (
                  <CircleDashedIcon aria-hidden className="size-3.5 text-muted-foreground/60" />
                )}
              </span>
              {/* break-words, not truncate: the popover is opened to read the
                  list in full, and a step is often a path or a command whose
                  one long token would otherwise read as missing. */}
              <span
                className={cn(
                  "min-w-0 flex-1 leading-5 break-words",
                  row.status === "completed"
                    ? "text-muted-foreground line-through opacity-70"
                    : row.status === "in_progress"
                      ? "text-foreground"
                      : "text-muted-foreground"
                )}
              >
                {row.content}
              </span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
