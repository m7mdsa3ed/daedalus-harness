/* Shared scraps for the board-settings editors (columns / labels / issue
   types). Nothing here fetches or decides anything — they exist so the three
   inline editors under board-settings-dialog look like one surface rather than
   three, and so the colour vocabulary is stated once.

   Colours are palette tokens, never hex: a column's colour has to survive every
   palette and every user-made theme (styles/themes.css), and these five are the
   same set the charts and the board cards draw from. */
import * as React from "react"

import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

export const PM_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
]

export interface ColorSwatchesProps {
  value: string | null
  onChange(value: string | null): void
  label: string
  disabled?: boolean
  className?: string
}

/** The five palette tokens plus "no colour". A radio group in spirit; buttons
    in fact, because a colour is picked, not typed. */
export function ColorSwatches({
  value,
  onChange,
  label,
  disabled,
  className,
}: ColorSwatchesProps) {
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {PM_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          disabled={disabled}
          aria-label={`${label}: colour ${PM_COLORS.indexOf(color) + 1}`}
          aria-pressed={value === color}
          onClick={() => onChange(color)}
          style={{ backgroundColor: color }}
          className={cn(
            "size-5 rounded-full ring-offset-2 ring-offset-background transition-shadow",
            value === color && "ring-2 ring-ring"
          )}
        />
      ))}
      <button
        type="button"
        disabled={disabled}
        aria-label={`${label}: no colour`}
        aria-pressed={value === null}
        onClick={() => onChange(null)}
        className={cn(
          "size-5 rounded-full border border-dashed ring-offset-2 ring-offset-background",
          value === null && "ring-2 ring-ring"
        )}
      />
    </div>
  )
}

export interface NameInputProps {
  value: string
  onCommit(value: string): void
  placeholder?: string
  ariaLabel: string
  disabled?: boolean
  className?: string
}

/** A name that writes on blur or Enter and never on a keystroke — the same
    "no Save button, no lost work" contract the task editor's fields have. An
    emptied name is a no-op, not a 400: the server refuses `""` anyway. */
export function NameInput({
  value,
  onCommit,
  placeholder,
  ariaLabel,
  disabled,
  className,
}: NameInputProps) {
  const [draft, setDraft] = React.useState(value)
  React.useEffect(() => setDraft(value), [value])

  const commit = () => {
    const next = draft.trim()
    if (!next) return setDraft(value)
    if (next !== value) onCommit(next)
  }

  return (
    <Input
      value={draft}
      aria-label={ariaLabel}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur()
        if (event.key === "Escape") setDraft(value)
      }}
      className={cn("h-8 text-[13px]", className)}
    />
  )
}

/** The settings tabs' section header: a title, a sentence, and whatever
    control belongs on the right (usually "New …"). */
export function EditorHeader({
  title,
  hint,
  action,
}: {
  title: string
  hint: string
  action?: React.ReactNode
}) {
  return (
    <header className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="text-xs text-pretty text-muted-foreground">{hint}</p>
      </div>
      {action}
    </header>
  )
}
