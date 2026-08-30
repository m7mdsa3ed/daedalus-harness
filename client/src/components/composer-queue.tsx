/* ── The queue, on the strip ──
   Messages typed while the agent was busy, waiting for the turn to end. They
   belong to the *turn* rather than to the message being typed, which is what
   the strip is for — and they are the user's own words, not the agent's
   state, so this is its own file rather than a third checklist in
   composer-status.

   Two bands, like the plan: a collapsed row that says how many are waiting
   and shows the first, with the two actions that apply to the whole queue
   ("send all now" interrupts the turn and sends everything combined; "clear"
   forgets it); and an expandable list, one row per message, each with its
   own send-now / steer / edit / remove. Editing is in place — a textarea
   swapped in for the text — because the words are still the user's until
   the turn ends, and a message you cannot fix before it goes is one you
   would rather not have queued.

   The list is the server's (`thread.queue`): every action here is a command,
   and the row redraws from the `queue` event that answers it. Nothing is
   removed optimistically, so a failed remove leaves the message where it is
   and the error where the thread's errors go. */
import * as React from "react"
import {
  ChevronDownIcon,
  CornerDownRightIcon,
  ListOrderedIcon,
  PencilIcon,
  SendHorizontalIcon,
  XIcon,
} from "lucide-react"
import type { QueuedMessage } from "@daedalus/protocol"

import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Textarea } from "@/components/ui/textarea"
import type { Actions } from "@/lib/actions"
import type { ThreadState } from "@/lib/store"
import { cn } from "@/lib/utils"
import { useStripSummary } from "./composer-strip"

const ROW_BUTTON = "h-6 shrink-0 gap-1 rounded-md px-2 text-[11px]"

export function ComposerQueue({
  sessionId,
  thread,
  actions,
}: {
  sessionId: string
  thread: ThreadState
  actions: Actions
}) {
  const [open, setOpen] = React.useState(false)
  const items = thread.queue
  const count = items.length
  useStripSummary(
    count > 0
      ? { id: "queue", icon: ListOrderedIcon, label: count === 1 ? "1 queued" : `${count} queued` }
      : null
  )
  if (count === 0) return null

  /* A closed socket can act on nothing; an archived thread has no process to
     send through, but its queue is rows and stays editable — the server
     answers those three without an agent. */
  const closed = thread.status === "closed"
  const canSend = !closed && !thread.archived
  const canEdit = !closed
  const running = thread.turnActive
  const stop = (e: React.MouseEvent) => {
    // The buttons sit inside the collapsible's trigger row.
    e.stopPropagation()
    e.preventDefault()
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="w-full">
      <CollapsibleTrigger
        render={
          <button
            type="button"
            className="flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors hover:bg-accent/40"
          />
        }
      >
        {/* size-6, the ring's width on the checklist rows, so the queue's icon
            sits on the same column as the plan's progress dial above it. */}
        <span className="grid size-6 shrink-0 place-items-center text-primary">
          <ListOrderedIcon aria-hidden className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          <span className="text-foreground">
            {count === 1 ? "1 message" : `${count} messages`}
          </span>{" "}
          {running ? "waiting for this turn to end" : "waiting to be sent"}
          {count > 0 && (
            <span className="text-muted-foreground/60"> · {firstLine(items[0].text)}</span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="xs"
            className={cn(ROW_BUTTON, "text-primary hover:text-primary")}
            disabled={!canSend}
            title={
              running
                ? "Stop the running turn and send everything queued as one message"
                : "Send everything queued as one message"
            }
            onClick={(e) => {
              stop(e)
              void actions.queueSendNow(sessionId).catch(() => {})
            }}
          >
            <SendHorizontalIcon />
            {running ? "Send all now" : "Send all"}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            className={cn(ROW_BUTTON, "text-muted-foreground")}
            disabled={!canEdit}
            title="Forget every queued message"
            onClick={(e) => {
              stop(e)
              void actions.queueClear(sessionId).catch(() => {})
            }}
          >
            Clear
          </Button>
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
        <span className="sr-only">{open ? "Hide queued messages" : "Show queued messages"}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="harness-collapse">
        <ul className="space-y-0.5 border-t border-border/40 px-2 py-1.5">
          {items.map((item, index) => (
            <QueueRow
              key={item.id}
              item={item}
              index={index}
              sessionId={sessionId}
              actions={actions}
              canSend={canSend}
              canEdit={canEdit}
              running={running}
            />
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? ""
  return line.length > 80 ? `${line.slice(0, 80)}…` : line
}

function QueueRow({
  item,
  index,
  sessionId,
  actions,
  canSend,
  canEdit,
  running,
}: {
  item: QueuedMessage
  index: number
  sessionId: string
  actions: Actions
  canSend: boolean
  canEdit: boolean
  running: boolean
}) {
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState(item.text)
  const [expanded, setExpanded] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  // Another device may edit the same row; its words win over a stale draft.
  React.useEffect(() => {
    if (!editing) setDraft(item.text)
  }, [item.text, editing])

  const run = (op: Promise<unknown>) => {
    setBusy(true)
    void op.catch(() => {}).finally(() => setBusy(false))
  }
  const save = () => {
    const value = draft.trim()
    setEditing(false)
    if (!value || value === item.text) return
    run(actions.queueUpdate(sessionId, item.id, value))
  }
  const cancel = () => {
    setDraft(item.text)
    setEditing(false)
  }

  return (
    <li className="flex items-start gap-2 text-xs">
      {/* The position, in the ring's column — the order is what a queue is. */}
      <span className="grid size-6 shrink-0 place-items-center text-[10px] font-semibold tabular-nums text-muted-foreground/70">
        {index + 1}
      </span>
      {editing ? (
        <div className="flex min-w-0 flex-1 flex-col gap-1 py-0.5">
          <Textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault()
                cancel()
              } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                save()
              }
            }}
            rows={2}
            className="min-h-9 rounded-lg px-2 py-1.5 text-xs md:text-xs"
          />
          <div className="flex items-center gap-1">
            <Button size="xs" className={ROW_BUTTON} onClick={save} disabled={!draft.trim()}>
              Save
            </Button>
            <Button size="xs" variant="ghost" className={ROW_BUTTON} onClick={cancel}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className={cn(
            "min-w-0 flex-1 py-0.5 text-left leading-6 whitespace-pre-wrap break-words text-foreground",
            !expanded && "line-clamp-3"
          )}
          title={expanded ? "Collapse" : "Show the whole message"}
          onClick={() => setExpanded((v) => !v)}
        >
          {item.text}
        </button>
      )}
      {!editing && (
        <span className="flex shrink-0 items-center gap-0.5 pt-0.5">
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-primary hover:text-primary"
            disabled={!canSend || busy}
            title={running ? "Stop the running turn and send this now" : "Send this now"}
            onClick={() => run(actions.queueSendNow(sessionId, item.id))}
          >
            <SendHorizontalIcon />
          </Button>
          {running && (
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={!canSend || busy}
              title="Steer: send this into the running turn without stopping it"
              onClick={() => run(actions.queueSteer(sessionId, item.id))}
            >
              <CornerDownRightIcon />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={!canEdit || busy}
            title="Edit"
            onClick={() => setEditing(true)}
          >
            <PencilIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground hover:text-destructive"
            disabled={!canEdit || busy}
            title="Remove"
            onClick={() => run(actions.queueRemove(sessionId, item.id))}
          >
            <XIcon />
          </Button>
        </span>
      )}
    </li>
  )
}
