/* ── The queue, as the messages it is ──
   Messages typed while the agent was busy, waiting for the turn to end.

   They are drawn as **user messages**, because that is what they are: the same
   tinted bubble, hugging the same right edge, at the same width, in the same
   column — sitting at the end of the transcript where they will land. What
   changes when one is sent is that it stops being dashed, not that it moves.
   Every other shape this has worn — a collapsed row on the composer's shelf, a
   numbered list with a rail behind a chevron — was a *list of messages*, which
   is a thing you read; a queue is a thing you are about to say.

   ── Different, because it has not gone ──
   The bubble is dashed and a shade back (`opacity-90`). The caption under it
   carries the state — "Next" for the one the turn's end will send, "Steering"
   for one already on the wire — and the time it was queued, which is the
   difference between "I typed that a moment ago" and a message parked on an
   archived thread since yesterday.

   ── Editing takes it back ──
   There is no in-place editor. "Edit" removes the message from the queue and
   puts its words back in the composer, which is where a message is composed:
   one box with the "+" menu, the model picker, the history and every send it
   knows. An editor in the transcript was a second, worse composer that could
   not attach a file or run a command, and a message you can only half-fix is
   one you would rather re-type. Cancelling is therefore the same gesture —
   pull it back and delete the box.

   The list is the server's (`thread.queue`): every action here is a command,
   and the rows redraw from the `queue` event that answers it. Nothing is
   removed optimistically, so a failed remove leaves the message where it is
   and the error where the thread's errors go. */
import * as React from "react"
import {
  CornerDownRightIcon,
  PaperclipIcon,
  PencilIcon,
  SendHorizontalIcon,
  XIcon,
} from "lucide-react"
import type { QueuedMessage } from "@daedalus/protocol"

import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Button } from "@/components/ui/button"
import { Message, MessageContent } from "@/components/ui/message"
import { Timestamp } from "@/components/tool-parts"
import { UserMessageText } from "@/components/thread-items"
import type { Actions } from "@/lib/actions"
import type { ThreadState } from "@/lib/store"
import { formatBytes } from "@/lib/attachments"
import { cn } from "@/lib/utils"

/* Taller on a phone, where it is a thumb rather than a cursor. */
const ROW_BUTTON = "h-7 shrink-0 gap-1 rounded-md px-2 text-[11px] sm:h-6"
const ICON_BUTTON = "size-7 sm:size-6"

export function ComposerQueue({
  sessionId,
  thread,
  actions,
  onEdit,
}: {
  sessionId: string
  thread: ThreadState
  actions: Actions
  /** Put these words back in the composer. The row has already been removed
      from the queue by the time this is called — see the note above. */
  onEdit: (text: string) => void
}) {
  const items = thread.queue
  const count = items.length
  /* A held steer is listed but already sent: "send all" and "clear" have
     nothing to do with it, so they act — and light up — on the rest. */
  const editable = items.filter((item) => !item.steer)
  if (count === 0) return null

  /* A failed connection can act on nothing; an archived thread has no process
     to send through, but its queue is rows and stays editable — the server
     answers those three without an agent. */
  const closed = thread.phase.kind === "failed" || thread.phase.kind === "deleted"
  const canSend = !closed && !thread.archived
  const canEdit = !closed
  const running = thread.turnActive

  return (
    <div className="pt-1">
      {/* A rule, the same one a notice wears, rather than a header bar: what
          follows is the conversation continuing, not a panel of queued items,
          and the two actions that apply to the whole queue ride the rule
          because there is nowhere else they belong. */}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 py-2 text-[11px] text-muted-foreground/70">
        <span aria-hidden className="h-px min-w-4 flex-1 bg-border" />
        <span className="shrink-0">
          {count === 1 ? "1 message" : `${count} messages`}{" "}
          {running ? "waiting for this turn" : "waiting to be sent"}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="xs"
            className={cn(ROW_BUTTON, "text-primary hover:text-primary")}
            disabled={!canSend || editable.length === 0}
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
            disabled={!canEdit || editable.length === 0}
            title="Forget every queued message"
            onClick={() => void actions.queueClear(sessionId).catch(() => {})}
          >
            Clear
          </Button>
        </span>
      </div>
      {items.map((item) => (
        <QueuedMessageRow
          key={item.id}
          item={item}
          next={item.id === editable[0]?.id}
          sessionId={sessionId}
          actions={actions}
          onEdit={onEdit}
          canSend={canSend && !item.steer}
          canEdit={canEdit && !item.steer}
          running={running}
        />
      ))}
    </div>
  )
}

