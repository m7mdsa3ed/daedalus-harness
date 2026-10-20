/* ── The studio ──
   The route (`ThemeEditorPage`) and the editor itself: two columns, controls on
   the left and the live mock on the right, sticky, in both modes at once. That
   layout is the whole point. A theme is thirty-odd colours plus a shape, a
   depth, three typefaces and a measure, and none of those can be judged from
   the control that sets them — a radius is a number until you see it on a
   badge next to a card next to an input, and a font pairing is two names until
   you see a heading sitting above body text. The old single column put the
   samples above the fold and the tokens below it, so every edit was made
   blind and verified by scrolling.

   Three columns once there is room — a section nav, the controls of one
   section, and the live mock — and a row of chips over the controls below that.
   The sections are ordered the way a theme is actually made:
   - **Presets** — start from a coordinated whole. A style preset sets the
     entire Design half at once; a palette preset (or the hue/chroma/tint
     sliders) regenerates every colour through the palette ramp.
   - **Type**, **Shape**, **Surfaces**, **Layout** — the mode-independent half,
     one section each (design-tab.tsx).
   - **Color** — the light/dark pair, edited together, because editing one
     blind is how you end up with a theme that only works after dark.

   This file owns every write: `write` is the one door to `saveCustomThemes`,
   and every tab is handed a callback rather than the theme's setter. Edits
   write through on every change, so if you are wearing the theme you are
   editing the whole app repaints under the picker. "Revert" restores the
   snapshot taken on open, which is the undo that live editing owes you.

   Themes are not device-local any more: the store write-through also reaches
   the server (`lib/custom-theme-sync`), so a saved theme follows the account
   and not the browser — the chip in the header reports whether the server has
   the latest edit. */
import * as React from "react"
import {
  Check,
  CloudOff,
  CloudUpload,
  Copy,
  Layers,
  Palette,
  RotateCcw,
  Ruler,
  Sparkles,
  SquareRoundCorner,
  Trash2,
  TriangleAlert,
  Type,
  type LucideIcon,
} from "lucide-react"
import { Navigate, useNavigate, useParams } from "react-router"

import { useConfirm } from "@/components/confirm-dialog"
import { FormPageHeader, TabBar, type TabItem } from "@/components/settings/primitives"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ButtonGroup, ButtonGroupSeparator } from "@/components/ui/button-group"
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Item, ItemActions, ItemContent, ItemGroup, ItemTitle } from "@/components/ui/item"
import { subscribeSyncStatus, syncStatusSnapshot, type SyncStatus } from "@/lib/custom-theme-sync"
import {
  contrastRatio,
  CONTRAST_PAIRS,
  customThemeValue,
  loadCustomThemes,
  MIN_CONTRAST,
  paletteFromSpec,
  saveCustomThemes,
  THEME_TOKEN_GROUPS,
  type BaseTokens,
  type CustomTheme,
  type RampSpec,
} from "@/lib/custom-themes"
import { settingsPath } from "@/lib/router"
import { useCustomThemes, useTheme } from "@/lib/theme"
import { cn } from "@/lib/utils"

import { LayoutSection, ShapeSection, SurfacesSection, TypeSection } from "./design-tab"
import { createTheme } from "./gallery"
import { MODES, PreviewPane, type Mode } from "./preview"
import { PresetsTab } from "./presets-tab"
import { TokenField } from "./token-field"

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

const SYNC_CHIP: Record<
  SyncStatus,
  { title: string; hint: string; variant: "secondary" | "outline" | "destructive" }
> = {
  synced: {
    title: "Saved",
    hint: "Every change is saved to this server, so the theme follows the account and not the browser.",
    variant: "secondary",
  },
  syncing: {
    title: "Saving…",
    hint: "Writing your changes to the server.",
    variant: "outline",
  },
  offline: {
    title: "Not synced",
    hint: "The server is unreachable — edits stay on this device and are retried when it recovers.",
    variant: "destructive",
  },
}

/** The write-through state of this theme's server row: saved, currently
    flushing, or held locally because the server is unreachable. Owned by the
    sync bridge (lib/custom-theme-sync), which is mounted at the app root, so a
    theme being edited anywhere — this page, or another tab — reports the same
    truth. */
function ThemeSyncChip() {
  const status = React.useSyncExternalStore(subscribeSyncStatus, syncStatusSnapshot, syncStatusSnapshot)
  const chip = SYNC_CHIP[status]
  const Icon = status === "syncing" ? CloudUpload : status === "offline" ? CloudOff : Check
  return (
    <Badge variant={chip.variant} title={chip.hint}>
      <Icon className={cn(status === "syncing" && "animate-pulse")} />
      {chip.title}
    </Badge>
  )
}

type SectionId = "presets" | "type" | "shape" | "surfaces" | "layout" | "color"

