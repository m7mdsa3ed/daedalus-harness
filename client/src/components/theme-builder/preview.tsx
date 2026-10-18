/* ── Drawing a theme, never editing one ──
   The two previews plus the light/dark vocabulary the rest of the studio is
   written in. `ThemePreview` is the gallery swatch; `ThemeMock` is the studio's
   live mock of the app and `PreviewPane` the column it sits in. Nothing here
   writes a theme — everything is handed one and paints it. */
import * as React from "react"

import { Segmented } from "@/components/settings/primitives"
import { themeStyleVars, type CustomTheme } from "@/lib/custom-themes"
import { useTheme } from "@/lib/theme"
import { cn } from "@/lib/utils"

export type Mode = "light" | "dark"
export const MODES: readonly Mode[] = ["light", "dark"]

/** The gallery swatch: both modes stacked, reading the theme's real tokens.
    It carries an `Aa` in the theme's own heading face, a capsule in its own
    `rounded-pill` and chips in its own `--radius`, because those are now the
    things that separate one theme from another — twelve swatches that differed
    only in hue were most of the reason this was worth rebuilding. */
export function ThemePreview({ themeValue }: { themeValue: string }) {
  return (
    <div aria-hidden className="overflow-hidden rounded-lg border border-border/60">
      {MODES.map((mode) => (
        <div
          key={mode}
          data-color-theme={themeValue}
          className={cn(
            "flex items-center gap-1 bg-background p-1 font-sans",
            mode === "dark" && "dark"
          )}
        >
          <span className="flex h-8 w-6 shrink-0 items-center justify-center rounded-md bg-muted font-heading text-[10px] leading-none font-medium text-muted-foreground">
            Aa
          </span>
          <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
            <span className="h-0.5 w-4/5 rounded-full bg-foreground/65" />
            <span className="h-0.5 w-3/5 rounded-full bg-muted-foreground" />
            <span className="mt-0.5 flex items-center gap-1">
              <span className="h-1.5 w-3 rounded-sm bg-primary" />
              <span className="h-1.5 w-4 rounded-pill bg-accent" />
            </span>
          </span>
        </div>
      ))}
    </div>
  )
}

/* ── The preview ──
   A mock of the actual app, not a swatch grid: sidebar, header, a turn of
   transcript, a tool card, a chart strip, the composer and a control row. Every
   one of those is drawn with the real utilities — `rounded-*`, `shadow-glass`,
   `font-heading`, `font-mono`, `bg-composer` — so a shape, depth or typeface
   choice shows up here exactly as it will in the app. It is the reason a
   `rounded-pill` badge next to a square card is catchable while you are still
   editing rather than after you wear the theme.

   Drawn from inline vars rather than from the stylesheet, so it reflects the
   draft before it is saved. */
