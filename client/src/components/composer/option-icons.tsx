/* ── Icons for the two settings whose words differ per agent ──
   Effort and permission mode are drawn on the model chip, but every runtime
   names them differently (`low/medium/high`, `minimal…xhigh`, `acceptEdits`,
   `bypassPermissions`). The two get two different answers, because the two
   have different structure:

   - **Effort is ordered**, so its icon is a *position* — how far along the
     agent's own list the pick is. No vocabulary is read, so a new runtime's
     words work the day it ships.
   - **A mode has no order**, so its icon is a keyword match on concepts, with a
     neutral fallback. A miss costs a generic glyph, never a wrong claim: the
     mode's name is always printed beside it. */
import {
  ClipboardListIcon,
  EyeIcon,
  PencilIcon,
  ShieldIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"
import type { Choice } from "@/components/config-menu"

/** Where a value sits in its option's list; `null` when it cannot be placed. */
export function levelOf(values: string[], current: string | undefined | null) {
  const index = current ? values.indexOf(current) : -1
  return index < 0 || values.length < 2 ? null : { index, count: values.length }
}

/** Effort as a meter of equal bars: one per step, filled up to the pick. Capped at
    five bars so a long list stays legible at 10px; the fill scales with it. */
export function EffortMeter({
  index,
  count,
  className,
}: {
  index: number
  count: number
  className?: string
}) {
  const bars = Math.min(count, 5)
  const lit = Math.round(((index + 1) / count) * bars)
  return (
    <span aria-hidden className={cn("inline-flex h-2 shrink-0 items-center gap-[1.5px]", className)}>
      {Array.from({ length: bars }, (_, i) => (
        <span
          key={i}
          className={cn("h-full w-[2px] rounded-[1px]", i < lit ? "bg-current" : "bg-current opacity-25")}
        />
      ))}
    </span>
  )
}

/* Order matters: the first match wins, so the riskiest concept is checked
   before the gentle ones ("auto-accept edits" is a bypass, not an edit mode). */
const MODE_CONCEPTS: { match: RegExp; icon: LucideIcon; warn?: boolean }[] = [
  { match: /bypass|yolo|danger|full|auto/i, icon: ZapIcon, warn: true },
  { match: /plan/i, icon: ClipboardListIcon },
  { match: /edit|accept|write/i, icon: PencilIcon },
  { match: /ask|default|read|review|manual/i, icon: EyeIcon },
]

/** A mode's glyph, and whether it is one worth a warning tint. */
export function modeConcept(id: string | undefined, name: string | undefined) {
  const text = `${id ?? ""} ${name ?? ""}`
  const hit = MODE_CONCEPTS.find((c) => c.match.test(text))
  return { Icon: hit?.icon ?? ShieldIcon, warn: hit?.warn ?? false }
}

export function ModeIcon({
  id,
  name,
  className,
}: {
  id?: string
  name?: string
  className?: string
}) {
  const { Icon, warn } = modeConcept(id, name)
  return (
    <Icon
      aria-hidden
      className={cn("size-3 shrink-0", warn && "text-amber-600 dark:text-amber-400", className)}
    />
  )
}

/** Submenu choices for an effort row, each wearing its own meter. Position is
    counted among the real steps only: a "__default__" placeholder is not one. */
export function withEffortIcons(choices: Choice[]): Choice[] {
  const steps = choices.filter((c) => !c.value.startsWith("__"))
  return choices.map((c) => {
    const at = steps.indexOf(c)
    return at < 0 || steps.length < 2
      ? c
      : { ...c, icon: <EffortMeter index={at} count={steps.length} className="mx-0.5 text-muted-foreground" /> }
  })
}

/** Submenu choices for a mode row, each wearing its concept's icon. */
export function withModeIcons(choices: Choice[]): Choice[] {
  return choices.map((c) => ({ ...c, icon: <ModeIcon id={c.value} name={c.name} className="size-4" /> }))
}