function QueuedMessageRow({
  item,
  next,
  sessionId,
  actions,
  onEdit,
  canSend,
  canEdit,
  running,
}: {
  item: QueuedMessage
  /** The first row the turn's end will send — the first that is not a steer. */
  next: boolean
  sessionId: string
  actions: Actions
  onEdit: (text: string) => void
  canSend: boolean
  canEdit: boolean
  running: boolean
}) {
  const [busy, setBusy] = React.useState(false)

  const run = (op: Promise<unknown>) => {
    setBusy(true)
    void op.catch(() => {}).finally(() => setBusy(false))
  }
  /* Removed first, filled second, and the fill only on success: a message that
     is in the box *and* still in the queue is one that gets said twice. */
  const edit = () => {
    setBusy(true)
    void actions
      .queueRemove(sessionId, item.id)
      .then(() => onEdit(item.text))
      .catch(() => {})
      .finally(() => setBusy(false))
  }

  return (
    <Message
      align="end"
      aria-busy={busy || undefined}
      className={cn(
        "group/queued flex-col items-end gap-0.5 py-2 transition-opacity",
        busy && "opacity-50"
      )}
    >
      <MessageContent>
        {/* The sent message's own bubble, dashed: same tint, same corner tail,
            same 80% cap, so what changes when it goes is one border and not
            the shape of the thing you wrote. */}
        <Bubble variant="tinted" align="end" className="opacity-90">
          <BubbleContent
            dir="auto"
            className="rounded-2xl rounded-br-sm border border-dashed border-primary/40 px-4 py-2.5 text-sm dark:border-primary/30"
          >
            {item.attachments && item.attachments.length > 0 && (
              <QueuedAttachments
                attachments={item.attachments}
                removable={canEdit && !busy}
                onRemove={(id) =>
                  run(
                    actions.queueUpdate(
                      sessionId,
                      item.id,
                      item.text,
                      (item.attachments ?? []).filter((ref) => ref.id !== id).map((ref) => ref.id)
                    )
                  )
                }
              />
            )}
            <UserMessageText text={item.text} />
          </BubbleContent>
        </Bubble>
      </MessageContent>
      {/* State, time, and the actions — under the bubble on the same right
          edge a timestamp uses, so the row reads as one object. The actions
          are revealed on hover on a pointer and always drawn on a phone, where
          there is no hover to reveal them with. Focus counts as hover, or the
          row would be unusable from the keyboard. */}
      <div className="flex items-center gap-1.5 pe-1 text-[10px] text-muted-foreground/60">
        {!item.steer && (
          <span className="flex items-center gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-hover/queued:opacity-100 sm:group-focus-within/queued:opacity-100">
            <Button
              variant="ghost"
              size="icon-xs"
              className={cn(ICON_BUTTON, "text-primary hover:text-primary")}
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
              title="Take it back to the composer — this removes it from the queue"
              onClick={edit}
            >
              <PencilIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className={cn(ICON_BUTTON, "text-muted-foreground hover:text-destructive")}
              disabled={!canEdit || busy}
              title="Remove"
              onClick={() => run(actions.queueRemove(sessionId, item.id))}
            >
              <XIcon />
            </Button>
          </span>
        )}
        {item.steer ? (
          /* Already on the wire, joining the running turn at its next step
             boundary — which is where its bubble will land. Until then this
             row is the only place the words are, which is also why it has no
             actions: there is nothing left to take back. */
          <span className="flex items-center gap-0.5 rounded bg-primary/10 px-1 font-medium text-primary">
            <CornerDownRightIcon aria-hidden className="size-2.5" />
            Steering
          </span>
        ) : (
          next && <span className="rounded bg-primary/10 px-1 font-medium text-primary">Next</span>
        )}
        <Timestamp at={item.createdAt} className="text-[10px]" />
      </div>
    </Message>
  )
}

/** A queued message's attachments, inside the bubble the way a sent message's
    are — with a ✕ while the queue is editable, because `queue_update` carries
    the ids and a queued item's attachments are a thing you can take back. Not
    thumbnails: what is being read here is whether the right file is coming. */
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
    <ul className="mb-1.5 flex flex-wrap gap-1">
      {attachments.map((ref) => (
        <li
          key={ref.id}
          className="flex items-center gap-1 rounded-pill border border-border/40 bg-background/40 px-1.5 py-0.5 text-[10px] text-muted-foreground"
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
