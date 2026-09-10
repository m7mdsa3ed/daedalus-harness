/* ── Presets tab ──
   Start from a coordinated whole rather than from a token: a style preset (the
   Design half at once), a curated colour scheme (the palette *and* the design
   that goes with it), or the ramp the built-in themes are generated from —
   driven either by a named palette preset or by the three sliders below it.
   Each of the three swatches draws the thing it applies, because the names are
   not the choice. */
import * as React from "react"
import { Shuffle } from "lucide-react"

import { Button } from "@/components/ui/button"
import { FieldDescription, FieldLegend, FieldSet } from "@/components/ui/field"
import { Slider } from "@/components/ui/slider"
import { COLOR_SCHEMES, type ColorScheme } from "@/lib/color-schemes"
import {
  PALETTE_PRESETS,
  STYLE_PRESETS,
  themeStyleVars,
  type BaseTokens,
  type RampSpec,
} from "@/lib/custom-themes"
import { cn } from "@/lib/utils"

const HUE_TRACK =
  "linear-gradient(to right, oklch(0.7 0.16 0), oklch(0.7 0.16 60), oklch(0.7 0.16 120), oklch(0.7 0.16 180), oklch(0.7 0.16 240), oklch(0.7 0.16 300), oklch(0.7 0.16 360))"

export function PresetsTab({
  base,
  onBase,
  onPalette,
  onScheme,
}: {
  base: BaseTokens
  onBase: (patch: BaseTokens) => void
  onPalette: (spec: RampSpec) => void
  onScheme: (scheme: ColorScheme) => void
}) {
  const [spec, setSpec] = React.useState<RampSpec>(PALETTE_PRESETS[2])
  const patch = (next: Partial<RampSpec>) => {
    const merged = { ...spec, ...next }
    setSpec(merged)
    onPalette(merged)
  }

  /** Which style preset the Design half currently *is*, if any — so a preset
      that has been applied and not since edited reads as selected. */
  const activeStyle = STYLE_PRESETS.find((preset) =>
    Object.entries(preset.base).every(([key, value]) => base[key] === value)
  )?.id

  return (
    <>
      <FieldSet className="gap-3">
        <div>
          <FieldLegend variant="label" className="mb-0 text-xs">
            Style
          </FieldLegend>
          <FieldDescription className="text-[11px]">
            Sets the whole Design tab at once — type, shape, depth, glass and measure. Every part
            stays editable afterwards.
          </FieldDescription>
        </div>
        <div className="grid grid-cols-2 gap-1.5 @panel-sm:grid-cols-3">
          {STYLE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              title={preset.hint}
              aria-pressed={activeStyle === preset.id}
              onClick={() => onBase(preset.base)}
              className={cn(
                "flex flex-col gap-1.5 rounded-xl border p-2 text-left transition-colors",
                activeStyle === preset.id
                  ? "border-ring bg-accent text-accent-foreground ring-2 ring-ring/25"
                  : "border-border hover:bg-accent/50"
              )}
            >
              <StyleSwatch base={preset.base} />
              <span className="text-[11px] font-medium">{preset.label}</span>
            </button>
          ))}
        </div>
      </FieldSet>

      <FieldSet className="gap-3">
        <div>
          <FieldLegend variant="label" className="mb-0 text-xs">
            Scheme
          </FieldLegend>
          <FieldDescription className="text-[11px]">
            Established colour schemes, transcribed from each project's own source and checked
            against WCAG AA. Unlike the generated palettes below, a scheme also sets the design
            that goes with it — Revert undoes the whole thing.
          </FieldDescription>
        </div>
        <div className="grid gap-1.5 @panel-sm:grid-cols-2">
          {COLOR_SCHEMES.map((scheme) => (
            <button
              key={scheme.id}
              type="button"
              title={`${scheme.note}\nSource: ${scheme.source}`}
              onClick={() => onScheme(scheme)}
              className="flex flex-col gap-1.5 rounded-xl border p-2 text-left transition-colors hover:bg-accent/50"
            >
              <SchemeSwatch scheme={scheme} />
              <span className="min-w-0">
                <span className="block truncate text-[11px] font-medium">{scheme.label}</span>
                <span className="block truncate text-[10px] text-muted-foreground">
                  {scheme.note}
                </span>
              </span>
            </button>
          ))}
        </div>
      </FieldSet>

      <FieldSet className="gap-3">
        <div>
          <FieldLegend variant="label" className="mb-0 text-xs">
            Palette
          </FieldLegend>
          <FieldDescription className="text-[11px]">
            Regenerates every colour, light and dark, through the same ramp the built-in themes are
            built from. Individual tokens can still be overridden on the Color tab afterwards.
          </FieldDescription>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {PALETTE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => {
                setSpec(preset)
                onPalette(preset)
              }}
              className="flex items-center gap-1.5 rounded-pill border px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
            >
              <span
                className="size-3 rounded-full"
                style={{ background: `oklch(0.6 ${preset.brand} ${preset.hue})` }}
              />
              {preset.label}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-3 rounded-xl border p-3">
          <SpecSlider
            label="Hue"
            value={spec.hue}
            min={0}
            max={360}
            step={1}
            suffix="°"
            track={HUE_TRACK}
            onChange={(hue) => patch({ hue })}
          />
          <SpecSlider
            label="Saturation"
            value={Math.round(spec.brand * 1000)}
            min={0}
            max={180}
            step={2}
            onChange={(v) => patch({ brand: v / 1000 })}
            track={`linear-gradient(to right, oklch(0.6 0 ${spec.hue}), oklch(0.6 0.18 ${spec.hue}))`}
          />
          <SpecSlider
            label="Neutral tint"
            value={Math.round(spec.tint * 1000)}
            min={0}
            max={30}
            step={1}
            onChange={(v) => patch({ tint: v / 1000 })}
            track={`linear-gradient(to right, oklch(0.93 0 ${spec.hue}), oklch(0.93 0.03 ${spec.hue}))`}
          />
          <Button
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() =>
              patch({
                hue: Math.floor(Math.random() * 360),
                brand: 0.02 + Math.random() * 0.14,
              })
            }
          >
            <Shuffle /> Surprise me
          </Button>
        </div>
      </FieldSet>
    </>
  )
}

