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
import { BUILTIN_THEMES, type BuiltinTheme } from "./builtin-themes"
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

/* The themes that ship in styles/themes.css. The list itself is **generated**
   alongside the CSS by scripts/gen-themes.mjs (`pnpm themes`) and re-exported
   here so every existing importer keeps its path. It used to be hand-written
   in this file with a "keep in sync" comment at both ends, which is exactly how
   Sunset, Rose, Amber and Slate outlived the blocks that painted them.

   A theme is no longer only a palette: each also sets a radius, three font
   roles, a depth, a glass strength, a measure and a tracking, and the generator
   refuses to write a file where two of them share a design signature or where a
   preset value is worn by none. Anyone wearing a theme that has been removed is
   put back on Default by `colorThemeExists` below — the same path a deleted
   custom theme already took. */
export { BUILTIN_THEMES, type BuiltinTheme }

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
   it what the app currently looks like. The body's rendered background is the
   right source: nothing in the shell paints the top edge, so what shows
   through the safe-area inset is the page. index.html's pre-paint script
   writes a per-mode literal to the same tag first; this replaces it on every
   theme, mode or palette change. */

/** The body's rendered background as hex, or the boot colour for the mode. */
function getThemeColorFromComputedBackground(resolved: "light" | "dark"): string {
  const bodyBg = document.body ? getComputedStyle(document.body).backgroundColor : ""
  const rootBg = getComputedStyle(document.documentElement).backgroundColor
  const computed =
    bodyBg && bodyBg !== "transparent" && bodyBg !== "rgba(0, 0, 0, 0)" ? bodyBg : rootBg
  return colorToHex(computed) ?? BOOT_COLORS[resolved]
}

/** Resolve any CSS colour the browser can paint — the palettes are `oklch`,
    which the computed value keeps as-is — to `#rrggbb` through a 1px canvas.

    Exported because the terminal needs it for the same reason this file does:
    xterm paints to its own surface and parses colours itself, and its parser
    knows `#rgb` and `rgb()` and nothing else — so every token handed to it has
    to come through here or it is silently ignored (see terminal-panel.tsx). */
export function colorToHex(color: string): string | null {
  if (!color) return null
  try {
    const canvas = document.createElement("canvas")
    canvas.width = 1
    canvas.height = 1
    const ctx = canvas.getContext("2d")
    if (!ctx) return null
    ctx.fillStyle = "#ff00ff"
    ctx.fillStyle = color
    if (ctx.fillStyle === "#ff00ff") return null
    ctx.fillRect(0, 0, 1, 1)
    const [red, green, blue] = ctx.getImageData(0, 0, 1, 1).data
    const hex = (channel: number) => channel.toString(16).padStart(2, "0")
    return `#${hex(red)}${hex(green)}${hex(blue)}`
  } catch {
    return null
  }
}

/** Write the one `theme-color` meta, creating it if the document lost it. */
function updateThemeColor(color: string): void {
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (!meta) {
    meta = document.createElement("meta")
    meta.setAttribute("name", "theme-color")
    document.head.appendChild(meta)
  }
  meta.setAttribute("content", color)
}

/** Tint the browser/PWA status bar with the app background for the active theme. */
function applyThemeColor(resolved: "light" | "dark") {
  document.documentElement.style.colorScheme = resolved
  // Read on the next frame so the computed-style read does not force a
  // synchronous reflow right after the root class changed.
  requestAnimationFrame(() => {
    updateThemeColor(getThemeColorFromComputedBackground(resolved))
  })
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
    applyThemeColor(resolved)
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
      writeClipboard?: (text: string) => Promise<boolean>
      /** Raise an OS notification through the main process (lib/notifications). */
      notify?: (payload: { title: string; body: string; sessionId?: string }) => Promise<boolean>
      /** Subscribe to clicks on those notifications; returns an unsubscribe. */
      onNotificationClick?: (handler: (sessionId: string) => void) => () => void
    }
  }
}
