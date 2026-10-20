/* ── Design sections ──
   Everything that is one choice for the whole theme rather than one per mode,
   split into the sections the studio's nav lists: Type, Shape, Surfaces and
   Layout. (This was one flat tab of ten controls.)
   A key absent from `base` means "inherit the app default", which is what a
   theme saved before any of this existed carries — so every control here
   offers an explicit choice equivalent to that default and none writes on
   mount. */
import * as React from "react"

import { ChoiceTiles, Group, Row } from "@/components/settings/primitives"
import {
  BLUR_PRESETS,
  COMPOSER_PRESETS,
  DENSITY_PRESETS,
  DEPTH_PRESETS,
  EDGE_PRESETS,
  FONT_SLOTS,
  GROUND_PRESETS,
  RADIUS_PRESETS,
  SOLID_PRESETS,
  solidIdFor,
  TEXT_PRESETS,
  TRACKING_PRESETS,
  VIBRANCY_PRESETS,
  WIDTH_PRESETS,
  type BaseTokens,
} from "@/lib/custom-themes"

import { FontPicker } from "./font-picker"

// Each of these is a projection of a frozen preset table onto `PresetField`'s
// option shape — nothing about them depends on the theme being edited, so they
// are built once rather than on every keystroke the editor writes through.
const RADIUS_OPTIONS = RADIUS_PRESETS.map((p) => ({ id: p.id, label: p.label }))
const DEPTH_OPTIONS = DEPTH_PRESETS.map((p) => ({ id: p.id, label: p.label, hint: p.hint }))
const BLUR_OPTIONS = BLUR_PRESETS.map((p) => ({ id: p.id, label: p.label, hint: p.hint }))
const WIDTH_OPTIONS = WIDTH_PRESETS.map((p) => ({ id: p.id, label: p.label, hint: p.hint }))
const TRACKING_OPTIONS = TRACKING_PRESETS.map((p) => ({ id: p.id, label: p.label }))
const TEXT_OPTIONS = TEXT_PRESETS.map((p) => ({ id: p.id, label: p.label, hint: p.hint }))
const GROUND_OPTIONS = GROUND_PRESETS.map((p) => ({ id: p.id, label: p.label, hint: p.hint }))
const EDGE_OPTIONS = EDGE_PRESETS.map((p) => ({ id: p.id, label: p.label, hint: p.hint }))
const SOLID_OPTIONS = SOLID_PRESETS.map((p) => ({ id: p.id, label: p.label, hint: p.hint }))
const DENSITY_OPTIONS = DENSITY_PRESETS.map((p) => ({ id: p.id, label: p.label, hint: p.hint }))
const COMPOSER_OPTIONS = COMPOSER_PRESETS.map((p) => ({ id: p.id, label: p.label, hint: p.hint }))
const VIBRANCY_OPTIONS = VIBRANCY_PRESETS.map((p) => ({ id: p.id, label: p.label, hint: p.hint }))

const remPx = (rem: string) => parseFloat(rem) * 16
const radiusPx = (id: string | undefined) =>
  remPx(RADIUS_PRESETS.find((p) => p.id === id)?.value ?? "0.625rem")

/** What each section hands its controls: the theme's `base` and the one write. */
interface SectionProps {
  base: BaseTokens
  onChange: (patch: BaseTokens) => void
}

export function TypeSection({ base, onChange }: SectionProps) {
  return (
    <>
      <Group label="Typeface" hint="Three roles. Pick a bundled family, or name any family on Google Fonts.">
        {FONT_SLOTS.map((slot) => (
          <Row key={slot.key} title={slot.label} subtitle={slot.hint}>
            <FontPicker
              value={base[slot.key]}
              role={slot.role}
              onChange={(value) => onChange({ [slot.key]: value })}
            />
          </Row>
        ))}
      </Group>

<PresetField
        legend="Text size"
        hint="Scales the whole interface, not just body copy — every size in the app is measured from the root."
        value={base.text ?? "default"}
        options={TEXT_OPTIONS}
        onChange={(id) => onChange({ text: id })}
        renderSwatch={(id) => (
          <span
            className="block leading-none font-medium opacity-70"
            style={{
              fontSize: `calc(0.8125rem * ${parseFloat(TEXT_PRESETS.find((p) => p.id === id)?.value ?? "100") / 100})`,
            }}
          >
            Aa
          </span>
        )}
      />

<PresetField
        legend="Tracking"
        hint="Body letter-spacing. A geometric sans usually wants a hair less; a mono wants none."
        value={base.tracking}
        options={TRACKING_OPTIONS}
        onChange={(id) => onChange({ tracking: id })}
        renderSwatch={(id) => (
          <span
            className="block text-xs leading-5 font-medium opacity-70"
            style={{ letterSpacing: TRACKING_PRESETS.find((p) => p.id === id)?.value }}
          >
            Aa
          </span>
        )}
      />
    </>
  )
}

