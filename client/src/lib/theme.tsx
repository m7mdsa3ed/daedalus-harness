/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import { BOOT_COLORS } from "./boot-colors"
import {
  customThemeId,
  customThemesSnapshot,
  isCustomTheme,
  subscribeCustomThemes,
  type CustomTheme,
} from "./custom-themes"

type Theme = "light" | "dark" | "system"

/** A palette id: a built-in one, or `custom:<id>` from the theme builder. */
export type ColorTheme = string

/** The palettes that ship in styles/themes.css. Adding one means adding a
    block there and an entry here — nothing else in the app knows their names. */
export const BUILTIN_THEMES = [
  { value: "default", label: "Default" },
  { value: "ocean", label: "Ocean" },
  { value: "forest", label: "Forest" },
  { value: "violet", label: "Violet" },
  { value: "sunset", label: "Sunset" },
  { value: "rose", label: "Rose" },
  { value: "amber", label: "Amber" },
  { value: "slate", label: "Slate" },
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
  { value: "gemini", label: "Gemini" },
  { value: "copilot", label: "Copilot" },
] as const

export const DEFAULT_COLOR_THEME = "default"

const COLOR_THEME_KEY = "ui.colorTheme"

interface ThemeContext {
  theme: Theme
  setTheme: (t: Theme) => void
  resolved: "light" | "dark"
  colorTheme: ColorTheme
  setColorTheme: (theme: ColorTheme) => void
}

const Ctx = createContext<ThemeContext>({
  theme: "system",
  setTheme: () => {},
  resolved: "light",
  colorTheme: "default",
  setColorTheme: () => {},
})