/** A scheme drawn as both its halves at once: the light bar over the dark one,
    each showing the surfaces it will paint (background, card, muted) and the
    accents it will paint them with. Two rows because a scheme *is* a pair, and
    half of these are known for one mode and improvised in the other — which is
    exactly the half a single-row swatch would hide. */
function SchemeSwatch({ scheme }: { scheme: ColorScheme }) {
  return (
    <span aria-hidden className="flex flex-col overflow-hidden rounded-lg border border-border">
      {(["light", "dark"] as const).map((mode) => {
        const a = scheme[mode]
        return (
          <span
            key={mode}
            className="flex items-center gap-1 p-1"
            style={{ background: a.bg }}
          >
            <span
              className="grid h-5 w-7 shrink-0 place-items-center rounded-sm text-[9px] leading-none font-medium"
              style={{ background: a.card, color: a.fg }}
            >
              Aa
            </span>
            <span
              className="h-5 w-4 shrink-0 rounded-sm"
              style={{ background: a.muted }}
            />
            <span className="ml-auto flex gap-0.5">
              {[a.primary, ...a.charts.slice(0, 4)].map((hex, i) => (
                <span key={i} className="size-2.5 rounded-full" style={{ background: hex }} />
              ))}
            </span>
          </span>
        )
      })}
    </span>
  )
}

/** A style preset drawn as itself: a card, a badge and a button at that
    preset's radius, depth and heading face. The names ("Swiss", "Playful") are
    not the choice — this is. */
function StyleSwatch({ base }: { base: BaseTokens }) {
  const vars = themeStyleVars({ id: "", name: "", light: {}, dark: {}, base }, "light")
  return (
    <span
      aria-hidden
      style={vars as React.CSSProperties}
      className="flex items-center gap-1 rounded-lg border border-border bg-card p-1.5 shadow-glass"
    >
      <span className="font-heading text-[11px] leading-none font-medium">Aa</span>
      <span className="ml-auto h-3 w-5 rounded-pill bg-muted" />
      <span className="h-3 w-3.5 rounded-sm bg-primary" />
    </span>
  )
}

function SpecSlider({
  label,
  value,
  min,
  max,
  step,
  suffix = "",
  track,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  suffix?: string
  track: string
  onChange: (value: number) => void
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium">{label}</span>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {value}
          {suffix}
        </span>
      </div>
      {/* The gradient sits behind the track rather than on it: the slider is a
          shadcn primitive and a themed range is not worth forking it for. */}
      <div className="mt-1.5 rounded-pill" style={{ background: track }}>
        <Slider
          className="[&_[data-slot=slider-track]]:bg-transparent"
          value={value}
          min={min}
          max={max}
          step={step}
          onValueChange={(next) => onChange(Array.isArray(next) ? next[0] : next)}
        />
      </div>
    </div>
  )
}