function ThemeMock({ theme, mode }: { theme: CustomTheme; mode: Mode }) {
  return (
    <div
      aria-hidden
      style={themeStyleVars(theme, mode) as React.CSSProperties}
      className={cn(
        "overflow-hidden rounded-xl border border-border bg-background font-sans tracking-[var(--app-tracking)]",
        mode === "dark" && "dark"
      )}
    >
      {/* Short where the pane is a sticky bar over the controls — it has to
          leave the screen it is pinned to usable — and full height once it has
          a column of its own. */}
      <div className="flex h-36 @panel-lg:h-56">
        {/* Sidebar */}
        <div className="flex w-[30%] shrink-0 flex-col gap-1 border-r border-sidebar-border bg-sidebar p-1.5">
          <div className="flex items-center gap-1 px-0.5 py-1">
            <span className="size-3 shrink-0 rounded-sm bg-sidebar-primary" />
            <span className="h-1.5 w-10 rounded-full bg-sidebar-foreground/70" />
          </div>
          <span className="flex h-4 items-center rounded-md bg-sidebar-accent px-1">
            <span className="h-1 w-8 rounded-full bg-sidebar-accent-foreground/70" />
          </span>
          <span className="flex h-4 items-center px-1">
            <span className="h-1 w-10 rounded-full bg-sidebar-foreground/35" />
          </span>
          <span className="mt-1 px-1 text-[7px] leading-none tracking-wide text-sidebar-foreground/45 uppercase">
            Recents
          </span>
          {[10, 7, 9].map((w, i) => (
            <span key={i} className="flex h-3.5 items-center px-1">
              <span
                className="h-1 rounded-full bg-sidebar-foreground/30"
                style={{ width: `${w * 6}%` }}
              />
            </span>
          ))}
        </div>

        {/* Main */}
        <div className="flex min-w-0 flex-1 flex-col bg-surface">
          <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
            <span className="truncate font-heading text-[10px] leading-none font-medium text-foreground">
              Heading
            </span>
            <span className="rounded-pill bg-muted px-1.5 py-px text-[7px] leading-3 text-muted-foreground">
              badge
            </span>
            <span className="ml-auto size-1.5 rounded-full bg-primary" />
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-hidden p-2">
            {/* user turn */}
            <div className="ml-auto w-[70%] rounded-2xl bg-muted px-2 py-1.5">
              <span className="block h-1 w-full rounded-full bg-muted-foreground/70" />
              <span className="mt-1 block h-1 w-2/3 rounded-full bg-muted-foreground/70" />
            </div>
            {/* assistant prose */}
            <span className="block h-1 w-full rounded-full bg-foreground/35" />
            <span className="block h-1 w-[88%] rounded-full bg-foreground/35" />
            {/* tool card */}
            <div className="rounded-xl border border-border bg-card p-1.5 shadow-glass">
              <span className="block font-mono text-[8px] leading-none text-card-foreground/75">
                $ 0123 · run
              </span>
              <div className="mt-1 flex gap-0.5">
                {[1, 2, 3, 4, 5].map((n) => (
                  <span
                    key={n}
                    className="h-1 flex-1 rounded-pill"
                    style={{ background: `var(--chart-${n})` }}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* composer + controls */}
          <div className="p-2 pt-0">
            <div className="rounded-composer bg-composer p-1.5 shadow-glass-lg">
              <span className="block h-1 w-1/2 rounded-full bg-foreground/25" />
              <div className="mt-1.5 flex items-center gap-1">
                <span className="h-4 flex-1 rounded-md border border-input" />
                <span className="grid h-4 w-8 place-items-center rounded-md bg-primary text-[7px] leading-none font-medium text-primary-foreground">
                  Send
                </span>
                <span className="size-4 rounded-md bg-destructive" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

type PreviewMode = "both" | Mode
const PREVIEW_MODES: readonly { id: PreviewMode; label: string }[] = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "both", label: "Both" },
]

export function PreviewPane({
  theme,
  worn,
}: {
  theme: CustomTheme
  worn: boolean
}) {
  const { resolved } = useTheme()
  // Opens on the mode you are actually in — the half you can compare against
  // the app around it — and remembers nothing, because the answer changes with
  // the mode and a stale pick is a preview of the wrong half.
  const [preview, setPreview] = React.useState<PreviewMode>(resolved)
  const shown: Mode[] = preview === "both" ? [...MODES] : [preview]

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <p className="hidden text-xs font-medium @panel-lg:block">Preview</p>
        <Segmented
          label="Preview mode"
          value={preview}
          onChange={setPreview}
          options={PREVIEW_MODES.map(({ id, label }) => ({ value: id, label }))}
          className="ml-auto"
        />
      </div>

      {/* Both modes stack in the column and sit side by side in the bar: two
          full-width mocks pinned over a phone would be most of the screen. */}
      <div
        className={cn(
          "grid gap-2",
          preview === "both" && "grid-cols-2 @panel-lg:grid-cols-1"
        )}
      >
        {shown.map((mode) => (
          <div key={mode} className="space-y-1">
            {preview === "both" && (
              <p className="px-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                {mode}
              </p>
            )}
            <ThemeMock theme={theme} mode={mode} />
          </div>
        ))}
      </div>

      <p className="hidden text-[11px] text-muted-foreground @panel-lg:block">
        Changes apply immediately
        {worn ? " — you are wearing this theme" : ""}.
      </p>
    </div>
  )
}