export function ShapeSection({ base, onChange }: SectionProps) {
  return (
    <>
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
        legend="Composer corner"
        hint="The message box's own corner and padding, relative to Shape. It grows tall and wide, so it is capped."
        value={base.composer ?? "default"}
        options={COMPOSER_OPTIONS}
        onChange={(id) => onChange({ composer: id })}
        renderSwatch={(id) => {
          const preset = COMPOSER_PRESETS.find((p) => p.id === id)
          return (
            <span
              className="block h-5 w-9 border-2 border-current opacity-70"
              style={{
                // Halved: the swatch is a small drawing of the corner, not the corner.
                borderRadius: Math.min(radiusPx(base.radius) * Number(preset?.mult ?? 1.8), remPx(preset?.cap ?? "1.5rem")) / 2,
              }}
            />
          )
        }}
      />
    </>
  )
}

export function SurfacesSection({ base, onChange }: SectionProps) {
  return (
    <>
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
        legend="Edge"
        hint="The hairline round cards, menus and the composer. Unset, it follows Depth: the less shadow, the stronger the edge."
        value={base.edge}
        options={EDGE_OPTIONS}
        onChange={(id) => onChange({ edge: id })}
        renderSwatch={(id) => (
          <span
            className="block size-5 rounded-md bg-card"
            style={{
              boxShadow: `0 0 0 1px color-mix(in oklch, var(--foreground) ${EDGE_PRESETS.find((p) => p.id === id)?.value ?? "10%"}, transparent)`,
            }}
          />
        )}
      />

<PresetField
        legend="Frame"
        hint="How far the shell's tint sits off the page — the band behind the cards, under the status bar and past an overscroll."
        value={base.ground ?? "default"}
        options={GROUND_OPTIONS}
        onChange={(id) => onChange({ ground: id })}
        renderSwatch={(id) => (
          <span
            className="flex size-5 items-center justify-center rounded-md"
            style={
              {
                "--app-ground-step": GROUND_PRESETS.find((p) => p.id === id)?.value ?? "1",
                background: "var(--app-ground)",
              } as React.CSSProperties
            }
          >
            <span className="block size-3 rounded-sm border bg-card" />
          </span>
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
              className="absolute inset-x-0 bottom-0 h-1/2 border-t bg-card/50"
              style={{
                backdropFilter: `blur(${BLUR_PRESETS.find((p) => p.id === id)?.value ?? "0px"})`,
              }}
            />
          </span>
        )}
      />

      {/* Opacity is the other half of Glass: the blur says how much the page is
          softened, this says how much of it shows. Unset, it is the blur's own
          pairing (None is solid, Medium is clear). */}
      <PresetField
        legend="Opacity"
        hint="How see-through frosted surfaces are. Unset, it follows Glass: no blur means solid."
        value={base.solid ?? solidIdFor(base.blur)}
        options={SOLID_OPTIONS}
        onChange={(id) => onChange({ solid: id })}
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
              className="absolute inset-x-0 bottom-0 h-1/2 border-t bg-card"
              style={{
                opacity: 0.5 + 0.5 * Number(SOLID_PRESETS.find((p) => p.id === id)?.value ?? 0),
              }}
            />
          </span>
        )}
      />

<PresetField
        legend="Vibrancy"
        hint="How much colour the page lifts through frosted surfaces. Needs Glass — a theme with no blur has no backdrop to saturate."
        value={base.vibrancy ?? "default"}
        options={VIBRANCY_OPTIONS}
        onChange={(id) => onChange({ vibrancy: id })}
        renderSwatch={(id) => (
          <span className="relative block size-5 overflow-hidden rounded-md">
            <span
              className="absolute inset-0"
              style={{
                background:
                  "repeating-linear-gradient(45deg, var(--primary) 0 3px, var(--destructive) 3px 6px)",
              }}
            />
            <span
              className="absolute inset-x-0 bottom-0 h-1/2 border-t bg-card/40"
              style={{
                backdropFilter: `blur(4px) saturate(calc(1.3 * ${VIBRANCY_PRESETS.find((p) => p.id === id)?.value ?? "1"}))`,
              }}
            />
          </span>
        )}
      />
    </>
  )
}

export function LayoutSection({ base, onChange }: SectionProps) {
  return (
    <>
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
        legend="Density"
        hint="Paddings and gaps, as the theme's own. The UI scale in Appearance still applies on top."
        value={base.density ?? "default"}
        options={DENSITY_OPTIONS}
        onChange={(id) => onChange({ density: id })}
        renderSwatch={(id) => {
          const gap = 2 * Number(DENSITY_PRESETS.find((p) => p.id === id)?.value ?? 1)
          return (
            <span className="flex flex-col items-stretch" style={{ gap: `${gap}px` }}>
              {[0, 1, 2].map((i) => (
                <span key={i} className="block h-1 w-6 rounded-pill bg-current opacity-50" />
              ))}
            </span>
          )
        }}
      />
    </>
  )
}

/** A row of mutually exclusive presets, each drawing a small live sample of
    what it does — a radius as a corner and a capsule, a depth as a lifted chip,
    a blur as an actual blur over a pattern. The names alone ("Soft", "Deep")
    do not tell you what you are choosing. */
export function PresetField({
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
    <Group label={legend} hint={hint}>
      <ChoiceTiles
        label={legend}
        value={value ?? ""}
        onChange={onChange}
        choices={options.map((option) => ({
          value: option.id,
          label: option.label,
          preview: (
            <span title={option.hint} className="flex h-5 items-center justify-center">
              {renderSwatch(option.id)}
            </span>
          ),
        }))}
      />
    </Group>
  )
}