const SECTIONS: { id: SectionId; label: string; hint: string; icon: LucideIcon }[] = [
  { id: "presets", label: "Presets", hint: "Start from a whole look", icon: Sparkles },
  { id: "type", label: "Type", hint: "Faces, size, tracking", icon: Type },
  { id: "shape", label: "Shape", hint: "Corners and the composer", icon: SquareRoundCorner },
  { id: "surfaces", label: "Surfaces", hint: "Depth, edge, glass", icon: Layers },
  { id: "layout", label: "Layout", hint: "Measure and density", icon: Ruler },
  { id: "color", label: "Color", hint: "Light and dark pair", icon: Palette },
]

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
  const [section, setSection] = React.useState<SectionId>("presets")
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

  const remove = async () => {
    if (!theme) return
    const ok = await confirm({
      title: `Delete "${theme.name}"?`,
      description:
        "The theme is deleted from the server, so it disappears everywhere it is synced. This cannot be undone.",
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
      {/* `flush`: the section track below is the break, not the header's rule. */}
      <FormPageHeader
        title={`Edit ${theme.name}`}
        description="Type, shape and colour, for light and dark together. Changes apply immediately and are saved to this server."
        onBack={onClose}
        flush
      />

      <TabBar
        label="Theme sections"
        items={SECTIONS.map<TabItem>(({ id, label, icon }) => ({
          id,
          label,
          icon,
          dot: id === "color" && warnings > 0,
        }))}
        value={section}
        onChange={(id) => setSection(id as SectionId)}
      />

      {/* The theme's live state, at a glance: whether the server has the latest
          edit, and how many contrast pairs fall short of AA — the two things
          that are true of the theme no matter which section you are on. Warnings
          live here rather than under the preview so they survive the scroll. */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <ThemeSyncChip />
        {warnings > 0 && (
          <Badge
            variant="destructive"
            className="w-fit"
            title={`${warnings} foreground/surface pair${warnings === 1 ? "" : "s"} fall below WCAG AA body-text contrast in one mode or the other.`}
          >
            <TriangleAlert className="size-3" />
            {warnings} pair{warnings === 1 ? "" : "s"} below AA
          </Badge>
        )}
      </div>

      {/* The preview column grows with the frame rather than staying a fixed
          thumbnail: this page runs at the settings frame's full width
          (isFullWidthSettings in settings/sections.ts), and the mock is the half
          that benefits from it. */}
      <div className="grid gap-4 @panel-lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)] @panel-lg:items-start @panel-xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] @panel-xl:gap-6">
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

          <SectionHeader section={section} />
          <div className="flex flex-col gap-4">
            {section === "presets" && (
              <PresetsTab base={theme.base} onBase={setBase} onPalette={setPalette} />
            )}
            {section === "type" && <TypeSection base={theme.base} onChange={setBase} />}
            {section === "shape" && <ShapeSection base={theme.base} onChange={setBase} />}
            {section === "surfaces" && <SurfacesSection base={theme.base} onChange={setBase} />}
            {section === "layout" && <LayoutSection base={theme.base} onChange={setBase} />}
            {/* Two columns of token groups only once the controls column can
                hold a label plus both mode fields twice over (~350px each);
                below that the pair wraps, and the light/dark comparison is the
                one thing this grid exists for. */}
            {section === "color" && (
              <div className="grid items-start gap-4 @panel-xl:grid-cols-2">
              {THEME_TOKEN_GROUPS.map((group) => (
                <FieldSet key={group.label} className="gap-3">
                  <div className="flex items-end justify-between gap-3">
                    <div className="min-w-0">
                      <FieldLegend variant="label" className="mb-0 text-sm">
                        {group.label}
                      </FieldLegend>
                      <FieldDescription className="text-xs">{group.hint}</FieldDescription>
                    </div>
                    {/* Column headers, once per group: the two fields on every
                        row below are the same token in the two modes. */}
                    <div className="hidden shrink-0 gap-2 text-xs font-medium text-muted-foreground @panel-sm:flex">
                      {MODES.map((mode) => (
                        <span key={mode} className="w-32 text-center">
                          {mode}
                        </span>
                      ))}
                    </div>
                  </div>
                  <ItemGroup className="gap-0.5 rounded-xl border p-1">
                    {group.tokens.map(({ token, label }) => (
                      <Item
                        key={token}
                        size="xs"
                        // Stacked below the split: the label over the pair,
                        // each field filling half the row. Side by side the
                        // moment there is room for a name plus two swatches.
                        className="flex-col items-stretch gap-1.5 rounded-lg py-2 @panel-sm:flex-row @panel-sm:items-center @panel-sm:gap-2 @panel-sm:py-1.5"
                      >
                        <ItemContent className="min-w-0">
                          <ItemTitle className="text-sm font-normal" title={`--${token}`}>
                            {label}
                          </ItemTitle>
                        </ItemContent>
                        <ItemActions className="gap-2 [&>*]:min-w-0 [&>*]:flex-1 @panel-sm:[&>*]:flex-none">
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
            </div>
            )}
          </div>

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

        {/* Preview. Beside the controls and sticky from the split up, where it
            stays in view for the whole length of the Color section.

            Below the split it is still sticky — pinned to the top of the panel
            rather than to the side — because a preview that scrolls away is a
            preview you edit blind, which is the single thing this layout
            exists to prevent. It sticks under whatever the app header covers
            of *this* panel (`--app-header-h`, measured per panel) and nothing
            else, now that the section track scrolls away with the page, and it
            carries its own surface, so the controls scroll under it rather
            than through it. */}
        <aside
          className={cn(
            "order-first sticky top-[calc(var(--app-header-h,0px)+0.5rem)] z-20 min-w-0 rounded-xl border bg-background p-2",
            "@panel-lg:order-none @panel-lg:top-[calc(var(--app-header-h,0px)+0.75rem)] @panel-lg:max-h-[calc(var(--panel-h,100svh)-var(--app-header-h,0px)-1rem)] @panel-lg:overflow-y-auto @panel-lg:rounded-none @panel-lg:border-0 @panel-lg:bg-transparent @panel-lg:p-0 @panel-lg:pb-2"
          )}
        >
          <PreviewPane theme={theme} worn={worn} />
        </aside>
      </div>
    </>
  )
}

/** The section's name and what it is for, over its controls. */
function SectionHeader({ section }: { section: SectionId }) {
  const entry = SECTIONS.find((item) => item.id === section)
  if (!entry) return null
  return (
    <div className="flex items-baseline gap-2 border-b pb-2">
      <h3 className="text-sm font-medium">{entry.label}</h3>
      <p className="text-xs text-muted-foreground">{entry.hint}</p>
    </div>
  )
}

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
