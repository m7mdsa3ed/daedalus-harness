/**
 * A list the reader puts in order — priorities, a shortlist, what to do first.
 *
 * Its value is a string, because a `$variable` is one: the items joined by
 * " > ", most important first, which is also how it reads in the message the
 * view sends ("- priorities: Speed > Cost > Design"). The model's own order is
 * the default, set once the program has finished arriving
 * (`useSetDefaultValue` waits for the stream), so a form sent untouched still
 * says what order it was in.
 *
 * Three ways to move a row, because each one fails somebody: a drag for a
 * mouse, the grip's own keyboard drag (Space, arrows, Space) for anyone who
 * reached it with Tab, and an up/down pair for a finger, where a drag inside a
 * scrolling transcript fights the scroll. All three are the one `move`.
 */
import { z } from "zod/v4"
import { useMemo } from "react"
import { ArrowDown, ArrowUp, GripVertical } from "lucide-react"
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core"
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { defineComponent, reactive, useIsStreaming } from "@openuidev/react-lang"
import { Button as UiButton } from "@/components/ui/button"
import { FieldError } from "@/components/ui/field"
import { useField } from "@/lib/openui/components/interactive"
import { BODY, Box, META, PAD_ROW } from "@/lib/openui/kit"
import { cn } from "@/lib/utils"

const SEP = " > "

/** The stored order, kept honest against the items the program wrote: a name
    it no longer lists is dropped and a new one joins at the end. */
function readOrder(raw: unknown, items: string[]): string[] {
  const known = new Set(items)
  const stored = typeof raw === "string" && raw ? raw.split(SEP).filter((item) => known.has(item)) : []
  const seen = new Set(stored)
  return [...stored, ...items.filter((item) => !seen.has(item))]
}

function RankRow({
  id,
  index,
  count,
  disabled,
  move,
}: {
  id: string
  index: number
  count: number
  disabled: boolean
  move: (from: number, to: number) => void
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id, disabled })
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("flex min-w-0 items-center gap-2", PAD_ROW, isDragging && "relative z-10 rounded-inner bg-popover shadow-md")}
    >
      <span className={cn(META, "w-5 shrink-0 text-end tabular-nums")} aria-hidden>
        {index + 1}
      </span>
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        disabled={disabled}
        aria-label={`Move ${id}, position ${index + 1} of ${count}`}
        className="-my-1 flex size-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-inner text-muted-foreground outline-none hover:bg-wash focus-visible:ring-[3px] focus-visible:ring-ring/50 active:cursor-grabbing disabled:cursor-default disabled:opacity-50"
      >
        <GripVertical aria-hidden className="size-4" />
      </button>
      <span className={cn(BODY, "min-w-0 flex-1")}>{id}</span>
      <span className="flex shrink-0 items-center">
        <UiButton
          type="button"
          size="icon-sm"
          variant="ghost"
          disabled={disabled || index === 0}
          title={`Move ${id} up`}
          className="pointer-coarse:size-11"
          onClick={() => move(index, index - 1)}
        >
          <ArrowUp aria-hidden />
        </UiButton>
        <UiButton
          type="button"
          size="icon-sm"
          variant="ghost"
          disabled={disabled || index === count - 1}
          title={`Move ${id} down`}
          className="pointer-coarse:size-11"
          onClick={() => move(index, index + 1)}
        >
          <ArrowDown aria-hidden />
        </UiButton>
      </span>
    </li>
  )
}

export const Rank = defineComponent({
  name: "Rank",
  description:
    "A list the reader puts in order by dragging or with up/down buttons. Its value is the items joined by \" > \", first is most important.",
  props: z.object({
    name: z.string(),
    items: z.array(z.string()),
    value: reactive(z.string().optional()),
  }),
  component: ({ props }) => {
    const streaming = useIsStreaming()
    // A ranking of two identical rows is not a ranking; ids must be unique.
    const items = useMemo(() => [...new Set(props.items.map((item) => item.trim()).filter(Boolean))], [props.items])
    const field = useField(props.name, props.value ?? items.join(SEP))
    const order = readOrder(field.value, items)
    const sensors = useSensors(
      useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
      useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
    )
    const move = (from: number, to: number) => {
      if (to < 0 || to >= order.length || from === to) return
      field.set(arrayMove(order, from, to).join(SEP))
    }
    const onDragEnd = ({ active, over }: DragEndEvent) => {
      if (over) move(order.indexOf(String(active.id)), order.indexOf(String(over.id)))
    }
    return (
      <div className="min-w-0 space-y-1">
        <Box>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={order} strategy={verticalListSortingStrategy}>
              <ol aria-label={props.name} className="w-full min-w-0 list-none divide-y divide-rule">
                {order.map((id, index) => (
                  <RankRow key={id} id={id} index={index} count={order.length} disabled={streaming} move={move} />
                ))}
              </ol>
            </SortableContext>
          </DndContext>
        </Box>
        <FieldError>{field.error}</FieldError>
      </div>
    )
  },
})
