/* Messages wait here until the active turn finishes. A composer steer is
   already on the wire and is shown only until its transcript bubble lands. */
import * as React from "react"
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core"
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import {
  CornerDownRightIcon,
  GripVerticalIcon,
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
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
  /* A drop is drawn at once and the server's `queue` event replaces it: the
     order is kept against the list it was dragged from, so the next event —
     the answer, or anyone else's edit — is what is drawn, with no effect to
     clear it. */
  const [dragged, setDragged] = React.useState<{ from: QueuedMessage[]; ids: string[] } | null>(null)
  const steers = thread.queue.filter((item) => item.steer)
  const queued = thread.queue.filter((item) => !item.steer)
  const editable =
    dragged?.from === thread.queue
      ? dragged.ids.flatMap((id) => queued.find((item) => item.id === id) ?? [])
      : queued
  const items = [...steers, ...editable]
  const count = items.length
  /* The grip is its own target (as on Settings › Projects), so one pointer
     sensor covers mouse and touch with no swipe-versus-drag question. */
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  /* Rows picked for "Send selected". Held in the component, not the store: a
     pick is a gesture on this device, and a row that left the queue drops out
     of it below rather than being sent as a stale id. */
  const [picked, setPicked] = React.useState<ReadonlySet<string>>(new Set())
  const pickedIds = editable.filter((item) => picked.has(item.id)).map((item) => item.id)
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })
  const [busy, setBusy] = React.useState(false)
  if (count === 0) return null

  /* A failed connection can act on nothing; an archived thread has no process
     to send through, but its queue is rows and stays editable — the server
     answers those three without an agent. */
  const closed = thread.phase.kind === "failed" || thread.phase.kind === "deleted"
  const canSend = !closed && !thread.archived
  const canEdit = !closed
  const running = thread.turnActive
  const sortable = canEdit && editable.length > 1
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return
    const ids = editable.map((item) => item.id)
    const from = ids.indexOf(String(active.id))
    const to = ids.indexOf(String(over.id))
    if (from < 0 || to < 0) return
    const next = arrayMove(ids, from, to)
    setDragged({ from: thread.queue, ids: next })
    void actions.queueReorder(sessionId, next).catch(() => setDragged(null))
  }
  const sendMany = (ids: string[]) => {
    setBusy(true)
    void actions
      .queueSendNow(sessionId, ids.length > 0 ? ids : undefined)
      .then(() => setPicked(new Set()))
      .catch(() => {})
      .finally(() => setBusy(false))
  }
  return (
    <section aria-label="Pending updates">
      <header className="mb-2 flex items-center justify-between px-3">
        <h3 className="text-xs font-medium text-muted-foreground">
          Up next
        </h3>
        <div className="flex items-center gap-2">
          {editable.length > 1 && (
            <Button
              variant="ghost"
              size="xs"
              className="text-primary hover:text-primary"
              disabled={!canSend}
              loading={busy}
              title={`${running ? "Stop the running turn and send" : "Send"} ${
                pickedIds.length > 0 ? "the selected messages" : "every queued message"
              } together as one`}
              onClick={() => sendMany(pickedIds)}
            >
              {pickedIds.length > 0 ? `Send ${pickedIds.length} selected` : "Send all"}
            </Button>
          )}
          <span className="text-xs tabular-nums text-muted-foreground">
            {count} {count === 1 ? "message" : "messages"}
          </span>
        </div>
      </header>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={editable.map((item) => item.id)} strategy={verticalListSortingStrategy}>
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
                selected={picked.has(item.id)}
                onToggle={editable.length > 1 && !item.steer ? () => toggle(item.id) : undefined}
                sortable={sortable && !item.steer}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
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
  selected,
  onToggle,
  sortable,
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
  selected: boolean
  /** Absent when there is nothing to pick between (one row, or a steer). */
  onToggle?: () => void
  /** Draws the grip. A steer never has one: it is already on the wire. */
  sortable: boolean
}) {
  /* Which action is running, so its own button wears the ring and spinner. */
  const [action, setBusy] = React.useState<"steer" | "send" | "edit" | "remove" | false>(false)
  const busy = action !== false
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    disabled: !sortable,
  })

  const run = (which: "steer" | "send" | "remove", op: Promise<unknown>) => {
    setBusy(which)
    void op.catch(() => {}).finally(() => setBusy(false))
  }
  /* Removed first, filled second, and the fill only on success: a message that
     is in the box *and* still in the queue is one that gets said twice. */
  const edit = () => {
    setBusy("edit")
    void actions
      .queueRemove(sessionId, item.id)
      .then(() => onEdit(item.text))
      .catch(() => {})
      .finally(() => setBusy(false))
  }

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      aria-busy={busy || undefined}
      className={cn(
        /* Every row is waiting on the agent — a steer for the step boundary, a
           queued one for the turn's end — so it wears the busy ring a loading
           Button does (push/pull). */
        "group/queued harness-busy-ring relative flex min-w-0 flex-col gap-1 rounded-2xl border border-dashed bg-muted/50 p-2",
        "transition-colors hover:bg-muted",
        busy && "opacity-50",
        isDragging && "z-10 bg-muted"
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <div className="flex min-w-0 items-center gap-2 px-1">
          {sortable && (
            <button
              type="button"
              className="shrink-0 cursor-grab touch-none text-muted-foreground hover:text-foreground active:cursor-grabbing"
              title="Drag to reorder"
              {...attributes}
              {...listeners}
            >
              <GripVerticalIcon className="size-3" />
            </button>
          )}
          {onToggle && (
            <Checkbox
              checked={selected}
              aria-label="Select to send"
              disabled={!canSend || busy}
              onCheckedChange={onToggle}
            />
          )}
          <span
            className={cn(
              "truncate text-xs font-medium",
              item.steer ? "text-primary" : next ? "text-foreground" : "text-muted-foreground"
            )}
            aria-label={item.steer ? "Steering this turn" : next ? "Up next" : "Queued"}
          >
            {item.steer ? "Steering" : next ? "Next" : "Queued"}
          </span>
          <span aria-hidden className="size-0.5 shrink-0 rounded-full bg-muted-foreground/40" />
          <Timestamp at={item.createdAt} className="shrink-0 text-xs text-muted-foreground" />
        </div>
        {!item.steer && (
          <div className="ms-auto flex flex-wrap items-center justify-end gap-1">
            {running && (
              <Button
                variant="ghost"
                size="xs"
                className="text-muted-foreground"
                disabled={!canSend || busy}
                loading={action === "steer"}
                title="Steer: send this into the running turn without stopping it"
                onClick={() => run("steer", actions.queueSteer(sessionId, item.id))}
              >
                <CornerDownRightIcon data-icon="inline-start" />
                Steer
              </Button>
            )}
            <Button
              variant="ghost"
              size="xs"
              className="text-primary hover:text-primary"
              disabled={!canSend || busy}
              loading={action === "send"}
              title={running ? "Stop the running turn and send this now" : "Send this now"}
              onClick={() => run("send", actions.queueSendNow(sessionId, [item.id]))}
            >
              <SendHorizontalIcon data-icon="inline-start" />
              Send now
            </Button>
            <Button
              variant="ghost"
              size="xs"
              className="text-muted-foreground"
              disabled={!canEdit || busy}
              loading={action === "edit"}
              title="Take it back to the composer — this removes it from the queue"
              onClick={edit}
            >
              <PencilIcon data-icon="inline-start" />
              Edit
            </Button>
            <Button
              variant="ghost"
              size="xs"
              className="text-muted-foreground hover:text-destructive"
              disabled={!canEdit || busy}
              loading={action === "remove"}
              title="Remove from queue"
              onClick={() => run("remove", actions.queueRemove(sessionId, item.id))}
            >
              <XIcon data-icon="inline-start" />
              Remove
            </Button>
          </div>
        )}
      </div>
      <div dir="auto" className="min-w-0 break-words px-1 text-sm text-muted-foreground">
        {item.attachments && item.attachments.length > 0 && (
          <QueuedAttachments
            attachments={item.attachments}
            removable={canEdit && !busy}
            onRemove={(id) =>
              run(
                "remove",
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
    <ul className="mb-2 flex flex-wrap gap-1">
      {attachments.map((ref) => (
        <Badge key={ref.id} variant="secondary" render={<li />}>
          <PaperclipIcon />
          <span className="max-w-32 truncate">{ref.name}</span>
          <span className="shrink-0 text-muted-foreground">{formatBytes(ref.size)}</span>
          {removable && (
            <button
              type="button"
              aria-label={`Remove ${ref.name}`}
              className="-me-0.5 rounded-full p-0.5 hover:text-foreground"
              onClick={() => onRemove(ref.id)}
            >
              <XIcon />
            </button>
          )}
        </Badge>
      ))}
    </ul>
  )
}
