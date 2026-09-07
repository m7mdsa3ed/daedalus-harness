/* ── One row shape for every setting ──
   Model, effort, permission mode and whatever else an agent invents all render
   through here, in the session menu and in the draft menu alike. The point is
   that a picker driven by ACP and a picker driven by the profile catalog are
   the same control to look at — the difference between them is what happens on
   select, and that is the caller's business, not the row's. */
import type * as acp from "@daedalus/acp"
import * as React from "react"
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu"
import { flattenSelectOptions } from "@/lib/session-options"

export interface Choice {
  value: string
  name: string
  /** A mark drawn before the name — a profile's logo, an agent's brand. */
  icon?: React.ReactNode
  /** Optional group label — choices with the same group are rendered under a
      shared heading in the submenu. */
  group?: string
}

export function MenuRow({
  label,
  value,
  choices,
  onSelect,
}: {
  label: string
  value: string
  choices: Choice[]
  onSelect: (value: string) => void
}) {
  const current = choices.find((choice) => choice.value === value)
  const [submenuOpen, setSubmenuOpen] = React.useState(false)

  /* When any choice carries a group, the submenu is partitioned into labelled
     sections.  The array order is the display order; a group label is drawn the
     first time its value appears, and a separator is drawn between adjacent
     groups.  Choices without a group go under no heading. */
  const hasGroups = choices.some((c) => c.group)

  /** Render one choice item, optionally preceded by a group header. */
  const renderChoice = (choice: Choice, prevGroup: string | undefined) => {
    const parts: React.ReactNode[] = []
    if (hasGroups && choice.group !== prevGroup) {
      if (prevGroup !== undefined) {
        parts.push(<DropdownMenuSeparator key={`sep-${choice.group ?? "none"}`} />)
      }
      if (choice.group) {
        parts.push(
          <DropdownMenuLabel key={`lbl-${choice.group}`} className="text-[11px] tracking-wide uppercase pt-1 pb-0.5">
            {choice.group}
          </DropdownMenuLabel>,
        )
      }
    }
    parts.push(
      <DropdownMenuRadioItem key={choice.value} value={choice.value}>
        {choice.icon}
        <span className="truncate">{choice.name}</span>
      </DropdownMenuRadioItem>,
    )
    return parts
  }

  return (
    <DropdownMenuSub open={submenuOpen} onOpenChange={setSubmenuOpen}>
      <DropdownMenuSubTrigger>
        <span className="flex-1">{label}</span>
        {current?.icon}
        <span className="max-w-24 truncate text-xs text-muted-foreground">
          {current?.name ?? value}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent>
          <DropdownMenuRadioGroup
            value={value}
            onValueChange={(next) => {
              setSubmenuOpen(false)
              next && next !== value && onSelect(next)
            }}
          >
            {(() => {
              let prevGroup: string | undefined
              return choices.flatMap((choice) => {
                const parts = renderChoice(choice, prevGroup)
                prevGroup = choice.group
                return parts
              })
            })()}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  )
}

/**
 * The same row, for a setting whose choices have not been learned yet.
 *
 * A menu that simply leaves the row out until the probe answers is a menu that
 * changes height and order under the pointer, and — worse — one that says this
 * agent has no model to pick for as long as the spawn takes. Drawn disabled and
 * with the value skeletoned, which is the same bargain the project page's tiles
 * make: a shape that is waiting, never a zero.
 */
export function MenuRowSkeleton({ label }: { label: string }) {
  return (
    <DropdownMenuItem disabled>
      <span className="flex-1">{label}</span>
      <span className="h-3 w-14 animate-pulse rounded bg-muted" />
    </DropdownMenuItem>
  )
}

/** A select option's choices, flattened out of any groups the agent used. */
export const selectChoices = (option: acp.SessionConfigOption): Choice[] =>
  option.type === "select"
    ? flattenSelectOptions(option.options).map((choice) => ({
        value: choice.value,
        name: choice.name,
      }))
    : []
