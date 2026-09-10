/* ── The gallery ──
   Every theme the app knows: the built-ins from styles/themes.css and whatever
   the user has made, each as a card wearing its own tokens. It also owns the
   one way a new theme comes into existence (`createTheme`, which the editor's
   Duplicate reuses), because a new theme is a copy of an existing one. */
import { Check, Pencil, Plus } from "lucide-react"
import { useNavigate } from "react-router"

import { Button } from "@/components/ui/button"
import {
  customThemeId,
  customThemeValue,
  isCustomTheme,
  saveCustomThemes,
  seedTheme,
  type CustomTheme,
} from "@/lib/custom-themes"
import { BUILTIN_THEMES, useCustomThemes, useTheme } from "@/lib/theme"
import { cn } from "@/lib/utils"

import { ThemePreview } from "./preview"

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
    <>
      <div className="flex items-baseline justify-between gap-2 p-2">
        <p className="text-xs font-medium text-muted-foreground">
          {BUILTIN_THEMES.length} built-in
          {customThemes.length > 0 ? `· ${customThemes.length} saved on this server` : ""}
        </p>
        <p className="min-w-0 truncate text-[11px] text-muted-foreground">
          Built-ins ship with the app; your themes are saved to the server and followed across devices.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2 p-2 @panel-sm:grid-cols-3 @panel-md:grid-cols-4 @panel-lg:grid-cols-5">
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
    </>
  )
}

export function createTheme(seedFrom: string, customThemes: CustomTheme[]): CustomTheme {
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
          className="absolute top-2 right-2 bg-card/70 opacity-70 backdrop-blur transition-opacity hover:opacity-100 focus-visible:opacity-100"
        >
          <Pencil className="size-3.5" />
        </Button>
      )}
    </div>
  )
}
