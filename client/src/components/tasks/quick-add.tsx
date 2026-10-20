import * as React from "react"
import { Plus } from "lucide-react"

import { cn } from "@/lib/utils"
import { reportError } from "@/lib/errors"
import { Button } from "@/components/ui/button"

/**
 * Inline "+ Add task" that turns into a title field, the way a kanban column
 * or a list group should take a new item: Enter creates and stays open for
 * the next one, Escape closes. Everything beyond the title is the caller's
 * default (the column, the sprint, the parent) — the detail panel is where
 * the rest gets filled in.
 */
export function QuickAdd({
  onCreate,
  placeholder = "What needs doing?",
  className,
  compact,
  open: openProp,
  onOpenChange,
}: {
  onCreate: (title: string) => Promise<void>
  placeholder?: string
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
        className={cn("w-full justify-start text-muted-foreground", compact && "h-7", className)}
      >
        <Plus /> Add task
      </Button>
    )
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
      className={cn("rounded-xl border bg-card p-1", className)}
    >
      <input
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
        aria-label="New task title"
        className="h-7 w-full bg-transparent px-1.5 text-sm outline-none placeholder:text-muted-foreground"
      />
      <div className="flex items-center justify-between px-1 pt-1 text-xs text-muted-foreground">
        <span>Enter to add · Esc to close</span>
        <Button type="submit" size="xs" loading={busy} disabled={!title.trim()}>
          Add
        </Button>
      </div>
    </form>
  )
}
