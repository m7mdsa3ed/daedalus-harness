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

   ── The dash gets stronger the closer it is to going ──
   Three weights of the one border, so the stack has a reading order without a
   number beside each row: a message further down the queue is faint, the
   **next** one is halfway, and a **steer** — already on the wire — is nearly
   solid and has dropped the `opacity-90` the others wear. The state pill is
   the same shape for both states, and the steer's dot pulses, because that
   one is a thing happening rather than a thing waiting.

   ── The caption is a caption, and it is almost nothing ──
   State was a filled pill, the actions rode a bordered, blurred, shadowed
   group, and the rule above the stack carried two more buttons: a queue of
   three messages drew a pill, a time, four buttons and a container per row,
   plus a header bar. That is a panel of controls standing where the
   conversation continues.

   So the chrome is gone and the *signals* stayed. State is the bubble's own
   border — three weights, which already said which one goes next — plus one
   pulsing dot beside the time for a steer, which is the only state a border
   weight cannot say (happening, not waiting). The actions are bare ghost
   buttons on the caption line with no group around them, revealed on hover
   under a cursor and simply always there where there is no hover to reveal
   them with — the **pointer's** question, not the width's. A caption is now
   what it claims to be: time, and what you can do about it.

   ── Nothing acts on the whole queue ──
   "Send all" and "Clear" were a second copy of two buttons every row already
   has, one line up and louder, and they were the reason the rule needed to be
   a bar. The rule is a rule again: a hairline and a count.

   ── And on a phone the actions get their own line ──
   A pill, a time and four 32px touch targets are a phone's whole width, so
   below `@panel-sm:` — the **panel's** width, not the window's — the caption
   stacks: state and time keep the line under the bubble where a sent
   message's timestamp sits, and the actions drop to a line of their own
   beneath it, still full size and still hittable. `order` moves the group, so
   the same markup is one line on a wide panel and two on a narrow one.

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
import { UserMessageText } from "@/components/thread-items/user-message"
import { useCoarsePointer } from "@/hooks/use-device"
import type { Actions } from "@/lib/actions"
import type { ThreadState } from "@/lib/store"
import { formatBytes } from "@/lib/attachments"
import { cn } from "@/lib/utils"

/* No container, no border, no ground: the buttons are the group. What used to
   hold them together was a bordered, blurred pill, which is a control standing
   in the transcript — the spacing does the same job for nothing. */
