/* ── Design tab ──
   Everything that is one choice for the whole theme rather than one per mode.
   A key absent from `base` means "inherit the app default", which is what a
   theme saved before any of this existed carries — so every control here
   offers an explicit choice equivalent to that default and none writes on
   mount. */
import * as React from "react"

import { FieldDescription, FieldLegend, FieldSet } from "@/components/ui/field"
import { Item, ItemActions, ItemContent, ItemGroup, ItemTitle } from "@/components/ui/item"
import {
  BLUR_PRESETS,
  DEPTH_PRESETS,
  FONT_SLOTS,
  RADIUS_PRESETS,
  TRACKING_PRESETS,
  WIDTH_PRESETS,
  type BaseTokens,
} from "@/lib/custom-themes"
import { cn } from "@/lib/utils"

import { FontPicker } from "./font-picker"

// Each of these is a projection of a frozen preset table onto `PresetField`'s
// option shape — nothing about them depends on the theme being edited, so they
// are built once rather than on every keystroke the editor writes through.
const RADIUS_OPTIONS = RADIUS_PRESETS.map((p) => ({ id: p.id, label: p.label }))
const DEPTH_OPTIONS = DEPTH_PRESETS.map((p) => ({ id: p.id, label: p.label, hint: p.hint }))
const BLUR_OPTIONS = BLUR_PRESETS.map((p) => ({ id: p.id, label: p.label, hint: p.hint }))
const WIDTH_OPTIONS = WIDTH_PRESETS.map((p) => ({ id: p.id, label: p.label, hint: p.hint }))
const TRACKING_OPTIONS = TRACKING_PRESETS.map((p) => ({ id: p.id, label: p.label }))

export function DesignTab({
  base,
  onChange,
}: {
  base: BaseTokens
  onChange: (patch: BaseTokens) => void
}) {
  return (
    <>
      <FieldSet className="gap-3">
        <div>
          <FieldLegend variant="label" className="mb-0 text-xs">
            Typeface
          </FieldLegend>
          <FieldDescription className="text-[11px]">
            Three roles. Pick a bundled family, or name any family on Google Fonts.
          </FieldDescription>
        </div>
        <ItemGroup className="gap-0.5 rounded-xl border p-1">
          {FONT_SLOTS.map((slot) => (
            <Item key={slot.key} size="xs" className="gap-2 rounded-lg py-1.5">
              <ItemContent>
                <ItemTitle className="text-xs font-normal">{slot.label}</ItemTitle>
                <p className="text-[11px] text-muted-foreground">{slot.hint}</p>
              </ItemContent>
              <ItemActions>
                <FontPicker
                  value={base[slot.key]}
                  role={slot.role}
                  onChange={(value) => onChange({ [slot.key]: value })}
                />
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      </FieldSet>

      <PresetField
        legend="Shape"
        hint="One corner radius; every step from a chip to a dialog is a multiple of it. Square also squares the capsules."
        value={base.radius}
        options={RADIUS_OPTIONS}
        onChange={(id) => onChange({ radius: id })}
        renderSwatch={(id) => {
          const preset = RADIUS_PRESETS.find((p) => p.id === id)
          return (
            <span className="flex items-center gap-1">
              <span
                className="block size-5 border-2 border-current opacity-70"
                style={{ borderRadius: preset?.value }}
              />
              <span
                className="block h-2.5 w-4 bg-current opacity-40"
                style={{ borderRadius: preset?.pill }}
              />
            </span>
          )
        }}
      />

      <PresetField
        legend="Depth"
        hint="How far cards, popovers and the composer sit above the page."
        value={base.depth}
        options={DEPTH_OPTIONS}
        onChange={(id) => onChange({ depth: id })}
        renderSwatch={(id) => (
          <span
            className="block size-5 rounded-md border bg-card"
            style={{ boxShadow: `var(--depth-${id}-glass-lg)` }}
          />
        )}
      />

      <PresetField
        legend="Glass"
        hint="Backdrop blur behind cards, popovers, the sidebar and the composer."
        value={base.blur}
        options={BLUR_OPTIONS}
        onChange={(id) => onChange({ blur: id })}
        renderSwatch={(id) => (
          <span className="relative block size-5 overflow-hidden rounded-md">
            <span
              className="absolute inset-0"
              style={{
                background:
                  "repeating-linear-gradient(45deg, var(--primary) 0 3px, var(--accent) 3px 6px)",
              }}
            />
            <span
              className="absolute inset-x-0 bottom-0 h-1/2 border-t border-border/50 bg-card/50"
              style={{
                backdropFilter: `blur(${BLUR_PRESETS.find((p) => p.id === id)?.value ?? "0px"})`,
              }}
            />
          </span>
        )}
      />

      <PresetField
        legend="Measure"
        hint="The transcript's content column. A serif reads best narrow; code wants room."
        value={base.width}
        options={WIDTH_OPTIONS}
        onChange={(id) => onChange({ width: id })}
        renderSwatch={(id) => {
          const px = parseInt(WIDTH_PRESETS.find((p) => p.id === id)?.value ?? "748", 10)
          return (
            <span className="flex h-5 w-8 items-center justify-center rounded-sm border border-current/40">
              <span
                className="block h-3 bg-current opacity-50"
                style={{ width: `${Math.round((px / 1100) * 100)}%` }}
              />
            </span>
          )
        }}
      />

      <PresetField
        legend="Tracking"
        hint="Body letter-spacing. A geometric sans usually wants a hair less; a mono wants none."
        value={base.tracking}
        options={TRACKING_OPTIONS}
        onChange={(id) => onChange({ tracking: id })}
        renderSwatch={(id) => (
          <span
            className="block text-[11px] leading-5 font-medium opacity-70"
            style={{ letterSpacing: TRACKING_PRESETS.find((p) => p.id === id)?.value }}
          >
            Aa
          </span>
        )}
      />
    </>
  )
}

/** A row of mutually exclusive presets, each drawing a small live sample of
    what it does — a radius as a corner and a capsule, a depth as a lifted chip,
    a blur as an actual blur over a pattern. The names alone ("Soft", "Deep")
    do not tell you what you are choosing. */
function PresetField({
  legend,
  hint,
  value,
  options,
  onChange,
  renderSwatch,
}: {
  legend: string
  hint: string
  value: string | undefined
  options: { id: string; label: string; hint?: string }[]
  onChange: (id: string) => void
  renderSwatch: (id: string) => React.ReactNode
}) {
  return (
    <FieldSet className="gap-3">
      <div>
        <FieldLegend variant="label" className="mb-0 text-xs">
          {legend}
        </FieldLegend>
        <FieldDescription className="text-[11px]">{hint}</FieldDescription>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            title={option.hint}
            aria-pressed={value === option.id}
            onClick={() => onChange(option.id)}
            className={cn(
              "flex min-w-18 flex-1 flex-col items-center gap-1.5 rounded-xl border px-2 py-2.5 text-[11px] font-medium transition-colors",
              value === option.id
                ? "border-ring bg-accent text-accent-foreground ring-2 ring-ring/25"
                : "border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            )}
          >
            <span className="flex h-5 items-center justify-center">{renderSwatch(option.id)}</span>
            {option.label}
          </button>
        ))}
      </div>
    </FieldSet>
  )
}
