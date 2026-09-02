/* ── The queue, on the strip ──
   Messages typed while the agent was busy, waiting for the turn to end. They
   belong to the *turn* rather than to the message being typed, which is what
   the strip is for — and they are the user's own words, not the agent's
   state, so this is its own file rather than a third checklist in
   composer-status.

   Two bands, like the plan: a collapsed row that says how many are waiting
   and shows the one that goes next, with the two actions that apply to the
   whole queue ("send all now" interrupts the turn and sends everything
   combined; "clear" forgets it); and an expandable list, one row per message,
   each with its own send-now / steer / edit / remove. Editing is in place — a
   textarea swapped in for the text — because the words are still the user's
   until the turn ends, and a message you cannot fix before it goes is one you
   would rather not have queued.

   The list reads as a *queue* and not as a list of rows that happen to be
   numbered: the messages are the user's own words, so each sits in a bubble
   the same shade as a sent one, they are threaded onto a rail down the ordinal
   column (the order is the only thing a queue actually promises), and the
   first is marked "Next" — everything below it is waiting on that one. Each
   row also says when it was queued, which the shelf never used to show at all
   and which is the difference between "I typed that a moment ago" and a
   message parked on an archived thread since yesterday.

   Row actions are revealed on hover on a pointer device and always drawn on a
   phone, where there is no hover to reveal them with: four icon buttons per
   row, always lit, made the list read as a toolbar with some text in it.

   The list is the server's (`thread.queue`): every action here is a command,
   and the row redraws from the `queue` event that answers it. Nothing is
   removed optimistically, so a failed remove leaves the message where it is
   and the error where the thread's errors go. */
