/**
 * One library entry inside a tools submenu: its name, whether the thread has
 * it, and — on the second line — where it came from. It is handed booleans
 * rather than the thread's links, so it knows nothing about which of the three
 * kinds it is drawing.
 */
import { KeyRoundIcon } from "lucide-react"
import type { ReactNode } from "react"

import { DropdownMenuCheckboxItem } from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

/** The status dot's ground, per state. A server's listing is a thing the
    harness knows without connecting, so a row can say "connected" before it has
    ever been called — see `McpSection`. */
const DOT: Record<"ok" | "warn" | "error" | "idle", string> = {
  ok: "bg-success",
  warn: "bg-warning",
  error: "bg-destructive",
  idle: "bg-muted-foreground/40",
}

export function ToolRow({
  name,
  icon,
  checked,
  disabled,
  /** Linked by the profile, not by the thread: checked and locked. */
  from,
  needsAuth,
  /** The second line when the entry is neither the profile's nor unauthorized. */
  hint,
  /** A state a live server has and a skill does not — connected, unauthorized,
      failing. Drawn as a dot after the name, with the words in its title. */
  dot,
  onCheckedChange,
}: {
  name: string
  icon?: ReactNode
  checked: boolean
  disabled: boolean
  from: boolean
  needsAuth: boolean
  hint: string
  dot?: { tone: "ok" | "warn" | "error" | "idle"; label: string; detail?: string }
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <DropdownMenuCheckboxItem
      checked={checked}
      disabled={disabled}
      closeOnClick={false}
      onCheckedChange={onCheckedChange}
    >
      {icon}
      <span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{name}</span>
          {dot && (
            <span
              role="img"
              aria-label={dot.label}
              title={dot.detail ? `${dot.label} — ${dot.detail}` : dot.label}
              className={cn("size-1.5 shrink-0 rounded-full", DOT[dot.tone])}
            />
          )}
          {/* An OAuth server nobody has connected resolves to
              nothing at spawn — it is not advertised at all, the
              rule the built-in web-search row already sets. So it
              is marked here rather than silently listed as though
              the thread had it. */}
          {needsAuth && (
            <KeyRoundIcon className="size-3 shrink-0 text-destructive" aria-label="needs authorization" />
          )}
        </span>
        <span className="truncate font-mono text-xs text-muted-foreground">
          {needsAuth
            ? "needs authorization — Settings › MCP servers"
            : from
              ? "from profile"
              : hint}
        </span>
      </span>
    </DropdownMenuCheckboxItem>
  )
}
