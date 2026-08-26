/* ── Theme gallery + builder ──
   The gallery is every palette the app knows: the built-ins from
   styles/themes.css and whatever the user has made. The builder edits a custom
   palette token by token — both modes at once, side by side, because a palette
   *is* a light/dark pair and editing one half blind is how you end up with a
   theme that only works after dark.

   Edits write through on every change, so if you are wearing the palette you
   are editing the whole app repaints under the color picker. "Revert" restores
   the snapshot taken on open, which is the undo that live editing owes you. */
import * as React from "react"
import { Check, Copy, Palette, Pencil, Plus, RotateCcw, Trash2, TriangleAlert } from "lucide-react"
import { useConfirm } from "@/components/confirm-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ButtonGroup, ButtonGroupSeparator } from "@/components/ui/button-group"
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  contrastRatio,
  CONTRAST_PAIRS,
  customThemeId,
  customThemeValue,
  isCustomTheme,
  loadCustomThemes,
  saveCustomThemes,
  seedTheme,
  THEME_TOKEN_GROUPS,
  type CustomTheme,
  type ThemeTokens,
} from "@/lib/custom-themes"
import { BUILTIN_THEMES, useCustomThemes, useTheme } from "@/lib/theme"
import { cn } from "@/lib/utils"

type Mode = "light" | "dark"
const MODES: readonly Mode[] = ["light", "dark"]

/** Below this a foreground/surface pair fails WCAG AA for body text. */
const MIN_CONTRAST = 4.5