import * as React from "react"
import {
  ChevronDownIcon,
  CornerDownRightIcon,
  ListOrderedIcon,
  PaperclipIcon,
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
import { Timestamp } from "@/components/tool-parts"
import type { Actions } from "@/lib/actions"
import type { ThreadState } from "@/lib/store"
import { formatBytes } from "@/lib/attachments"
import { cn } from "@/lib/utils"
import { useStripSummary } from "./composer-strip"

/* Taller on a phone, where it is a thumb rather than a cursor. */
const ROW_BUTTON = "h-7 shrink-0 gap-1 rounded-md px-2 text-[11px] sm:h-6"
const ICON_BUTTON = "size-7 sm:size-6"

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

  /* A failed connection can act on nothing; an archived thread has no process
     to send through, but its queue is rows and stays editable — the server
     answers those three without an agent. */
  const closed = thread.phase.kind === "failed" || thread.phase.kind === "deleted"
  const canSend = !closed && !thread.archived
  const canEdit = !closed
  const running = thread.turnActive

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="w-full">
      {/* The header is a row that CONTAINS the trigger, not a trigger that
          contains the buttons. It used to be the latter — three buttons nested
          inside the disclosure button, each cancelling the click it was sitting
          in — which is invalid markup, is why `stop(e)` existed, and above all
          could not wrap: `shrink-0` actions and a `flex-1` summary on one line
          meant "Send all now" and "Clear" took ~150px of a 360px column and the
          message they were about truncated to nothing. Now the summary and the
          actions are siblings, so in a narrow panel the actions drop to their
          own line under a summary that has the whole width, and from
          `@panel-sm` up the row reads exactly as it did. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5">
        <CollapsibleTrigger
          render={
            <button
              type="button"
              className="-mx-1 flex min-w-0 flex-1 basis-full items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-accent/40 sm:py-0.5 @panel-sm:basis-0"
            />
          }
        >
          {/* size-6, the ring's width on the checklist rows, so the queue's icon
              sits on the same column as the plan's progress dial above it — and
              on the ordinal column of the rows below it, which is what makes
              the rail under it read as hanging off this row. Tinted rather than
              bare: the shelf stacks several of these bands and the disc is what
              tells them apart at a glance. */}
          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
            <ListOrderedIcon aria-hidden className="size-3.5" />
          </span>
          {/* One truncating line, so what gets cut is whatever is last — which
              is why the order matters more than it looks. "waiting for this
              turn to end" is ~180px of a 360px column, and with it in front the
              ellipsis always landed before the message, leaving a row whose
              only variable part said nothing. The clause is the least
              informative thing here (the shelf's own collapsed line already
              says "3 queued", and the composer already says whether a turn is
              running), so it is the part that goes in a narrow panel and the
              message keeps the room. */}
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            <span className="font-medium text-foreground">
              {count === 1 ? "1 message" : `${count} messages`}
            </span>
            <span className="hidden @panel-sm:inline">
              {" "}
              {running ? "waiting for this turn to end" : "waiting to be sent"}
            </span>
            {/* The message that goes first, named as such: the row is a preview
                of what happens next, not a sample of what is in the list. */}
            <span className="text-muted-foreground/60"> · next: {firstLine(items[0].text)}</span>
          </span>
          <span className="grid size-4 shrink-0 place-items-center">
            <ChevronDownIcon
              aria-hidden
              className={cn(
                "size-3.5 text-muted-foreground transition-transform duration-200",
                open && "rotate-180"
              )}
            />
          </span>
          <span className="sr-only">{open ? "Hide queued messages" : "Show queued messages"}</span>
        </CollapsibleTrigger>
        <span className="ms-auto flex shrink-0 items-center gap-1">
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
            onClick={() => void actions.queueSendNow(sessionId).catch(() => {})}
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
            onClick={() => void actions.queueClear(sessionId).catch(() => {})}
          >
            Clear
          </Button>
        </span>
      </div>
      <CollapsibleContent className="harness-collapse">
        <ul className="border-t border-border/40 px-2 py-1.5">
          {items.map((item, index) => (
            <QueueRow
              key={item.id}
              item={item}
              index={index}
              last={index === items.length - 1}
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
  last,
  sessionId,
  actions,
  canSend,
  canEdit,
  running,
}: {
  item: QueuedMessage
  index: number
  /** The rail is drawn *between* ordinals, so the last row does not carry one
      on down into the padding under the list. */
  last: boolean
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
    /* Wraps for the same reason the header does: the message and four icon
       buttons on one line left ~150px for the words in a narrow panel.
       `basis-full` gives the text the row to itself and drops the actions
       underneath it, right-aligned under the message they act on; from
       `@panel-sm` up `basis-0` puts them back on the line. */
    <li
      aria-busy={busy || undefined}
      className={cn(
        "group/queue relative flex flex-wrap items-start gap-x-2 gap-y-1 py-1 text-xs transition-opacity",
        busy && "opacity-60"
      )}
    >
      {/* The rail the ordinals are threaded onto, so the list reads as a line
          of messages waiting rather than as three separately numbered things.
          Anchored to the row and not to the ordinal column: the row is as tall
          as the message in it, and a line measured against the 24px column
          would be 4px of rail under a three-line bubble. `top-7`/`-bottom-1`
          are the gap under this ordinal and the gap over the next one. */}
      {!last && (
        <span
          aria-hidden
          className="absolute top-7 -bottom-1 left-3 w-px -translate-x-1/2 rounded-full bg-border/50"
        />
      )}
      {/* The position, in the icon column the header's disc sits in — the order
          is what a queue is. Only the one that goes next is tinted: everything
          below it is waiting on it. */}
      <span className="grid size-6 shrink-0 place-items-center">
        <span
          className={cn(
            "grid size-[1.125rem] place-items-center rounded-full text-[10px] font-semibold tabular-nums",
            index === 0 ? "bg-primary/10 text-primary" : "text-muted-foreground/70"
          )}
        >
          {index + 1}
        </span>
      </span>
      {editing ? (
        <div className="flex min-w-0 flex-1 basis-[calc(100%-2rem)] flex-col gap-1 @panel-sm:basis-0">
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
            {/* The two keys that already work, said once — an in-place editor
                with no visible contract is one people leave with Escape by
                accident and re-type the message. */}
            <span className="ms-1 hidden text-[10px] text-muted-foreground/60 @panel-sm:inline">
              Enter to save · Esc to cancel
            </span>
          </div>
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 basis-[calc(100%-2rem)] flex-col @panel-sm:basis-0">
          <button
            type="button"
            className={cn(
              /* The user's own words, in the surface a sent message uses, so a
                 queued message looks like the message it is about to become.
                 `wrap-anywhere`, not `break-words`: `overflow-wrap: break-word`
                 breaks a long token only after the line has already been laid
                 out at its full width, so it neither wraps a pasted URL nor
                 stops it counting as this row's minimum width. `anywhere` does
                 both — the token wraps, and the row can be as narrow as the
                 panel. */
              "min-w-0 rounded-lg border border-border/40 bg-muted/40 px-2 py-1 text-left leading-5 whitespace-pre-wrap wrap-anywhere text-foreground transition-colors hover:border-border/70 hover:bg-muted/60",
              !expanded && "line-clamp-3"
            )}
            title={expanded ? "Collapse" : "Show the whole message"}
            onClick={() => setExpanded((v) => !v)}
          >
            {item.text}
          </button>
          {/* What this message will carry when it drains. Shown while the words
              are still editable, and removable there, because `queue_update`
              carries the ids — a queued item's attachments are a thing you can
              take back, not a thing you can add to (the composer is where a
              message is composed). */}
          {item.attachments && item.attachments.length > 0 && (
            <QueuedAttachments
              attachments={item.attachments}
              removable={canEdit}
              onRemove={(id) =>
                run(
                  actions.queueUpdate(
                    sessionId,
                    item.id,
                    item.text,
                    (item.attachments ?? [])
                      .filter((ref) => ref.id !== id)
                      .map((ref) => ref.id)
                  )
                )
              }
            />
          )}
          {/* When it was queued, and — for the first row only — that it is the
              one the turn's end will send. */}
          <span className="mt-0.5 flex items-center gap-1.5 ps-0.5 text-[10px] text-muted-foreground/60">
            {index === 0 && (
              <span className="rounded bg-primary/10 px-1 font-medium text-primary">Next</span>
            )}
            <Timestamp at={item.createdAt} className="text-[10px]" />
          </span>
        </div>
      )}
      {!editing && (
        /* Revealed on hover, kept on a phone: four lit icon buttons per row
           made a list of the user's own sentences read as a toolbar. Focus
           counts as hover, or the row would be unusable from the keyboard. */
        <span className="ms-auto flex shrink-0 items-center gap-0.5 pt-0.5 transition-opacity sm:opacity-0 sm:group-hover/queue:opacity-100 sm:group-focus-within/queue:opacity-100">
          <Button
            variant="ghost"
            size="icon-xs"
            className={ICON_BUTTON + " text-primary hover:text-primary"}
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
              /* The one action in this row that was missing the touch size, so
                 on a phone it was a 24px target between three 28px ones — and
                 it only appears mid-turn, which is exactly when the row is
                 being used. */
              className={ICON_BUTTON}
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
            className={ICON_BUTTON}
            disabled={!canEdit || busy}
            title="Edit"
            onClick={() => setEditing(true)}
          >
            <PencilIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className={ICON_BUTTON + " text-muted-foreground hover:text-destructive"}
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

/** A queued message's attachments: names and sizes, with a ✕ while the queue is
    editable. Not thumbnails — the queue is a list of what is waiting, read at
    the width of a shelf, and a row of pictures there would be the loudest thing
    on a surface whose job is to be glanceable. */
function QueuedAttachments({
  attachments,
  removable,
  onRemove,
}: {
  attachments: NonNullable<QueuedMessage["attachments"]>
  removable: boolean
  onRemove: (id: string) => void
}) {
  return (
    <ul className="mt-1 flex flex-wrap gap-1 ps-0.5">
      {attachments.map((ref) => (
        <li
          key={ref.id}
          className="flex items-center gap-1 rounded-pill border border-border/40 bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground"
        >
          <PaperclipIcon className="size-2.5 shrink-0" />
          <span className="max-w-32 truncate">{ref.name}</span>
          <span className="shrink-0 text-muted-foreground/60">{formatBytes(ref.size)}</span>
          {removable && (
            <button
              type="button"
              aria-label={`Remove ${ref.name}`}
              className="-me-0.5 rounded-full p-0.5 hover:text-foreground"
              onClick={() => onRemove(ref.id)}
            >
              <XIcon className="size-2.5" />
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}
