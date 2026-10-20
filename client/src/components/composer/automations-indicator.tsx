/* ── The automations pinned to this thread ──
   A reading in the footer's cluster, beside the checklist and the subagents:
   how many automations deliver into this thread, and when each fires next, in
   a popover with a way to manage them. Draws nothing at zero — a thread with no
   automation has nothing to say, and "Add" lives in the composer (`/automate`)
   and on the automations page, not in a footer that is read, not clicked. */
import * as React from "react"
import { RepeatIcon } from "lucide-react"
import { useNavigate } from "react-router"

import { nextFireOf, triggersLine, untilLabel } from "@/components/automations/trigger-summary"
import { formatCount } from "@/components/composer-strip"
import {
  READING_LIST,
  READING_MARK,
  READING_TRIGGER,
  ReadingBubble,
  ReadingFace,
  ReadingPopoverContent,
} from "@/components/composer/indicator"
import { Button } from "@/components/ui/button"
import { Popover, PopoverTrigger } from "@/components/ui/popover"
import { useAutomationReads, useAutomations } from "@/lib/queries/automations"
import { automationPath, automationsPath, newAutomationPath } from "@/lib/router"
import { cn } from "@/lib/utils"

export function AutomationsIndicator({ sessionId }: { sessionId: string }) {
  const all = useAutomations().data
  const mine = React.useMemo(
    () => (all ?? []).filter((a) => a.runsIn === "session" && a.sessionId === sessionId),
    [all, sessionId]
  )
  const { triggers } = useAutomationReads(mine)
  const navigate = useNavigate()
  const [open, setOpen] = React.useState(false)
  if (mine.length === 0) return null
  const active = mine.filter((a) => a.enabled).length
  const label = `${mine.length} ${mine.length === 1 ? "automation" : "automations"}`
  const go = (path: string) => {
    setOpen(false)
    void navigate(path)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className={cn(READING_TRIGGER, active === 0 && "text-muted-foreground")}
            title={`${label} pinned to this thread${active < mine.length ? ` (${mine.length - active} paused)` : ""}`}
            aria-label={label}
          >
            <ReadingFace
              icon={<RepeatIcon className={READING_MARK} />}
              label={label}
              after={<ReadingBubble>{formatCount(mine.length)}</ReadingBubble>}
            />
          </Button>
        }
      />
      <ReadingPopoverContent
        heading="Automations in this thread"
        action={
          <div className="flex items-center justify-between gap-2">
            <Button variant="ghost" size="xs" onClick={() => go(newAutomationPath(sessionId))}>
              Add
            </Button>
            <Button variant="outline" size="xs" onClick={() => go(automationsPath())}>
              Manage
            </Button>
          </div>
        }
      >
        <ul className={cn("-mx-1 space-y-0.5 px-1", READING_LIST)}>
          {mine.map((a) => {
            const next = a.enabled ? nextFireOf(triggers[a.id]) : null
            return (
              <li key={a.id}>
                <button
                  type="button"
                  className="block w-full rounded-lg px-2 py-1.5 text-left text-sm outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  onClick={() => go(automationPath(a.id))}
                >
                  <span className={cn("block truncate text-foreground", !a.enabled && "text-muted-foreground")}>{a.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {!a.enabled ? "Paused" : next !== null ? `Next ${untilLabel(next)}` : triggersLine(triggers[a.id]) || "…"}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </ReadingPopoverContent>
    </Popover>
  )
}
