import * as React from "react"
import { Plus } from "lucide-react"

import { cn } from "@/lib/utils"
import { reportError } from "@/lib/errors"
import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { Kbd } from "@/components/ui/kbd"

/**
 * Inline "+ Add task" that turns into a title field, the way a kanban column
 * or a list group should take a new item: Enter creates and stays open for
 * the next one, Escape closes. Everything beyond the title is the caller's
 * default (the column, the sprint, the parent) — the detail panel is where
 * the rest gets filled in. It sits in the flow, never bottom-fixed, so the
 * soft keyboard scrolls it into view like any other field.
 */
export function QuickAdd({
  onCreate,
  placeholder = "What needs doing?",
  label = "Add task",
  className,
  compact,
  open: openProp,
  onOpenChange,
}: {
  onCreate: (title: string) => Promise<void>
  placeholder?: string
  /** The closed button's words, and the field's name. */
  label?: string
  className?: string
  compact?: boolean
  /** Controlled open state, for a header "+" that opens the same field. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const [openState, setOpenState] = React.useState(false)
  const open = openProp ?? openState
  const setOpen = (next: boolean) => {
    setOpenState(next)
    onOpenChange?.(next)
  }
  const [title, setTitle] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  const submit = async () => {
    const text = title.trim()
    if (!text || busy) return
    setBusy(true)
    try {
      await onCreate(text)
      setTitle("")
      inputRef.current?.focus()
    } catch (err) {
      reportError(err, "Couldn't create the task")
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        className={cn("w-full justify-start text-muted-foreground pointer-coarse:h-11", compact && "h-7", className)}
      >
        <Plus data-icon="inline-start" /> {label}
      </Button>
    )
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
      className={className}
    >
      <InputGroup className="h-9 bg-card pointer-coarse:h-11">
        <InputGroupInput
          ref={inputRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setOpen(false)
              setTitle("")
            }
          }}
          onBlur={() => {
            if (!title.trim()) setOpen(false)
          }}
          placeholder={placeholder}
          disabled={busy}
          aria-label={label}
        />
        <InputGroupAddon align="inline-end">
          <Kbd className="pointer-coarse:hidden" title="Enter to add, Esc to close">↵</Kbd>
          <InputGroupButton type="submit" size="sm" variant="default" loading={busy} disabled={!title.trim()} className="h-7 px-2.5 pointer-coarse:h-9">
            Add
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </form>
  )
}
