/* ── Custom color themes ──
   A user-made palette is the same thing a built-in one is: a set of semantic
   token overrides for light and for dark (see styles/themes.css). The only
   difference is where the CSS comes from — built-ins ship in the stylesheet,
   these are serialized into one <style> element at runtime, keyed by
   `data-color-theme="custom:<id>"`.

   Values are stored as plain hex. The seeder converts a built-in palette's
   oklch (and composites any alpha over that palette's background) so an edited
   copy starts out looking identical to what it was copied from. */

const STORAGE_KEY = "ui.customThemes"
const STYLE_ID = "daedalus-custom-themes"
const PREFIX = "custom:"

export interface ThemeTokenDef {
  token: string
  label: string
}

/** The editable surface of a palette, grouped the way the builder renders it.
    Keep in sync with the token set the built-ins override in themes.css. */
export const THEME_TOKEN_GROUPS: readonly { label: string; hint: string; tokens: ThemeTokenDef[] }[] = [
  {
    label: "Surfaces",
    hint: "The page and the panels that float above it.",
    tokens: [
      { token: "background", label: "Background" },
      { token: "foreground", label: "Text" },
      { token: "card", label: "Card" },
      { token: "card-foreground", label: "Card text" },
      { token: "popover", label: "Popover" },
      { token: "popover-foreground", label: "Popover text" },
    ],
  },
  {
    label: "Brand",
    hint: "Buttons, highlights and the selected state.",
    tokens: [
      { token: "primary", label: "Primary" },
      { token: "primary-foreground", label: "On primary" },
      { token: "secondary", label: "Secondary" },
      { token: "secondary-foreground", label: "On secondary" },
      { token: "accent", label: "Accent" },
      { token: "accent-foreground", label: "On accent" },
    ],
  },
  {
    label: "Support",
    hint: "Quiet text, hairlines, focus rings, errors.",
    tokens: [
      { token: "muted", label: "Muted" },
      { token: "muted-foreground", label: "Muted text" },
      { token: "border", label: "Border" },
      { token: "input", label: "Input border" },
      { token: "ring", label: "Focus ring" },
      { token: "destructive", label: "Destructive" },
    ],
  },
  {
    label: "Sidebar",
    hint: "The left pane has its own surface so it can differ from the page.",
    tokens: [
      { token: "sidebar", label: "Sidebar" },
      { token: "sidebar-foreground", label: "Sidebar text" },
      { token: "sidebar-primary", label: "Sidebar primary" },
      { token: "sidebar-primary-foreground", label: "On sidebar primary" },
      { token: "sidebar-accent", label: "Sidebar accent" },
      { token: "sidebar-accent-foreground", label: "On sidebar accent" },
      { token: "sidebar-border", label: "Sidebar border" },
      { token: "sidebar-ring", label: "Sidebar ring" },
    ],
  },
]

export const THEME_TOKENS: readonly string[] = THEME_TOKEN_GROUPS.flatMap((g) =>
  g.tokens.map((t) => t.token)
)

export type ThemeTokens = Record<string, string>

export interface CustomTheme {
  id: string
  name: string
  light: ThemeTokens
  dark: ThemeTokens
}

export const isCustomTheme = (value: string): boolean => value.startsWith(PREFIX)
export const customThemeValue = (id: string): string => PREFIX + id
export const customThemeId = (value: string): string => value.slice(PREFIX.length)

// ---- color conversion ----

/** oklch(L C H[ / A]) → linear-light sRGB. Björn Ottosson's matrices. */
function oklchToRgb(l: number, c: number, hDeg: number): [number, number, number] {
  const h = (hDeg * Math.PI) / 180
  const a = c * Math.cos(h)
  const b = c * Math.sin(h)
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ]
}

const gamma = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055)
const byte = (x: number) => Math.max(0, Math.min(255, Math.round(x * 255)))
const hex2 = (n: number) => n.toString(16).padStart(2, "0")

const num = (raw: string, scale = 1) =>
  raw.endsWith("%") ? (parseFloat(raw) / 100) * scale : parseFloat(raw)

/** Any CSS color the built-in palettes use → `{ hex, alpha }`. Unparseable
    values fall back to opaque mid-grey rather than throwing: a seeded palette
    with one dull swatch is recoverable, a crashed editor is not. */
export function parseColor(value: string): { hex: string; alpha: number } {
  const input = value.trim()
  const hexMatch = /^#([0-9a-f]{3,8})$/i.exec(input)
  if (hexMatch) {
    const digits = hexMatch[1]
    const expand = (s: string) => (s.length === 1 ? s + s : s)
    const parts =
      digits.length <= 4
        ? digits.split("").map(expand)
        : (digits.match(/../g) ?? []).slice(0, 4)
    const [r, g, b, a] = parts
    return { hex: `#${r}${g}${b}`, alpha: a === undefined ? 1 : parseInt(a, 16) / 255 }
  }

  const fn = /^(oklch|rgba?)\(([^)]*)\)$/i.exec(input)
  if (fn) {
    const [main, alphaPart] = fn[2].split("/")
    const args = main.trim().split(/[\s,]+/).filter(Boolean)
    const alpha = alphaPart === undefined ? 1 : num(alphaPart.trim())
    if (fn[1].toLowerCase() === "oklch") {
      const [r, g, b] = oklchToRgb(num(args[0] ?? "0"), num(args[1] ?? "0"), num(args[2] ?? "0"))
      return { hex: `#${hex2(byte(gamma(r)))}${hex2(byte(gamma(g)))}${hex2(byte(gamma(b)))}`, alpha }
    }
    // rgb()/rgba() — the fourth positional arg is alpha in the legacy form.
    const [r, g, b, a] = args.map((v) => num(v, 255))
    const opacity = alphaPart === undefined && a !== undefined ? a / 255 : alpha
    return { hex: `#${hex2(byte(r / 255))}${hex2(byte(g / 255))}${hex2(byte(b / 255))}`, alpha: opacity }
  }

  return { hex: "#808080", alpha: 1 }
}

