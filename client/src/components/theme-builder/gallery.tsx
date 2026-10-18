/* ── The gallery ──
   Every theme the app knows: the built-ins from styles/themes.css and whatever
   the user has made, each as a card wearing its own tokens. It also owns the
   one way a new theme comes into existence (`createTheme`, which the editor's
   Duplicate reuses), because a new theme is a copy of an existing one. */
import { Pencil, Plus } from "lucide-react"
import { useNavigate } from "react-router"

import { ChoiceTiles } from "@/components/settings/primitives"
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
      <ChoiceTiles
        label="Colour theme"
        value={colorTheme}
        onChange={setColorTheme}
        choices={[
          ...BUILTIN_THEMES.map(({ value, label, note }) => ({
            value,
            label,
            preview: (
              <span title={note} className="block">
                <ThemePreview themeValue={value} />
              </span>
            ),
          })),
          ...customThemes.map((theme) => {
            const value = customThemeValue(theme.id)
            return { value, label: theme.name, preview: <ThemePreview themeValue={value} /> }
          }),
        ]}
      />
      <div className="flex flex-wrap gap-2 p-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => create(colorTheme)}
          title="Copy the current theme into a new editable one"
        >
          <Plus className="size-4" />
          New theme
        </Button>
        {isCustomTheme(colorTheme) && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void navigate(`/settings/appearance/themes/${encodeURIComponent(customThemeId(colorTheme))}`)}
          >
            <Pencil className="size-3.5" />
            Edit theme
          </Button>
        )}
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