function getSystemTheme(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

/** A palette id is usable only if something still defines it: a built-in, or a
    custom theme that has not been deleted since it was selected. */
export function colorThemeExists(value: string, custom: CustomTheme[]): boolean {
  if (isCustomTheme(value)) return custom.some((theme) => theme.id === customThemeId(value))
  return BUILTIN_THEMES.some((theme) => theme.value === value)
}

function storedColorTheme(): ColorTheme {
  const value = localStorage.getItem(COLOR_THEME_KEY) ?? ""
  return colorThemeExists(value, customThemesSnapshot()) ? value : DEFAULT_COLOR_THEME
}

/** The user's saved palettes, live — the builder writes through this store. */
export function useCustomThemes(): CustomTheme[] {
  return useSyncExternalStore(subscribeCustomThemes, customThemesSnapshot, customThemesSnapshot)
}

/* The strip above the header — a browser's address bar, an installed app's
   status bar — is painted by the platform from `<meta name="theme-color">`,
   not by anything in the tree, so it only matches the app if we keep telling
   it what the app currently looks like. `--background` is the right token:
   nothing in the shell paints the top edge (the header is transparent and the
   wrapper has no fill), so what shows through the safe-area inset is the page.

   The value cannot be computed before the stylesheet loads, which is exactly
   when it is needed — index.html's pre-paint script has a palette id and no
   CSS. So each resolved colour is remembered under the palette and mode that
   produced it, and that script reads the answer back. The map is at most two
   entries per palette, and a stale one only survives until the palette is
   worn again. */
export const THEME_COLOR_KEY = "ui.themeColor"

/** Tint the browser/PWA status bar with the app background for the active theme. */
function applyThemeColor(resolved: "light" | "dark", colorTheme: ColorTheme) {
  const background = getComputedStyle(document.documentElement)
    .getPropertyValue("--background")
    .trim()
  // Empty means the stylesheet has not landed yet. The floor is the Default
  // palette's own background, shared with the splash and the manifest — see
  // lib/boot-colors.
  let content = background || BOOT_COLORS[resolved]
  try {
    const ctx = document.createElement("canvas").getContext("2d")
    if (ctx) {
      // `oklch(...)`/`hsl(...)` is a valid theme-color, but Safari has been
      // fussy about the newer spaces — round-tripping through a canvas is the
      // cheapest way to hand the platform a plain rgb/hex string. A value it
      // rejects leaves fillStyle at the sentinel, and the raw token stands.
      ctx.fillStyle = "#ff00ff"
      ctx.fillStyle = content
      if (ctx.fillStyle !== "#ff00ff") content = ctx.fillStyle
    }
  } catch {
    // keep raw value
  }
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (!meta) {
    meta = document.createElement("meta")
    meta.name = "theme-color"
    document.head.appendChild(meta)
  }
  meta.setAttribute("content", content)
  rememberThemeColor(`${colorTheme}:${resolved}`, content)
}

function rememberThemeColor(key: string, content: string) {
  try {
    const raw = JSON.parse(localStorage.getItem(THEME_COLOR_KEY) ?? "{}") as unknown
    const map = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, string>) : {}
    if (map[key] === content) return
    localStorage.setItem(THEME_COLOR_KEY, JSON.stringify({ ...map, [key]: content }))
  } catch {
    // A status bar that is one paint behind on the next boot is not worth
    // throwing out of an effect.
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(
    () => (localStorage.getItem("theme") as Theme) || "system"
  )
  const [resolved, setResolved] = useState<"light" | "dark">(() => {
    const stored = localStorage.getItem("theme") as Theme | null
    return stored === "light" || stored === "dark" ? stored : getSystemTheme()
  })
  const [colorTheme, setColorTheme] = useState<ColorTheme>(storedColorTheme)
  const customThemes = useCustomThemes()

  // Deleting the palette you are wearing drops you back to Default rather than
  // leaving the app styled by a data attribute nothing defines any more.
  useEffect(() => {
    if (!colorThemeExists(colorTheme, customThemes)) setColorTheme(DEFAULT_COLOR_THEME)
  }, [colorTheme, customThemes])

  useEffect(() => {
    if (theme !== "system") {
      setResolved(theme)
      return
    }
    const mq = window.matchMedia("(prefers-color-scheme: dark)")
    const sync = () => setResolved(mq.matches ? "dark" : "light")
    sync()
    mq.addEventListener("change", sync)
    return () => mq.removeEventListener("change", sync)
  }, [theme])

  useEffect(() => {
    document.documentElement.classList.toggle("dark", resolved === "dark")
    document.documentElement.dataset.colorTheme = colorTheme
    localStorage.setItem("theme", theme)
    localStorage.setItem(COLOR_THEME_KEY, colorTheme)
    applyThemeColor(resolved, colorTheme)
    window.desktop?.setTitleBarTheme?.(resolved)
  }, [theme, resolved, colorTheme, customThemes])

  return (
    <Ctx.Provider value={{ theme, setTheme: setThemeState, resolved, colorTheme, setColorTheme }}>
      {children}
    </Ctx.Provider>
  )
}

export function useTheme() {
  return useContext(Ctx)
}

// ---- appearance: font size + UI scale ----

function storedNumber(key: string, fallback: number, min: number, max: number): number {
  const value = Number(localStorage.getItem(key))
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback
}

/** Root font size in px — rem-based layout scales from it. */
export const FONT_SIZE_DEFAULT = 16
export const FONT_SIZE_MIN = 12
export const FONT_SIZE_MAX = 24

function applyFontSize(px: number) {
  document.documentElement.style.fontSize = `${px}px`
}

/** UI density in percent — scales Tailwind's --spacing unit (default 0.25rem),
    so paddings/gaps/heights tighten or relax without touching text size. */
export const SCALE_DEFAULT = 100
export const SCALE_MIN = 70
export const SCALE_MAX = 200

function applyScale(pct: number) {
  document.documentElement.style.setProperty("--spacing", `${(0.25 * pct) / 100}rem`)
}

/* One store per knob, outside React. The settings sliders and the command
   palette both drive these; component state would let the two disagree until
   one of them remounted. The value is applied on creation, at module load, so
   the app never flashes the defaults. */
function appearanceStore(
  key: string,
  fallback: number,
  min: number,
  max: number,
  apply: (value: number) => void
) {
  let value = storedNumber(key, fallback, min, max)
  apply(value)
  const listeners = new Set<() => void>()

  return {
    get: () => value,
    set(next: number) {
      const clamped = Math.min(max, Math.max(min, Math.round(next) || fallback))
      if (clamped === value) return
      value = clamped
      localStorage.setItem(key, String(value))
      apply(value)
      for (const listener of listeners) listener()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

const fontSizeStore = appearanceStore(
  "ui.fontSize",
  FONT_SIZE_DEFAULT,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  applyFontSize
)
const scaleStore = appearanceStore("ui.scale", SCALE_DEFAULT, SCALE_MIN, SCALE_MAX, applyScale)

function useAppearanceNumber(
  store: ReturnType<typeof appearanceStore>
): [number, (value: number) => void] {
  const value = useSyncExternalStore(store.subscribe, store.get, store.get)
  return [value, store.set]
}

export function useFontSize() {
  return useAppearanceNumber(fontSizeStore)
}

export function useScale() {
  return useAppearanceNumber(scaleStore)
}

declare global {
  interface Window {
    desktop?: {
      isElectron: boolean
      platform: string
      vibrancy: boolean
      setTitleBarTheme?: (resolved: "light" | "dark") => void
    }
  }
}