/** Flatten a translucent token onto the surface it sits on, so the editor can
    offer one opaque swatch without changing how the palette reads. */
function composite(hex: string, alpha: number, over: string): string {
  if (alpha >= 1) return hex
  const channels = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const [fr, fg, fb] = channels(hex)
  const [br, bg, bb] = channels(over)
  const mix = (f: number, b: number) => hex2(Math.round(f * alpha + b * (1 - alpha)))
  return `#${mix(fr, br)}${mix(fg, bg)}${mix(fb, bb)}`
}

/** WCAG relative luminance of an opaque `#rrggbb`. */
function luminance(hex: string): number {
  const channel = (index: number) => {
    const value = parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2)
}

/** WCAG contrast ratio, 1–21. The builder warns below 4.5 (AA body text) on the
    pairs that actually carry text, so a pretty palette can't ship unreadable. */
export function contrastRatio(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (high + 0.05) / (low + 0.05)
}

/** Foreground token → the surface it is drawn on. */
export const CONTRAST_PAIRS: Readonly<Record<string, string>> = {
  foreground: "background",
  "card-foreground": "card",
  "popover-foreground": "popover",
  "primary-foreground": "primary",
  "secondary-foreground": "secondary",
  "accent-foreground": "accent",
  "muted-foreground": "muted",
  "sidebar-foreground": "sidebar",
  "sidebar-primary-foreground": "sidebar-primary",
  "sidebar-accent-foreground": "sidebar-accent",
}

// ---- seeding from a built-in palette ----

/** Resolve a built-in palette's tokens by asking the browser.
    The root's theme attributes are swapped and restored inside one task, so no
    paint happens in between and the user never sees the probe. */
export function readPalette(builtin: string, mode: "light" | "dark"): ThemeTokens {
  const root = document.documentElement
  const previousTheme = root.dataset.colorTheme
  const previousDark = root.classList.contains("dark")
  root.dataset.colorTheme = builtin
  root.classList.toggle("dark", mode === "dark")

  const computed = getComputedStyle(root)
  const background = parseColor(computed.getPropertyValue("--background"))
  const tokens: ThemeTokens = {}
  for (const token of THEME_TOKENS) {
    const { hex, alpha } = parseColor(computed.getPropertyValue(`--${token}`))
    tokens[token] = composite(hex, alpha, background.hex)
  }

  if (previousTheme === undefined) delete root.dataset.colorTheme
  else root.dataset.colorTheme = previousTheme
  root.classList.toggle("dark", previousDark)
  return tokens
}

export function seedTheme(name: string, builtin: string): CustomTheme {
  return {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name,
    light: readPalette(builtin, "light"),
    dark: readPalette(builtin, "dark"),
  }
}

// ---- storage + CSS injection ----

function isTokens(value: unknown): value is ThemeTokens {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export function loadCustomThemes(): CustomTheme[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown
    if (!Array.isArray(raw)) return []
    return raw.filter(
      (entry): entry is CustomTheme =>
        !!entry &&
        typeof (entry as CustomTheme).id === "string" &&
        typeof (entry as CustomTheme).name === "string" &&
        isTokens((entry as CustomTheme).light) &&
        isTokens((entry as CustomTheme).dark)
    )
  } catch {
    return []
  }
}

const declarations = (tokens: ThemeTokens) =>
  THEME_TOKENS.filter((token) => tokens[token])
    .map((token) => `  --${token}: ${tokens[token]};`)
    .join("\n")

/** Same selector shape the built-ins use, so a custom palette and a shipped one
    are indistinguishable to every component. */
export function themeCss(theme: CustomTheme): string {
  const selector = `[data-color-theme="${customThemeValue(theme.id)}"]`
  return (
    `${selector}:not(.dark) {\n${declarations(theme.light)}\n}\n\n` +
    `.dark${selector} {\n${declarations(theme.dark)}\n}`
  )
}

export function applyCustomThemes(themes: CustomTheme[]): void {
  let style = document.getElementById(STYLE_ID)
  if (!style) {
    style = document.createElement("style")
    style.id = STYLE_ID
    document.head.appendChild(style)
  }
  style.textContent = themes.map(themeCss).join("\n\n")
}

const listeners = new Set<() => void>()
let cache = loadCustomThemes()
applyCustomThemes(cache)

export function saveCustomThemes(themes: CustomTheme[]): void {
  cache = themes
  localStorage.setItem(STORAGE_KEY, JSON.stringify(themes))
  applyCustomThemes(themes)
  for (const listener of listeners) listener()
}

export function subscribeCustomThemes(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const customThemesSnapshot = (): CustomTheme[] => cache

/* Another tab (or another window of the Electron shell) editing a palette is
   the same edit — adopt it instead of letting the two drift apart. */
window.addEventListener("storage", (event) => {
  if (event.key !== null && event.key !== STORAGE_KEY) return
  cache = loadCustomThemes()
  applyCustomThemes(cache)
  for (const listener of listeners) listener()
})
