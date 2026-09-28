/**
 * One library entry inside a tools submenu: its name, whether the thread has
 * it, and — on the second line — where it came from. It is handed booleans
 * rather than the thread's links, so it knows nothing about which of the three
 * kinds it is drawing.
 */
import { KeyRoundIcon } from "lucide-react"

import { DropdownMenuCheckboxItem } from "@/components/ui/dropdown-menu"

import { rowSubtitle } from "./use-thread-tools"

export function ToolRow({
  name,
  checked,
  disabled,
  /** Linked by the profile, not by the thread: checked and locked. */
  from,
  needsAuth,
  /** The second line when the entry is neither the profile's nor unauthorized. */
  hint,
  onCheckedChange,
}: {
  name: string
  checked: boolean
  disabled: boolean
  from: boolean
  needsAuth: boolean
  hint: string
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <DropdownMenuCheckboxItem
      checked={checked}
      disabled={disabled}
      closeOnClick={false}
      onCheckedChange={onCheckedChange}
    >
      <span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{name}</span>
          {/* An OAuth server nobody has connected resolves to
              nothing at spawn — it is not advertised at all, the
              rule the built-in web-search row already sets. So it
              is marked here rather than silently listed as though
              the thread had it. */}
          {needsAuth && (
            <KeyRoundIcon className="size-3 shrink-0 text-destructive" aria-label="needs authorization" />
          )}
        </span>
        <span className="truncate font-mono text-[10px] text-muted-foreground">
          {rowSubtitle(needsAuth, from, hint)}
        </span>
      </span>
    </DropdownMenuCheckboxItem>
  )
}
