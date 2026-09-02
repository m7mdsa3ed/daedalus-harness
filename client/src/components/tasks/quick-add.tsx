import * as React from "react"
import { Plus } from "lucide-react"

import { cn } from "@/lib/utils"
import { reportError } from "@/lib/errors"

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
}: {
  onCreate: (title: string) => Promise<void>
  placeholder?: string
  className?: string
  compact?: boolean
}) {
  const [open, setOpen] = React.useState(false)
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
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          compact ? "h-7" : "h-8",
          className,
        )}
      >
        <Plus className="size-3.5" /> Add task
      </button>
    )
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
      className={cn("rounded-lg border bg-card p-1 shadow-xs", className)}
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
      <div className="flex items-center justify-between px-1 pt-1 text-[10px] text-muted-foreground">
        <span>Enter to add · Esc to close</span>
        <button type="submit" disabled={!title.trim() || busy} className="rounded-pill bg-primary px-2 py-0.5 text-[10px] font-medium text-primary-foreground disabled:opacity-50">
          {busy ? "Adding…" : "Add"}
        </button>
      </div>
    </form>
  )
}
