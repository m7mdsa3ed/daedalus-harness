/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react"

type Theme = "light" | "dark" | "system"
export type ColorTheme =
  | "default"
  | "ocean"
  | "forest"
  | "violet"
  | "sunset"
  | "rose"
  | "amber"
  | "slate"
  | "claude"
  | "codex"
  | "gemini"
  | "copilot"

const COLOR_THEMES: readonly ColorTheme[] = [
  "default",
  "ocean",
  "forest",
  "violet",
  "sunset",
  "rose",
  "amber",
  "slate",
  "claude",
  "codex",
  "gemini",
  "copilot",
]
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

function storedColorTheme(): ColorTheme {
  const value = localStorage.getItem(COLOR_THEME_KEY)
  return COLOR_THEMES.includes(value as ColorTheme) ? (value as ColorTheme) : "default"
}

/** Tint the browser/PWA status bar with the app background for the active theme. */
function applyThemeColor(resolved: "light" | "dark") {
  const background = getComputedStyle(document.documentElement)
    .getPropertyValue("--background")
    .trim()
  let content = background || (resolved === "dark" ? "#0a0a0a" : "#ffffff")
  try {
    const ctx = document.createElement("canvas").getContext("2d")
    if (ctx) {
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
  }, [theme, resolved, colorTheme])

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

// Apply stored values at module load so the app never flashes the defaults.
applyFontSize(storedNumber("ui.fontSize", FONT_SIZE_DEFAULT, FONT_SIZE_MIN, FONT_SIZE_MAX))
applyScale(storedNumber("ui.scale", SCALE_DEFAULT, SCALE_MIN, SCALE_MAX))

function useAppearanceNumber(
  key: string,
  fallback: number,
  min: number,
  max: number,
  apply: (value: number) => void
): [number, (value: number) => void] {
  const [value, setValue] = useState(() => storedNumber(key, fallback, min, max))
  useEffect(() => {
    localStorage.setItem(key, String(value))
    apply(value)
  }, [key, value, apply])
  const set = (next: number) => setValue(Math.min(max, Math.max(min, Math.round(next) || fallback)))
  return [value, set]
}

export function useFontSize() {
  return useAppearanceNumber("ui.fontSize", FONT_SIZE_DEFAULT, FONT_SIZE_MIN, FONT_SIZE_MAX, applyFontSize)
}

export function useScale() {
  return useAppearanceNumber("ui.scale", SCALE_DEFAULT, SCALE_MIN, SCALE_MAX, applyScale)
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
