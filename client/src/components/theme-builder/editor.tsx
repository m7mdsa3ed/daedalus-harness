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

   Three tabs, ordered the way a theme is actually made:
   - **Presets** — start from a coordinated whole. A style preset sets the
     entire Design half at once; a palette preset (or the hue/chroma/tint
     sliders) regenerates every colour through the same ramp the built-in
     themes are generated from.
   - **Design** — the mode-independent half: type, shape, depth, glass, measure.
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
  Palette,
  RotateCcw,
  Trash2,
  TriangleAlert,
} from "lucide-react"
import { Navigate, useNavigate, useParams } from "react-router"

import { useConfirm } from "@/components/confirm-dialog"
import { FormPageHeader } from "@/components/settings/primitives"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ButtonGroup, ButtonGroupSeparator } from "@/components/ui/button-group"
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Item, ItemActions, ItemContent, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { schemePalette, type ColorScheme } from "@/lib/color-schemes"
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

import { DesignTab } from "./design-tab"
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
  { title: string; hint: string; className: string }
> = {
  synced: {
    title: "Saved",
    hint: "Every change is saved to this server, so the theme follows the account and not the browser.",
    className: "border-border text-muted-foreground",
  },
  syncing: {
    title: "Saving…",
    hint: "Writing your changes to the server.",
    className: "border-primary/40 text-foreground",
  },
  offline: {
    title: "Not synced",
    hint: "The server is unreachable — edits stay on this device and are retried when it recovers.",
    className: "border-destructive/50 text-destructive",
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
  const trigger = (
    <span
      className={cn("flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium", chip.className)}
    >
      <Icon className={cn("size-3", status === "syncing" && "animate-pulse")} />
      {chip.title}
    </span>
  )
  return (
    <Tooltip>
      <TooltipTrigger render={trigger} />
      <TooltipContent>{chip.hint}</TooltipContent>
    </Tooltip>
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
      <FormPageHeader
        title={`Edit ${theme.name}`}
        description="Type, shape and colour, for light and dark together. Changes apply immediately and are saved to this server."
        onBack={onClose}
      />

      {/* The theme's live state, at a glance: whether the server has the latest
          edit, and how many contrast pairs fall short of AA — the two things
          that are true of the theme no matter which tab you are on. Warnings
          live here rather than under the preview so they survive the scroll. */}
      <div className="flex flex-wrap items-center gap-2">
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
          <PreviewPane theme={theme} worn={worn} />
        </aside>
      </div>
    </>
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
