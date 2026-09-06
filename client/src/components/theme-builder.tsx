/* ── Theme gallery + studio ──
   The gallery is every theme the app knows: the built-ins from
   styles/themes.css and whatever the user has made.

   The studio edits one of those, in two columns: the controls on the left, a
   **live mock of the app** on the right, sticky, in both modes at once. That
   layout is the whole point. A theme is thirty-odd colours plus a shape, a
   depth, three typefaces and a measure, and none of those can be judged from
   the control that sets them — a radius is a number until you see it on a
   badge next to a card next to an input, and a font pairing is two names until
   you see a heading sitting above body text. The old single column put the
   samples above the fold and the tokens below it, so every edit was made
   blind and verified by scrolling.

   Three tabs, ordered the way a theme is actually made:
   - **Presets** — start from a coordinated whole. A style preset sets the
     entire Design half at once; a palette preset (or the hue/chroma/tint
     sliders) regenerates every colour through the same ramp the built-in
     themes are generated from.
   - **Design** — the mode-independent half: type, shape, depth, glass, measure.
   - **Color** — the light/dark pair, edited together, because editing one
     blind is how you end up with a theme that only works after dark.

   Edits write through on every change, so if you are wearing the theme you are
   editing the whole app repaints under the picker. "Revert" restores the
   snapshot taken on open, which is the undo that live editing owes you. */
import * as React from "react"
import {
  Check,
  Copy,
  Palette,
  Pencil,
  Plus,
  RotateCcw,
  Shuffle,
  Trash2,
  TriangleAlert,
  Type,
} from "lucide-react"
import { Navigate, useNavigate, useParams } from "react-router"
import { useConfirm } from "@/components/confirm-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ButtonGroup, ButtonGroupSeparator } from "@/components/ui/button-group"
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Item, ItemActions, ItemContent, ItemGroup, ItemTitle } from "@/components/ui/item"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  BLUR_PRESETS,
  contrastRatio,
  CONTRAST_PAIRS,
  customThemeId,
  customThemeValue,
  DEPTH_PRESETS,
  FONT_SLOTS,
  isCustomTheme,
  loadCustomThemes,
  MIN_CONTRAST,
  PALETTE_PRESETS,
  paletteFromSpec,
  RADIUS_PRESETS,
  saveCustomThemes,
  seedTheme,
  STYLE_PRESETS,
  themeStyleVars,
  THEME_TOKEN_GROUPS,
  TRACKING_PRESETS,
  WIDTH_PRESETS,
  type BaseTokens,
  type CustomTheme,
  type RampSpec,
  type ThemeTokens,
} from "@/lib/custom-themes"
import { COLOR_SCHEMES, schemePalette, type ColorScheme } from "@/lib/color-schemes"
import {
  FONT_CATALOG,
  fontLabel,
  fontStack,
  googleFontFamily,
  googleFontId,
  isGoogleFont,
  type FontCategory,
  type FontRole,
} from "@/lib/fonts"
import { BUILTIN_THEMES, useCustomThemes, useTheme } from "@/lib/theme"
import { cn } from "@/lib/utils"
import { settingsPath } from "@/lib/router"
import { FormPageHeader } from "@/components/settings/primitives"

type Mode = "light" | "dark"
const MODES: readonly Mode[] = ["light", "dark"]