const ACTION_GROUP = "flex max-w-full shrink-0 flex-wrap items-center justify-end gap-0.5"

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
  /* A held steer is listed but already sent, so it is not the one the turn's
     end will send: "Next" is the first row that is not a steer. */
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
      {/* A rule and a count, and nothing else. It used to carry "Send all" and
          "Clear", which were the same two things every row's own caption says
          one line below — and carrying them is what turned a rule into a header
          bar over a panel of queued items. What follows is the conversation
          continuing; this only says how much of it has not gone yet.

          The label sits near the start and the growing half of the rule after
          it, so a narrow panel gets a shorter rule rather than a stub. */}
      <div className="flex items-center gap-2.5 py-2 text-[11px] text-muted-foreground/70">
        <span aria-hidden className="h-px w-4 shrink-0 bg-border" />
        <span className="min-w-0 truncate">
          {count === 1 ? "1 message" : `${count} messages`}{" "}
          {running ? "waiting for this turn" : "waiting to be sent"}
        </span>
        <span aria-hidden className="h-px min-w-2 flex-1 bg-border" />
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
  const coarse = useCoarsePointer()

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
        /* Tighter than a sent message's `py-2`: consecutive queued rows are one
           block of things about to happen, not four unrelated messages. */
        "group/queued flex-col items-end gap-1 py-1 transition-opacity",
        busy && "opacity-50"
      )}
    >
      <MessageContent>
        {/* The sent message's own bubble, dashed: same tint, same corner tail,
            same 80% cap, so what changes when it goes is one border and not
            the shape of the thing you wrote. The dash's *weight* is how far
            down the queue it is — see the note at the top of the file. */}
        <Bubble variant="tinted" align="end" className={cn(!item.steer && "opacity-90")}>
          <BubbleContent
            dir="auto"
            className={cn(
              "rounded-2xl rounded-br-sm border border-dashed px-4 py-2.5 text-sm",
              item.steer
                ? "border-primary/70 dark:border-primary/60"
                : next
                  ? "border-primary/45 dark:border-primary/35"
                  : "border-primary/25 dark:border-primary/20"
            )}
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
          edge a timestamp uses, so the row reads as one object.

          Wide: one line, actions first. Narrow (`@panel-sm:`, the panel's own
          width and not the window's): two, the state and time keeping the
          line a sent message's timestamp sits on and the actions dropping
          beneath it — a pill, a time and four 32px touch targets are a phone's
          whole width, and a row that reflows by itself keeps its buttons
          hittable instead of letting them run off the edge. The cluster is
          `order-1` below the breakpoint and `order-2` above it, so the line
          the reader scans first is the one saying what the message is doing.

          The actions are revealed on hover under a cursor and always drawn
          where there is no hover to reveal them with — the *pointer's*
          question, not the panel width's. Focus counts as hover, or the row
          would be unusable from the keyboard. */}
      <div className="flex flex-col items-end gap-1 pe-1 text-[10px] text-muted-foreground/60 @panel-sm:flex-row @panel-sm:items-center @panel-sm:gap-1.5">
        {!item.steer && (
          <span
            className={cn(
              ACTION_GROUP,
              "order-2 @panel-sm:order-1",
              "transition-opacity",
              !coarse &&
                "opacity-0 group-hover/queued:opacity-100 group-focus-within/queued:opacity-100"
            )}
          >
            <Button
              variant="ghost"
              size={coarse ? "icon-sm" : "icon-xs"}
              className="rounded-pill text-primary hover:text-primary"
              disabled={!canSend || busy}
              title={running ? "Stop the running turn and send this now" : "Send this now"}
              onClick={() => run(actions.queueSendNow(sessionId, item.id))}
            >
              <SendHorizontalIcon />
            </Button>
            {running && (
              <Button
                variant="ghost"
                size={coarse ? "icon-sm" : "icon-xs"}
                className="rounded-pill"
                disabled={!canSend || busy}
                title="Steer: send this into the running turn without stopping it"
                onClick={() => run(actions.queueSteer(sessionId, item.id))}
              >
                <CornerDownRightIcon />
              </Button>
            )}
            <Button
              variant="ghost"
              size={coarse ? "icon-sm" : "icon-xs"}
              className="rounded-pill"
              disabled={!canEdit || busy}
              title="Take it back to the composer — this removes it from the queue"
              onClick={edit}
            >
              <PencilIcon />
            </Button>
            <Button
              variant="ghost"
              size={coarse ? "icon-sm" : "icon-xs"}
              className="rounded-pill text-muted-foreground hover:text-destructive"
              disabled={!canEdit || busy}
              title="Remove"
              onClick={() => run(actions.queueRemove(sessionId, item.id))}
            >
              <XIcon />
            </Button>
          </span>
        )}
        {/* Time, and for a steer one pulsing dot in front of it.
            "Next" was a filled pill saying what the bubble's middle border
            weight already says, and "Steering" was the same pill saying what
            the near-solid one does — so the words went and the weights stayed.
            The dot is what no border weight can say: this one is *happening*,
            already on the wire, joining the running turn at its next step
            boundary, which is also why the row has no actions. It keeps a
            title, because a bare dot is not a label. */}
        <span className="order-1 flex items-center gap-1.5 @panel-sm:order-2">
          {item.steer && (
            <span
              title="Steering — already sent into the running turn"
              className="flex items-center"
            >
              <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-primary" />
              <span className="sr-only">Steering</span>
            </span>
          )}
          <Timestamp at={item.createdAt} className="text-[10px]" />
        </span>
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
