/* ── One token, one mode ──
   The Color tab's leaf control, and the only place a single colour is typed or
   picked. It is also where the AA check is *shown*: the pair a token is judged
   against is `CONTRAST_PAIRS`' and the threshold is `MIN_CONTRAST`, both of
   which the header's warning count reads too (`countWarnings`, in `editor.tsx`).
   Nothing here relaxes either — the field only reports. */
import * as React from "react"
import { TriangleAlert } from "lucide-react"

import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  contrastRatio,
  CONTRAST_PAIRS,
  MIN_CONTRAST,
  type ThemeTokens,
} from "@/lib/custom-themes"
import { cn } from "@/lib/utils"

import type { Mode } from "./preview"

/** One swatch + hex for one token in one mode. The picker is for exploring, the
    hex field for pasting a value you already have; both write the same string. */
export function TokenField({
  mode,
  token,
  tokens,
  onChange,
}: {
  mode: Mode
  token: string
  tokens: ThemeTokens
  onChange: (value: string) => void
}) {
  /* Below the split the two fields stack under their label and fill the row,
     so the pair is two large targets rather than two 128px boxes squeezed
     against a truncated name. Stacked they also have to say which mode they
     are — the column headers the wide layout prints once per group are gone. */
  const value = tokens[token] ?? "#808080"
  const [draft, setDraft] = React.useState(value)
  React.useEffect(() => setDraft(value), [value])

  const surface = CONTRAST_PAIRS[token]
  const ratio = surface && tokens[surface] ? contrastRatio(value, tokens[surface]) : null
  const failing = ratio !== null && ratio < MIN_CONTRAST

  const commit = (next: string) => {
    setDraft(next)
    if (/^#[0-9a-f]{6}$/i.test(next.trim())) onChange(next.trim().toLowerCase())
  }

  const field = (
    <InputGroup
      data-invalid={failing || undefined}
      className={cn(
        "h-9 w-full rounded-lg @panel-sm:h-7 @panel-sm:w-32 @panel-sm:shrink-0",
        failing && "border-destructive/70"
      )}
    >
      {/* The swatch is the addon: one control, two ways in — pick or paste. */}
      <InputGroupAddon className="pl-1.5">
        <input
          type="color"
          aria-label={`${token} (${mode})`}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="size-5 cursor-pointer appearance-none rounded border-0 bg-transparent p-0 @panel-sm:size-4.5 [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded [&::-webkit-color-swatch]:border-0"
        />
        <span className="text-xs @panel-sm:hidden">{mode}</span>
      </InputGroupAddon>
      <InputGroupInput
        value={draft}
        onChange={(event) => commit(event.target.value)}
        onBlur={() => setDraft(value)}
        spellCheck={false}
        aria-label={`${token} hex (${mode})`}
        className="h-9 px-0 text-right font-mono text-xs tabular-nums @panel-sm:h-7"
      />
      {failing && (
        <InputGroupAddon align="inline-end" className="pr-1.5 text-destructive">
          <TriangleAlert className="size-3" />
        </InputGroupAddon>
      )}
    </InputGroup>
  )

  if (!failing) return field
  return (
    <Tooltip>
      <TooltipTrigger render={field} />
      <TooltipContent>
        Contrast {ratio.toFixed(1)}:1 against --{surface} — AA body text needs {MIN_CONTRAST}:1.
      </TooltipContent>
    </Tooltip>
  )
}