export function ThemeGallery() {
  const { colorTheme, setColorTheme } = useTheme()
  const customThemes = useCustomThemes()
  const navigate = useNavigate()

  /** New themes are copies — of the theme you are wearing, so "New theme"
      always starts from something you already like rather than from grey. */
  const create = (seedFrom: string) => {
    const theme = createTheme(seedFrom, customThemes)
    saveCustomThemes([...customThemes, theme])
    setColorTheme(customThemeValue(theme.id))
    void navigate(`/settings/appearance/themes/${encodeURIComponent(theme.id)}`)
  }

  return (
    <div className="grid grid-cols-2 gap-2 p-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {BUILTIN_THEMES.map(({ value, label, note }) => (
        <ThemeCard
          key={value}
          label={label}
          note={note}
          themeValue={value}
          selected={colorTheme === value}
          onSelect={() => setColorTheme(value)}
        />
      ))}
      {customThemes.map((theme) => {
        const value = customThemeValue(theme.id)
        return (
          <ThemeCard
            key={theme.id}
            label={theme.name}
            themeValue={value}
            selected={colorTheme === value}
            onSelect={() => setColorTheme(value)}
            onEdit={() => {
              setColorTheme(value)
              void navigate(`/settings/appearance/themes/${encodeURIComponent(theme.id)}`)
            }}
          />
        )
      })}
      <button
        type="button"
        onClick={() => create(colorTheme)}
        title="Copy the current theme into a new editable one"
        className="flex min-h-24 flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed text-xs font-medium text-muted-foreground transition-colors hover:border-ring/60 hover:bg-accent/40 hover:text-foreground"
      >
        <Plus className="size-4" />
        New theme
      </button>
    </div>
  )
}

function createTheme(seedFrom: string, customThemes: CustomTheme[]): CustomTheme {
  const source = isCustomTheme(seedFrom)
    ? customThemes.find((entry) => entry.id === customThemeId(seedFrom))
    : undefined
  const seeded = seedTheme(nextName(customThemes), source ? "default" : seedFrom)
  return source
    ? {
        ...seeded,
        light: { ...source.light },
        dark: { ...source.dark },
        base: { ...source.base },
      }
    : seeded
}

export function ThemeEditorPage() {
  const { themeId } = useParams()
  const navigate = useNavigate()
  const customThemes = useCustomThemes()
  const { setColorTheme } = useTheme()
  if (!themeId || !customThemes.some((theme) => theme.id === themeId)) {
    return <Navigate to={settingsPath("appearance")} replace />
  }
  return (
    <ThemeEditor
      themeId={themeId}
      onClose={() => void navigate(settingsPath("appearance"))}
      onDuplicate={(id) => {
        const theme = createTheme(customThemeValue(id), customThemes)
        saveCustomThemes([...customThemes, theme])
        setColorTheme(customThemeValue(theme.id))
        void navigate(`/settings/appearance/themes/${encodeURIComponent(theme.id)}`, {
          replace: true,
        })
      }}
    />
  )
}

function nextName(themes: CustomTheme[]): string {
  const used = new Set(themes.map((theme) => theme.name))
  for (let n = 1; ; n++) {
    const name = n === 1 ? "My theme" : `My theme ${n}`
    if (!used.has(name)) return name
  }
}