export function ThemeGallery() {
  const { colorTheme, setColorTheme } = useTheme()
  const customThemes = useCustomThemes()
  const [editing, setEditing] = React.useState<string | null>(null)

  /** New themes are copies — of the palette you are wearing, so "New theme"
      always starts from something you already like rather than from grey. */
  const create = (seedFrom: string) => {
    const source = isCustomTheme(seedFrom)
      ? customThemes.find((entry) => entry.id === customThemeId(seedFrom))
      : undefined
    const seeded = seedTheme(nextName(customThemes), source ? "default" : seedFrom)
    const theme = source
      ? { ...seeded, light: { ...source.light }, dark: { ...source.dark } }
      : seeded
    saveCustomThemes([...customThemes, theme])
    setColorTheme(customThemeValue(theme.id))
    setEditing(theme.id)
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-2 p-2 sm:grid-cols-3 lg:grid-cols-4">
        {BUILTIN_THEMES.map(({ value, label }) => (
          <ThemeCard
            key={value}
            label={label}
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
                setEditing(theme.id)
              }}
            />
          )
        })}
        <button
          type="button"
          onClick={() => create(colorTheme)}
          title="Copy the current palette into a new editable theme"
          className="flex min-h-24 flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed text-xs font-medium text-muted-foreground transition-colors hover:border-ring/60 hover:bg-accent/40 hover:text-foreground"
        >
          <Plus className="size-4" />
          New theme
        </button>
      </div>
      <ThemeEditor
        themeId={editing}
        onClose={() => setEditing(null)}
        onDuplicate={(id) => create(customThemeValue(id))}
      />
    </>
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
  themeValue,
  selected,
  onSelect,
  onEdit,
}: {
  label: string
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

/** Inline vars beat the stylesheet, so a draft renders before it is saved. */
const tokenStyle = (tokens?: ThemeTokens): React.CSSProperties =>
  Object.fromEntries(
    Object.entries(tokens ?? {}).map(([token, value]) => [`--${token}`, value])
  ) as React.CSSProperties

/** The gallery swatch: both modes stacked, reading the palette's real tokens. */
export function ThemePreview({ themeValue }: { themeValue: string }) {
  return (
    <div aria-hidden className="overflow-hidden rounded-lg border border-border/60">
      {MODES.map((mode) => (
        <div
          key={mode}
          data-color-theme={themeValue}
          className={cn("flex gap-1 bg-background p-1", mode === "dark" && "dark")}
        >
          <span className="h-8 w-2 shrink-0 rounded-[3px] bg-muted" />
          <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
            <span className="h-0.5 w-4/5 rounded-full bg-foreground/65" />
            <span className="h-0.5 w-3/5 rounded-full bg-muted-foreground" />
            <span className="mt-0.5 h-1.5 w-3 rounded-full bg-primary" />
          </span>
        </div>
      ))}
    </div>
  )
}

/** A fuller sample than the swatch: sidebar, header, bubble, button — enough
    surfaces that a token you got wrong shows up while you are still editing. */
function ThemeSample({ tokens, mode }: { tokens: ThemeTokens; mode: Mode }) {
  return (
    <div
      aria-hidden
      style={tokenStyle(tokens)}
      className={cn(
        "flex h-28 overflow-hidden rounded-lg border border-border bg-background",
        mode === "dark" && "dark"
      )}
    >
      <div className="flex w-1/3 flex-col gap-1 bg-sidebar p-1.5">
        <div className="flex items-center gap-1">
          <span className="size-2 rounded-[2px] bg-sidebar-primary" />
          <span className="h-1 w-8 rounded-full bg-sidebar-foreground/70" />
        </div>
        <span className="mt-1 h-3 rounded bg-sidebar-accent" />
        <span className="h-3 rounded border border-sidebar-border" />
        <span className="h-3 rounded border border-sidebar-border" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 p-1.5">
        <div className="flex items-center justify-between border-b border-border pb-1">
          <span className="h-1 w-10 rounded-full bg-foreground/70" />
          <span className="h-1 w-5 rounded-full bg-muted-foreground" />
        </div>
        <div className="ml-auto w-2/3 rounded-md bg-muted p-1">
          <span className="block h-1 w-full rounded-full bg-muted-foreground" />
        </div>
        <div className="w-3/4 rounded-md border border-border bg-card p-1">
          <span className="block h-1 w-full rounded-full bg-card-foreground/60" />
        </div>
        <div className="mt-auto flex items-center gap-1">
          <span className="h-3 flex-1 rounded border border-input" />
          <span className="h-3 w-6 rounded bg-primary" />
          <span className="size-3 rounded bg-destructive" />
        </div>
      </div>
    </div>
  )
}

function ThemeEditor({
  themeId,
  onClose,
  onDuplicate,
}: {
  themeId: string | null
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

  const remove = async () => {
    if (!theme) return
    const ok = await confirm({
      title: `Delete "${theme.name}"?`,
      description: "The palette is removed from this device. Themes are not synced.",
      confirmLabel: "Delete",
      destructive: true,
    })
    if (!ok) return
    saveCustomThemes(customThemes.filter((entry) => entry.id !== theme.id))
    onClose()
  }

  const warnings = theme ? countWarnings(theme) : 0
  const worn = !!theme && colorTheme === customThemeValue(theme.id)

  return (
    <ResponsiveDialog open={!!theme} onOpenChange={(open) => !open && onClose()}>
      <ResponsiveDialogContent className="sm:max-w-3xl">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Edit theme</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        {theme && (
          <div className="-mx-1 flex max-h-[72vh] min-h-0 flex-col gap-4 overflow-y-auto px-1">
            {/* Name + both samples: the pair is the unit of design, so both
                halves stay on screen while any token is edited. */}
            <div className="space-y-3">
              <Field>
                <FieldLabel htmlFor="theme-name">Name</FieldLabel>
                <Input
                  id="theme-name"
                  value={theme.name}
                  onChange={(event) => write({ ...theme, name: event.target.value })}
                />
              </Field>
              <div className="grid gap-2 sm:grid-cols-2">
                {MODES.map((mode) => (
                  <div key={mode} className="space-y-1">
                    <p className="px-0.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                      {mode}
                    </p>
                    <ThemeSample tokens={theme[mode]} mode={mode} />
                  </div>
                ))}
              </div>
            </div>

            <Item variant="muted" size="xs" className="rounded-lg">
              <ItemContent>
                <ItemTitle className="text-xs font-normal text-muted-foreground">
                  Every change applies immediately
                  {worn ? " — you are wearing this palette" : ""}.
                </ItemTitle>
              </ItemContent>
              {warnings > 0 && (
                <ItemActions>
                  <Badge variant="destructive">
                    <TriangleAlert />
                    {warnings} below AA
                  </Badge>
                </ItemActions>
              )}
            </Item>

            {THEME_TOKEN_GROUPS.map((group) => (
              <FieldSet key={group.label} className="gap-3">
                <div className="flex items-end justify-between gap-3">
                  <div className="min-w-0">
                    <FieldLegend variant="label" className="mb-0 text-xs">
                      {group.label}
                    </FieldLegend>
                    <FieldDescription className="text-[11px]">{group.hint}</FieldDescription>
                  </div>
                  {/* Column headers, once per group: the two fields on every row
                      below are the same token in the two modes. */}
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
                        <ItemTitle
                          className="text-xs font-normal"
                          title={`--${token}`}
                        >
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

            <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center gap-2 border-t bg-popover/85 px-1 pt-3 backdrop-blur">
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
            </div>
          </div>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
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
