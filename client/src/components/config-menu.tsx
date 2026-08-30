/* ── One row shape for every setting ──
   Model, effort, permission mode and whatever else an agent invents all render
   through here, in the session menu and in the draft menu alike. The point is
   that a picker driven by ACP and a picker driven by the profile catalog are
   the same control to look at — the difference between them is what happens on
   select, and that is the caller's business, not the row's. */
import type * as acp from "@agentclientprotocol/sdk"
import type * as React from "react"
import {
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
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
  return (
    <DropdownMenuSub>
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
            onValueChange={(next) => next && next !== value && onSelect(next)}
          >
            {choices.map((choice) => (
              <DropdownMenuRadioItem key={choice.value} value={choice.value}>
                {choice.icon}
                <span className="truncate">{choice.name}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
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