function ThemeCard({
  label,
  note,
  themeValue,
  selected,
  onSelect,
  onEdit,
}: {
  label: string
  /** What the theme is past its hue — its shape, type and depth in one line.
      Built-ins carry one (generated with them); a user-made theme does not,
      because it has no author but the person reading the card. */
  note?: string
  themeValue: string
  selected: boolean
  onSelect: () => void
  onEdit?: () => void
}) {
  return (
    <div
      className={cn(
        "group/theme relative rounded-xl border p-1.5 transition-colors",
        selected
          ? "border-ring bg-accent text-accent-foreground ring-2 ring-ring/25"
          : "border-transparent text-muted-foreground hover:border-border hover:bg-accent/50"
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        title={note}
        className="flex w-full flex-col gap-1.5 text-left text-xs font-medium"
      >
        <ThemePreview themeValue={themeValue} />
        <span className="flex items-center gap-1 px-0.5">
          <span className="truncate">{label}</span>
          {selected && <Check className="ml-auto size-3 shrink-0 opacity-70" />}
        </span>
      </button>
      {onEdit && (
        <Button
          variant="ghost"
          size="icon-sm"
          title={`Edit ${label}`}
          onClick={onEdit}
          className="absolute top-2 right-2 bg-card/70 opacity-0 backdrop-blur transition-opacity group-hover/theme:opacity-100 focus-visible:opacity-100"
        >
          <Pencil />
        </Button>
      )}
    </div>
  )
}

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
      <div className="flex h-56">
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
            <div className="rounded-2xl bg-composer p-1.5 shadow-glass-lg">
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

function PreviewPane({
  theme,
  warnings,
  worn,
}: {
  theme: CustomTheme
  warnings: number
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
        <p className="text-xs font-medium">Preview</p>
        <div className="ml-auto flex rounded-lg bg-muted p-0.5">
          {PREVIEW_MODES.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              aria-pressed={preview === id}
              onClick={() => setPreview(id)}
              className={cn(
                "rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors",
                preview === id
                  ? "bg-background text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2">
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

      <p className="text-[11px] text-muted-foreground">
        Changes apply immediately
        {worn ? " — you are wearing this theme" : ""}.
      </p>
      {warnings > 0 && (
        <Badge variant="destructive" className="w-fit">
          <TriangleAlert />
          {warnings} pair{warnings === 1 ? "" : "s"} below AA
        </Badge>
      )}
    </div>
  )
}

function ThemeEditor({
  themeId,
  onClose,
  onDuplicate,
}: {
  themeId: string
  onClose: () => void
  onDuplicate: (id: string) => void
}) {
  const customThemes = useCustomThemes()
  const { setColorTheme, colorTheme } = useTheme()
  const confirm = useConfirm()
  // The state to restore on Revert — taken once, when this theme is opened.
  const snapshot = React.useRef<CustomTheme | null>(null)
  const theme = customThemes.find((entry) => entry.id === themeId) ?? null

  React.useEffect(() => {
    snapshot.current = themeId
      ? (loadCustomThemes().find((entry) => entry.id === themeId) ?? null)
      : null
  }, [themeId])

  const write = (next: CustomTheme) =>
    saveCustomThemes(customThemes.map((entry) => (entry.id === next.id ? next : entry)))

  const setToken = (mode: Mode, token: string, value: string) => {
    if (!theme) return
    write({ ...theme, [mode]: { ...theme[mode], [token]: value } })
  }

  const setBase = (patch: BaseTokens) => {
    if (!theme) return
    write({ ...theme, base: { ...theme.base, ...patch } })
  }

  /** A generated palette *replaces* the colours and leaves the Design half
      alone — a hue and a font pairing are independent decisions, and
      regenerating one must not silently reset the other. */
  const setPalette = (spec: RampSpec) => {
    if (!theme) return
    const { light, dark } = paletteFromSpec(spec)
    write({ ...theme, light: { ...theme.light, ...light }, dark: { ...theme.dark, ...dark } })
  }

  /** A curated scheme is the exception: it sets the Design half too. Gruvbox
      under a geometric sans with capsule badges is not Gruvbox — the shape and
      the type are as much of the identity as the browns. Everything it writes
      stays editable on the other two tabs, and Revert undoes the whole thing at
      once, which is why this can afford to be opinionated. */
  const applyScheme = (scheme: ColorScheme) => {
    if (!theme) return
    write({
      ...theme,
      light: { ...theme.light, ...schemePalette(scheme.light) },
      dark: { ...theme.dark, ...schemePalette(scheme.dark) },
      base: { ...theme.base, ...scheme.design },
    })
  }

  const remove = async () => {
    if (!theme) return
    const ok = await confirm({
      title: `Delete "${theme.name}"?`,
      description: "The theme is removed from this device. Themes are not synced.",
      confirmLabel: "Delete",
      destructive: true,
    })
    if (!ok) return
    saveCustomThemes(customThemes.filter((entry) => entry.id !== theme.id))
    onClose()
  }

  const warnings = theme ? countWarnings(theme) : 0
  const worn = !!theme && colorTheme === customThemeValue(theme.id)

  if (!theme) return null

  return (
    <>
      <FormPageHeader
        title={`Edit ${theme.name}`}
        description="Type, shape and colour, for light and dark together. Changes apply immediately on this device."
        onBack={onClose}
      />

      {/* The preview column grows with the frame rather than staying a fixed
          thumbnail: this page runs at the settings frame's full width
          (settingsMaxWidth in settings/sections.ts), and the mock is the half
          that benefits from it. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] lg:items-start xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] 2xl:grid-cols-[minmax(0,1fr)_minmax(0,32rem)] 2xl:gap-6">
        {/* Controls */}
        <div className="flex min-w-0 flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="theme-name">Name</FieldLabel>
            <Input
              id="theme-name"
              value={theme.name}
              onChange={(event) => write({ ...theme, name: event.target.value })}
            />
          </Field>

          <Tabs defaultValue="presets">
            <TabsList className="w-full">
              <TabsTrigger value="presets">Presets</TabsTrigger>
              <TabsTrigger value="design">Design</TabsTrigger>
              <TabsTrigger value="color">Color</TabsTrigger>
            </TabsList>

            <TabsContent value="presets" className="flex flex-col gap-4 pt-3">
              <PresetsTab
                base={theme.base}
                onBase={setBase}
                onPalette={setPalette}
                onScheme={applyScheme}
              />
            </TabsContent>

            <TabsContent value="design" className="flex flex-col gap-4 pt-3">
              <DesignTab base={theme.base} onChange={setBase} />
            </TabsContent>

            {/* Two columns of token groups only once the controls column can
                hold a label plus both mode fields twice over (~350px each);
                below that the pair wraps, and the light/dark comparison is the
                one thing this grid exists for. */}
            <TabsContent value="color" className="grid items-start gap-4 pt-3 2xl:grid-cols-2">
              {THEME_TOKEN_GROUPS.map((group) => (
                <FieldSet key={group.label} className="gap-3">
                  <div className="flex items-end justify-between gap-3">
                    <div className="min-w-0">
                      <FieldLegend variant="label" className="mb-0 text-xs">
                        {group.label}
                      </FieldLegend>
                      <FieldDescription className="text-[11px]">{group.hint}</FieldDescription>
                    </div>
                    {/* Column headers, once per group: the two fields on every
                        row below are the same token in the two modes. */}
                    <div className="hidden shrink-0 gap-2 text-[11px] tracking-wide text-muted-foreground uppercase sm:flex">
                      {MODES.map((mode) => (
                        <span key={mode} className="w-32 text-center">
                          {mode}
                        </span>
                      ))}
                    </div>
                  </div>
                  <ItemGroup className="gap-0.5 rounded-xl border p-1">
                    {group.tokens.map(({ token, label }) => (
                      <Item key={token} size="xs" className="gap-2 rounded-lg py-1.5">
                        <ItemContent>
                          <ItemTitle className="text-xs font-normal" title={`--${token}`}>
                            {label}
                          </ItemTitle>
                        </ItemContent>
                        <ItemActions className="gap-2">
                          {MODES.map((mode) => (
                            <TokenField
                              key={mode}
                              mode={mode}
                              token={token}
                              tokens={theme[mode]}
                              onChange={(value) => setToken(mode, token, value)}
                            />
                          ))}
                        </ItemActions>
                      </Item>
                    ))}
                  </ItemGroup>
                </FieldSet>
              ))}
            </TabsContent>
          </Tabs>

          <footer className="flex flex-wrap items-center gap-2 border-t pt-4">
            <ButtonGroup>
              <Button
                variant="outline"
                size="sm"
                disabled={!snapshot.current}
                title="Undo every change made since this editor was opened"
                onClick={() => snapshot.current && write(snapshot.current)}
              >
                <RotateCcw /> Revert
              </Button>
              <Button variant="outline" size="sm" onClick={() => onDuplicate(theme.id)}>
                <Copy /> Duplicate
              </Button>
              {!worn && (
                <>
                  <ButtonGroupSeparator />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setColorTheme(customThemeValue(theme.id))}
                  >
                    <Palette /> Apply
                  </Button>
                </>
              )}
            </ButtonGroup>
            <Button variant="ghost" size="sm" className="text-destructive" onClick={remove}>
              <Trash2 /> Delete
            </Button>
            <Button size="sm" className="ml-auto" onClick={onClose}>
              <Check /> Done
            </Button>
          </footer>
        </div>

        {/* Preview. First on a phone (there is one column, and the thing being
            described should precede the controls that describe it); beside the
            controls and sticky from lg up, where it can stay in view for the
            whole length of the Color tab. */}
        <aside className="order-first min-w-0 lg:order-none lg:sticky lg:top-2 lg:max-h-[calc(var(--panel-h,100svh)-1rem)] lg:overflow-y-auto lg:pb-2">
          <PreviewPane theme={theme} warnings={warnings} worn={worn} />
        </aside>
      </div>
    </>
  )
}

/* ── Presets tab ── */

const HUE_TRACK =
  "linear-gradient(to right, oklch(0.7 0.16 0), oklch(0.7 0.16 60), oklch(0.7 0.16 120), oklch(0.7 0.16 180), oklch(0.7 0.16 240), oklch(0.7 0.16 300), oklch(0.7 0.16 360))"

function PresetsTab({
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
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
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
        <div className="grid gap-1.5 sm:grid-cols-2">
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

/* ── Design tab ──
   Everything that is one choice for the whole theme rather than one per mode.
   A key absent from `base` means "inherit the app default", which is what a
   theme saved before any of this existed carries — so every control here
   offers an explicit choice equivalent to that default and none writes on
   mount. */
function DesignTab({
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
        options={RADIUS_PRESETS.map((p) => ({ id: p.id, label: p.label }))}
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
        options={DEPTH_PRESETS.map((p) => ({ id: p.id, label: p.label, hint: p.hint }))}
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
        options={BLUR_PRESETS.map((p) => ({ id: p.id, label: p.label, hint: p.hint }))}
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
        options={WIDTH_PRESETS.map((p) => ({ id: p.id, label: p.label, hint: p.hint }))}
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
        options={TRACKING_PRESETS.map((p) => ({ id: p.id, label: p.label }))}
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

const CATEGORY_LABEL: Record<FontCategory, string> = {
  sans: "Sans",
  serif: "Serif",
  mono: "Mono",
}
const CATEGORY_ORDER: readonly FontCategory[] = ["sans", "serif", "mono"]

/** Bundled families in a grouped select, plus a free-text escape to Google
    Fonts. The two are one control because they answer one question, and the
    text field only appears once "Google Fonts" is chosen — an always-visible
    second input reads as a second, competing choice.

    Every row is drawn in the face it names, which is the only honest preview
    of a typeface and costs nothing for the bundled ones. */
function FontPicker({
  value,
  role,
  onChange,
}: {
  value: string | undefined
  role: FontRole
  onChange: (value: string) => void
}) {
  const custom = !!value && isGoogleFont(value)
  const [draft, setDraft] = React.useState(custom ? googleFontFamily(value) : "")
  // `custom` is a mode, not a stored value: it is entered by picking the
  // sentinel and left by picking any real family, so it has to survive the
  // moment the field is empty and the theme still says "google:".
  const [showCustom, setShowCustom] = React.useState(custom)
  React.useEffect(() => {
    if (custom) {
      setDraft(googleFontFamily(value))
      setShowCustom(true)
      return
    }
    // A real family arriving from outside — Revert, a style preset, another tab
    // — closes the custom field. An *empty* value does not: that is what a
    // half-typed family name stores, and closing the field under the caret is
    // worse than showing it for a theme that currently names nothing.
    if (value) setShowCustom(false)
  }, [custom, value])

  const select = (next: string | null) => {
    if (next === null) return
    if (next === CUSTOM_SENTINEL) {
      setShowCustom(true)
      if (draft.trim()) onChange(googleFontId(draft))
      return
    }
    setShowCustom(false)
    // Both sentinels are the select's own vocabulary and neither is a font id
    // — writing one through would store `__default__` as the theme's family.
    onChange(next === DEFAULT_SENTINEL ? DEFAULT_VALUE : next)
  }

  return (
    <div className="flex w-40 shrink-0 flex-col gap-1.5">
      <Select
        value={showCustom ? CUSTOM_SENTINEL : (value ?? DEFAULT_SENTINEL)}
        onValueChange={select}
      >
        <SelectTrigger size="sm" className="w-full">
          <SelectValue>
            <span style={{ fontFamily: fontStack(value, role) }} className="truncate">
              {fontLabel(value)}
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT_SENTINEL}>Default</SelectItem>
          {CATEGORY_ORDER.map((category) => (
            <SelectGroup key={category}>
              <SelectLabel>{CATEGORY_LABEL[category]}</SelectLabel>
              {FONT_CATALOG.filter((font) => font.category === category).map((font) => (
                <SelectItem key={font.id} value={font.id}>
                  <span style={{ fontFamily: fontStack(font.id, role) }}>{font.label}</span>
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
          <SelectGroup>
            <SelectLabel>Other</SelectLabel>
            <SelectItem value={CUSTOM_SENTINEL}>
              <Type className="size-3.5" />
              Google Fonts…
            </SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
      {showCustom && (
        <Input
          value={draft}
          spellCheck={false}
          placeholder="Family name"
          aria-label="Google Fonts family name"
          onChange={(event) => {
            setDraft(event.target.value)
            // Written through on every keystroke like every other control here;
            // an empty field falls back to the app default rather than to
            // `google:` with nothing after it, which resolves to nothing.
            onChange(event.target.value.trim() ? googleFontId(event.target.value) : DEFAULT_VALUE)
          }}
          className="h-7 text-[11px]"
        />
      )}
    </div>
  )
}

/* `""` is the stored form of "inherit the app default" — `baseDeclarations`
   skips falsy values, so it emits no declaration at all. The select needs a
   non-empty string to represent it, since Base UI reads `""` as "no value". */
const DEFAULT_VALUE = ""
const DEFAULT_SENTINEL = "__default__"
const CUSTOM_SENTINEL = "__google__"

function countWarnings(theme: CustomTheme): number {
  return MODES.reduce(
    (total, mode) =>
      total +
      Object.entries(CONTRAST_PAIRS).filter(([foreground, surface]) => {
        const a = theme[mode][foreground]
        const b = theme[mode][surface]
        return a && b && contrastRatio(a, b) < MIN_CONTRAST
      }).length,
    0
  )
}

/** One swatch + hex for one token in one mode. The picker is for exploring, the
    hex field for pasting a value you already have; both write the same string. */
function TokenField({
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
      className={cn("h-7 w-32 shrink-0 rounded-lg", failing && "border-destructive/70")}
    >
      {/* The swatch is the addon: one control, two ways in — pick or paste. */}
      <InputGroupAddon className="pl-1.5">
        <input
          type="color"
          aria-label={`${token} (${mode})`}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="size-4.5 cursor-pointer appearance-none rounded border-0 bg-transparent p-0 [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded [&::-webkit-color-swatch]:border-0"
        />
      </InputGroupAddon>
      <InputGroupInput
        value={draft}
        onChange={(event) => commit(event.target.value)}
        onBlur={() => setDraft(value)}
        spellCheck={false}
        aria-label={`${token} hex (${mode})`}
        className="h-7 px-0 text-right font-mono text-[11px] tabular-nums"
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
