/* Messages wait here until the active turn finishes. A composer steer is
   already on the wire and is shown only until its transcript bubble lands. */
import * as React from "react"
import {
  CornerDownRightIcon,
  PaperclipIcon,
  PencilIcon,
  SendHorizontalIcon,
  XIcon,
} from "lucide-react"
import type { QueuedMessage } from "@daedalus/protocol"

import { Timestamp } from "@/components/tool-parts"
import { UserMessageText } from "@/components/thread-items/user-message"
import type { Actions } from "@/lib/actions"
import type { ThreadState } from "@/lib/store"
import { formatBytes } from "@/lib/attachments"
import { cn } from "@/lib/utils"

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
    <section aria-label="Pending updates" className="mt-2">
      <header className="mb-1.5 flex items-center justify-between px-1">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Up next
        </h3>
        <span className="text-[10px] tabular-nums text-muted-foreground/70">
          {count} {count === 1 ? "message" : "messages"}
        </span>
      </header>
      <ol className="flex min-w-0 flex-col gap-1">
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
      </ol>
    </section>
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
    <li
      aria-busy={busy || undefined}
      className={cn(
        "group/queued relative flex min-w-0 flex-col gap-1 rounded-md border border-border/50 bg-muted/40 px-2 py-1.5",
        "transition-colors hover:border-border hover:bg-muted/70",
        busy && "opacity-50"
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn(
              "truncate text-[10px] font-medium",
              item.steer ? "text-primary" : next ? "text-foreground/80" : "text-muted-foreground"
            )}
            aria-label={item.steer ? "Steering this turn" : next ? "Up next" : "Queued"}
          >
            {item.steer ? "Steering" : next ? "Next" : "Queued"}
          </span>
          <span aria-hidden className="size-0.5 shrink-0 rounded-full bg-muted-foreground/40" />
          <Timestamp at={item.createdAt} className="shrink-0 text-[10px] text-muted-foreground/60" />
        </div>
        {!item.steer && (
          <div className="ms-auto flex flex-wrap items-center justify-end gap-x-2 gap-y-0.5">
            {running && (
              <button
                type="button"
                className="inline-flex min-h-6 items-center gap-1 text-[10px] font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
                disabled={!canSend || busy}
                title="Steer: send this into the running turn without stopping it"
                onClick={() => run(actions.queueSteer(sessionId, item.id))}
              >
                <CornerDownRightIcon className="size-3" />
                Steer
              </button>
            )}
            <button
              type="button"
              className="inline-flex min-h-6 items-center gap-1 text-[10px] font-medium text-primary hover:text-primary/80 disabled:opacity-50"
              disabled={!canSend || busy}
              title={running ? "Stop the running turn and send this now" : "Send this now"}
              onClick={() => run(actions.queueSendNow(sessionId, item.id))}
            >
              <SendHorizontalIcon className="size-3" />
              Send now
            </button>
            <button
              type="button"
              className="inline-flex min-h-6 items-center gap-1 text-[10px] font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
              disabled={!canEdit || busy}
              title="Take it back to the composer — this removes it from the queue"
              onClick={edit}
            >
              <PencilIcon className="size-3" />
              Edit
            </button>
            <button
              type="button"
              className="inline-flex min-h-6 items-center gap-1 text-[10px] font-medium text-muted-foreground hover:text-destructive disabled:opacity-50"
              disabled={!canEdit || busy}
              title="Remove from queue"
              onClick={() => run(actions.queueRemove(sessionId, item.id))}
            >
              <XIcon className="size-3" />
              Remove
            </button>
          </div>
        )}
      </div>
      <div dir="auto" className="min-w-0 break-words text-xs leading-5 text-muted-foreground">
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
      </div>
    </li>
  )
}

/** Attachments stay inline with their pending prompt and can be removed independently. */
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
          className="flex items-center gap-1 rounded-pill bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground"
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
