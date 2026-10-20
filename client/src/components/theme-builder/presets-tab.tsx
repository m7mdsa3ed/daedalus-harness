/* ── Presets tab ──
   Start from a coordinated whole rather than from a token: a style preset (the
   Design half at once), a curated colour scheme (the palette *and* the design
   that goes with it), or the palette ramp —
   driven either by a named palette preset or by the three sliders below it.
   Each of the three swatches draws the thing it applies, because the names are
   not the choice. */
import * as React from "react"
import { Shuffle } from "lucide-react"

import { ChoiceTiles } from "@/components/settings/primitives"
import { Button } from "@/components/ui/button"
import { FieldDescription, FieldLegend, FieldSet } from "@/components/ui/field"
import { Slider } from "@/components/ui/slider"
import {
  PALETTE_PRESETS,
  STYLE_PRESETS,
  themeStyleVars,
  type BaseTokens,
  type RampSpec,
} from "@/lib/custom-themes"

const HUE_TRACK =
  "linear-gradient(to right, oklch(0.7 0.16 0), oklch(0.7 0.16 60), oklch(0.7 0.16 120), oklch(0.7 0.16 180), oklch(0.7 0.16 240), oklch(0.7 0.16 300), oklch(0.7 0.16 360))"

export function PresetsTab({
  base,
  onBase,
  onPalette,
}: {
  base: BaseTokens
  onBase: (patch: BaseTokens) => void
  onPalette: (spec: RampSpec) => void
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
          <FieldLegend variant="label" className="mb-0 text-sm">
            Style
          </FieldLegend>
          <FieldDescription className="text-xs">
            Sets the whole Design half at once — type, shape, surfaces and layout. Every part
            stays editable afterwards.
          </FieldDescription>
        </div>
        <ChoiceTiles
          label="Style"
          value={activeStyle ?? ""}
          onChange={(id) => {
            const preset = STYLE_PRESETS.find((entry) => entry.id === id)
            if (preset) onBase(preset.base)
          }}
          choices={STYLE_PRESETS.map((preset) => ({
            value: preset.id,
            label: preset.label,
            preview: (
              <span title={preset.hint}>
                <StyleSwatch base={preset.base} />
              </span>
            ),
          }))}
        />
      </FieldSet>

      <FieldSet className="gap-3">
        <div>
          <FieldLegend variant="label" className="mb-0 text-sm">
            Palette
          </FieldLegend>
          <FieldDescription className="text-xs">
            Regenerates every colour, light and dark, through the same ramp the built-in themes are
            built from. Individual tokens can still be overridden in the Color section afterwards.
          </FieldDescription>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {PALETTE_PRESETS.map((preset) => (
            <Button
              key={preset.id}
              type="button"
              variant="outline"
              size="xs"
              onClick={() => {
                setSpec(preset)
                onPalette(preset)
              }}
            >
              <span
                className="size-3 rounded-full"
                style={{ background: `oklch(0.6 ${preset.brand} ${preset.hue})` }}
              />
              {preset.label}
            </Button>
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

/** A style preset drawn as itself: a card, a badge and a button at that
    preset's radius, depth and heading face. The names ("Swiss", "Playful") are
    not the choice — this is. */
function StyleSwatch({ base }: { base: BaseTokens }) {
  const vars = themeStyleVars({ id: "", name: "", light: {}, dark: {}, base }, "light")
  return (
    <span
      aria-hidden
      style={vars as React.CSSProperties}
      className="flex items-center gap-1 rounded-lg border bg-card p-1.5 shadow-glass"
    >
      <span className="font-heading text-xs leading-none font-medium">Aa</span>
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
        <span className="text-xs font-medium">{label}</span>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
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
