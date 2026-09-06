/* ── Custom themes ──
   A user-made theme is the same thing a built-in one is: a set of semantic
   token overrides (see styles/themes.css). The only difference is where the CSS
   comes from — built-ins ship in the stylesheet, these are serialized into one
   <style> element at runtime, keyed by `data-color-theme="custom:<id>"`.

   A theme is no longer only a palette. It has three parts, split by *what the
   value depends on* rather than by what it looks like:

   - `light` / `dark` — the colours, and the shadows, because both read
     differently by mode: a shadow that says "lifted" on white says nothing at
     all on near-black, so it needs its own value there.
   - `base` — radius, the three font roles and letter-spacing. None of these
     change between light and dark, and duplicating them across both halves
     would let the two drift into a theme whose shape changes when the sun goes
     down.

   Colour values are stored as plain opaque hex. The seeder converts a built-in
   palette's oklch (and composites any alpha over that palette's background) so
   an edited copy starts out looking identical to what it was copied from.

   Fonts are stored as *ids* resolved by lib/fonts.ts, never as CSS stacks, and
   depth is stored as a preset id resolved by DEPTH_PRESETS below — so what is
   saved stays legible and re-editable, which a raw `0 8px 32px oklch(...)`
   string would not be. */

import { fontStack, isGoogleFont, googleFontFamily, syncWebFonts, type FontRole } from "./fonts"
import { darkRamp, lightRamp, type RampSpec } from "./theme-ramp"

const STORAGE_KEY = "ui.customThemes"
const STYLE_ID = "daedalus-custom-themes"
const PREFIX = "custom:"

// ---- the editable surface ----

export interface ThemeTokenDef {
  token: string
  label: string
}

/** Colour tokens, grouped the way the studio renders them. Every one of these
    is per-mode. Keep in sync with what the built-ins override in themes.css. */
export const THEME_TOKEN_GROUPS: readonly { label: string; hint: string; tokens: ThemeTokenDef[] }[] = [
  {
    label: "Surfaces",
    hint: "The page, the panels that float above it, and the two derived surfaces.",
    tokens: [
      { token: "background", label: "Background" },
      { token: "foreground", label: "Text" },
      { token: "card", label: "Card" },
      { token: "card-foreground", label: "Card text" },
      { token: "popover", label: "Popover" },
      { token: "popover-foreground", label: "Popover text" },
      { token: "surface", label: "Reading surface" },
      { token: "composer", label: "Composer" },
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
  {
    label: "Charts",
    hint: "The categorical ramp. Ordered — series 1 is the one a reader looks at first.",
    tokens: [
      { token: "chart-1", label: "Series 1" },
      { token: "chart-2", label: "Series 2" },
      { token: "chart-3", label: "Series 3" },
      { token: "chart-4", label: "Series 4" },
      { token: "chart-5", label: "Series 5" },
    ],
  },
]

export const THEME_TOKENS: readonly string[] = THEME_TOKEN_GROUPS.flatMap((g) =>
  g.tokens.map((t) => t.token)
)

// ---- base (mode-independent) tokens ----

export interface FontSlotDef {
  key: string
  label: string
  hint: string
  role: FontRole
  /** The CSS custom property the resolved stack is written to. */
  cssVar: string
}

/** The three font roles the app actually branches on. `font-sans` is the body
    everything inherits, `font-heading` is what `font-heading` (card titles,
    dialog titles, questionnaire steps) picks up, `font-mono` is code, diffs,
    terminals and every tabular number. */
export const FONT_SLOTS: readonly FontSlotDef[] = [
  {
    key: "font-sans",
    label: "Interface",
    hint: "Body text, controls, the sidebar — everything not called out below.",
    role: "sans",
    cssVar: "app-font-sans",
  },
  {
    key: "font-heading",
    label: "Headings",
    hint: "Card, dialog and page titles. Set it to the interface face for a quiet theme.",
    role: "heading",
    cssVar: "app-font-heading",
  },
  {
    key: "font-mono",
    label: "Code",
    hint: "Diffs, terminals, file paths and tabular numbers.",
    role: "mono",
    cssVar: "app-font-mono",
  },
]

export interface RadiusPreset {
  id: string
  label: string
  /** `--radius`; the whole rounded-sm…4xl scale is a multiple of it. */
  value: string
  /** `--radius-pill`, stated rather than derived. A capsule badge is not a
      multiple of a 4px corner — border-radius clamps to half the box, so any
      value over ~10px is a capsule on a 20px-tall chip regardless. A square
      theme has to be able to say "no capsules", and only an explicit value
      can say it. */
  pill: string
}

const FULL = "calc(infinity * 1px)"

/** Corner radius. One value; the whole `--radius-sm … --radius-4xl` scale in
    index.css derives from it, so this single number is the app's entire
    shape language. Presets rather than a free slider because the interesting
    range is small and the named steps are what a theme is actually choosing. */
export const RADIUS_PRESETS: readonly RadiusPreset[] = [
  { id: "square", label: "Square", value: "0rem", pill: "0rem" },
  { id: "sharp", label: "Sharp", value: "0.25rem", pill: "0.375rem" },
  { id: "soft", label: "Soft", value: "0.5rem", pill: FULL },
  { id: "default", label: "Rounded", value: "0.625rem", pill: FULL },
  { id: "round", label: "Round", value: "0.875rem", pill: FULL },
  { id: "pill", label: "Pill", value: "1.25rem", pill: FULL },
]

export interface BlurPreset {
  id: string
  label: string
  hint: string
  value: string
}

/** Backdrop blur behind cards, popovers, the composer and the sidebar — the
    thing that makes those surfaces read as frosted glass rather than as flat
    fills. It is a real design axis and it was hardcoded at 14px: a Paper or a
    Terminal theme wants none of it, and the heavy tiers want visibly more. The
    two stronger tiers in index.css are multiples of this one number. */
export const BLUR_PRESETS: readonly BlurPreset[] = [
  { id: "none", label: "None", hint: "Opaque surfaces. Flat, fast, and legible over anything.", value: "0px" },
  { id: "light", label: "Light", hint: "A hint of the page showing through.", value: "8px" },
  { id: "medium", label: "Medium", hint: "The app's default frost.", value: "14px" },
  { id: "heavy", label: "Heavy", hint: "Pronounced glass — surfaces melt into the page.", value: "24px" },
]

export interface WidthPreset {
  id: string
  label: string
  hint: string
  value: string
}

/** The transcript's content column (`--harness-chat-width`). A measure is a
    typographic decision, not a viewport one — a serif at 640px and a mono at
    880px are both right, and neither is right at the other's width. */
export const WIDTH_PRESETS: readonly WidthPreset[] = [
  { id: "narrow", label: "Narrow", hint: "~70 characters. Best for a serif.", value: "640px" },
  { id: "default", label: "Default", hint: "The app's measure.", value: "748px" },
  { id: "wide", label: "Wide", hint: "Room for code and diffs.", value: "880px" },
  { id: "full", label: "Widest", hint: "Fills a large window.", value: "1100px" },
]

export interface DepthPreset {
  id: string
  label: string
  hint: string
}

/* The values are styles/themes.css's, as `--depth-<id>-glass` /
   `--depth-<id>-glass-lg`, and they are **mode-aware there**: the pair is
   declared once in `:root` and again in `.dark`, because the same black at the
   same opacity that lifts a card off white is invisible over near-black.

   That is what lets depth be a single, mode-independent choice on a theme —
   `--app-shadow-glass: var(--depth-soft-glass)` resolves to whichever pair the
   root is currently in — and it is why this table carries only labels. A
   built-in names its choice the same way a custom theme does, so there is one
   set of shadow values in the app and nothing to keep in sync. */
export const DEPTH_PRESETS: readonly DepthPreset[] = [
  {
    id: "flat",
    label: "Flat",
    hint: "No shadow at all — surfaces separate by colour and hairline only.",
  },
  { id: "subtle", label: "Subtle", hint: "A single hairline drop. Reads as paper, not glass." },
  {
    id: "soft",
    label: "Soft",
    hint: "The app's default — a wide, low-opacity lift under frosted surfaces.",
  },
  { id: "deep", label: "Deep", hint: "Pronounced elevation — panels sit well above the page." },
]

export interface TrackingPreset {
  id: string
  label: string
  value: string
}

/** Body letter-spacing. Part of the *typeface* choice, not a separate taste:
    a geometric sans at UI sizes usually wants a hair of negative tracking and
    a mono-forward theme usually wants none. */
export const TRACKING_PRESETS: readonly TrackingPreset[] = [
  { id: "tight", label: "Tight", value: "-0.011em" },
  { id: "normal", label: "Normal", value: "0em" },
  { id: "wide", label: "Wide", value: "0.012em" },
]

export interface StylePreset {
  id: string
  label: string
  hint: string
  base: BaseTokens
}

/** Whole-Design starting points. Every control on the Design tab is one
    decision, and the decisions are not independent — a serif at 880px with
    capsule badges and heavy glass is six choices that each look defensible and
    together look like nothing. A preset is the coordinated answer; every part
    of it stays editable afterwards, so this is a starting point and not a
    mode. */
export const STYLE_PRESETS: readonly StylePreset[] = [
  {
    id: "studio",
    label: "Studio",
    hint: "The app's own: geometric sans, soft corners, frosted surfaces.",
    base: {
      "font-sans": "figtree",
      "font-heading": "figtree",
      "font-mono": "jetbrains-mono",
      radius: "default",
      depth: "soft",
      tracking: "tight",
      blur: "medium",
      width: "default",
    },
  },
  {
    id: "product",
    label: "Product",
    hint: "Neutral UI sans, restrained corners, a single hairline of lift.",
    base: {
      "font-sans": "inter",
      "font-heading": "inter",
      "font-mono": "geist-mono",
      radius: "soft",
      depth: "subtle",
      tracking: "normal",
      blur: "light",
      width: "default",
    },
  },
  {
    id: "editorial",
    label: "Editorial",
    hint: "Serif body under a display serif, a narrow measure, no glass.",
    base: {
      "font-sans": "source-serif",
      "font-heading": "newsreader",
      "font-mono": "jetbrains-mono",
      radius: "sharp",
      depth: "subtle",
      tracking: "normal",
      blur: "none",
      width: "narrow",
    },
  },
  {
    id: "terminal",
    label: "Terminal",
    hint: "Mono everywhere, square, flat, wide enough for diffs.",
    base: {
      "font-sans": "geist-mono",
      "font-heading": "geist-mono",
      "font-mono": "geist-mono",
      radius: "square",
      depth: "flat",
      tracking: "normal",
      blur: "none",
      width: "wide",
    },
  },
  {
    id: "swiss",
    label: "Swiss",
    hint: "Grid-like: square corners, flat surfaces, generous tracking.",
    base: {
      "font-sans": "inter",
      "font-heading": "inter",
      "font-mono": "geist-mono",
      radius: "square",
      depth: "flat",
      tracking: "wide",
      blur: "none",
      width: "default",
    },
  },
  {
    id: "playful",
    label: "Playful",
    hint: "Fully rounded, deep shadows, heavy glass.",
    base: {
      "font-sans": "figtree",
      "font-heading": "figtree",
      "font-mono": "geist-mono",
      radius: "pill",
      depth: "deep",
      tracking: "tight",
      blur: "heavy",
      width: "default",
    },
  },
]

/** Keys valid in `CustomTheme.base`. */
export const BASE_KEYS = [
  "radius",
  "depth",
  "tracking",
  "blur",
  "width",
  ...FONT_SLOTS.map((s) => s.key),
] as const

export type ThemeTokens = Record<string, string>
/** radius → a RADIUS_PRESETS id, depth → a DEPTH_PRESETS id, tracking → a
    TRACKING_PRESETS id, font-* → a lib/fonts id. A missing key means "inherit
    the app default", which is what makes a v1 theme (no base at all) keep
    rendering exactly as it did. */
export type BaseTokens = Record<string, string>

export interface CustomTheme {
  id: string
  name: string
  light: ThemeTokens
  dark: ThemeTokens
  base: BaseTokens
}

export const isCustomTheme = (value: string): boolean => value.startsWith(PREFIX)
export const customThemeValue = (id: string): string => PREFIX + id
export const customThemeId = (value: string): string => value.slice(PREFIX.length)

const radiusPreset = (id: string | undefined) => RADIUS_PRESETS.find((p) => p.id === id)
const radiusValue = (id: string | undefined) => radiusPreset(id)?.value
const blurValue = (id: string | undefined) => BLUR_PRESETS.find((p) => p.id === id)?.value
const widthValue = (id: string | undefined) => WIDTH_PRESETS.find((p) => p.id === id)?.value
const depthPreset = (id: string | undefined) => DEPTH_PRESETS.find((p) => p.id === id)
const trackingValue = (id: string | undefined) => TRACKING_PRESETS.find((p) => p.id === id)?.value

export { radiusPreset, radiusValue, blurValue, widthValue, depthPreset, trackingValue }

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
    // rgb()/rgba(). The fourth positional arg is alpha in the legacy comma
    // form and is 0–1 (or a percentage) — NOT a fourth 0–255 channel, which is
    // what scaling it alongside r/g/b would make it.
    const [r, g, b] = args.slice(0, 3).map((v) => num(v, 255))
    const legacyAlpha = args[3] === undefined ? undefined : num(args[3])
    const opacity = alphaPart === undefined && legacyAlpha !== undefined ? legacyAlpha : alpha
    return { hex: `#${hex2(byte(r / 255))}${hex2(byte(g / 255))}${hex2(byte(b / 255))}`, alpha: opacity }
  }

  return { hex: "#808080", alpha: 1 }
}

/** Whether `parseColor` can read a value exactly, rather than falling through
    to its grey. */
const isDirectColor = (value: string) =>
  /^(#[0-9a-f]{3,8}|(oklch|rgba?)\()/i.test(value.trim())

/** Resolve any CSS colour value — including the ones `parseColor` cannot read
    on its own — by making the browser do it.

    Two of the tokens a theme can now set (`--composer`, `--surface`) are
    declared in index.css as `color-mix(…)` over other tokens, and a custom
    property's computed value is its *substituted text*, not a colour: reading
    `--composer` off the root gives back the literal `color-mix(in oklch, …)`.
    So the value is assigned to a real property on a throwaway element, whose
    computed value the browser must resolve, and the result is normalized to
    hex through a canvas — the same round-trip `applyThemeColor` uses, and for
    the same reason: it is the cheapest way to turn `oklab()`/`color()` into
    something with two hex digits per channel. */
function resolveColor(value: string, probe: HTMLElement): { hex: string; alpha: number } {
  const raw = value.trim()
  if (!raw) return { hex: "#808080", alpha: 1 }
  if (isDirectColor(raw)) return parseColor(raw)

  probe.style.backgroundColor = ""
  probe.style.backgroundColor = raw
  const used = getComputedStyle(probe).backgroundColor
  if (isDirectColor(used)) return parseColor(used)
  try {
    const ctx = document.createElement("canvas").getContext("2d")
    if (ctx) {
      ctx.fillStyle = "#808080"
      ctx.fillStyle = used
      return parseColor(String(ctx.fillStyle))
    }
  } catch {
    // fall through to grey
  }
  return { hex: "#808080", alpha: 1 }
}

/** Flatten a translucent token onto the surface it sits on, so the editor can
    offer one opaque swatch without changing how the palette reads. */
export function composite(hex: string, alpha: number, over: string): string {
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

/** WCAG contrast ratio, 1–21. The studio warns below 4.5 (AA body text) on the
    pairs that actually carry text, so a pretty theme can't ship unreadable. */
export function contrastRatio(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (high + 0.05) / (low + 0.05)
}

/* The pairs the studio warns on are the pairs the generator gates the
   built-ins with — one list, in theme-ramp.ts, or the two would eventually
   disagree about what counts as readable. */
export { CONTRAST_PAIRS, MIN_CONTRAST } from "./theme-ramp"

// ---- generating a palette ----

/** Coordinated colour starting points. Each is a hue, a brand chroma and a
    neutral tint fed to the same ramp the built-in themes are generated from —
    so "Generate palette" produces something as internally consistent as a
    shipped theme, which thirty-three hand-picked swatches never stay. */
export const PALETTE_PRESETS: readonly ({ id: string; label: string } & RampSpec)[] = [
  { id: "mono", label: "Mono", hue: 50, brand: 0.012, tint: 0.004 },
  { id: "slate", label: "Slate", hue: 264, brand: 0.018, tint: 0.005 },
  { id: "ocean", label: "Ocean", hue: 243, brand: 0.135, tint: 0.016 },
  { id: "teal", label: "Teal", hue: 195, brand: 0.12, tint: 0.014 },
  { id: "forest", label: "Forest", hue: 152, brand: 0.115, tint: 0.014 },
  { id: "gold", label: "Gold", hue: 92, brand: 0.13, tint: 0.015 },
  { id: "ember", label: "Ember", hue: 40, brand: 0.145, tint: 0.018 },
  { id: "rose", label: "Rose", hue: 12, brand: 0.14, tint: 0.016 },
  { id: "magenta", label: "Magenta", hue: 340, brand: 0.15, tint: 0.016 },
  { id: "violet", label: "Violet", hue: 295, brand: 0.15, tint: 0.016 },
]

export type { RampSpec }

/** A ramp spec → the two hex token maps a theme stores. The ramp speaks
    `oklch()` (and gives dark's border/input an alpha), so every value is
    parsed and flattened onto that mode's own background — the studio's swatches
    and its contrast maths both need one opaque colour per token. */
export function paletteFromSpec(spec: RampSpec): { light: ThemeTokens; dark: ThemeTokens } {
  const out = { light: {} as ThemeTokens, dark: {} as ThemeTokens }
  for (const mode of ["light", "dark"] as const) {
    const ramp = mode === "light" ? lightRamp(spec) : darkRamp(spec)
    const background = parseColor(ramp.background)
    for (const token of THEME_TOKENS) {
      const value = ramp[token]
      // --surface and --composer are derived in index.css rather than produced
      // by the ramp; leaving them out means the theme keeps deriving them,
      // which is what a generated palette wants.
      if (!value) continue
      const { hex, alpha } = parseColor(value)
      out[mode][token] = composite(hex, alpha, background.hex)
    }
  }
  return out
}

// ---- seeding from a built-in theme ----

/** Resolve a built-in theme by asking the browser.
    The root's theme attributes are swapped and restored inside one task, so no
    paint happens in between and the user never sees the probe.

    Colours come back as computed values and are parsed; the base half comes
    back from the `--theme-*` echo vars each built-in block declares, which
    carry the *ids* — so a copy of a built-in reopens in the studio with the
    same named radius, fonts and depth it was authored with, rather than with a
    resolved font stack nothing can map back to a picker row. */
export function readTheme(builtin: string, mode: "light" | "dark"): ThemeTokens {
  const root = document.documentElement
  const previousTheme = root.dataset.colorTheme
  const previousDark = root.classList.contains("dark")
  root.dataset.colorTheme = builtin
  root.classList.toggle("dark", mode === "dark")

  const probe = document.createElement("div")
  probe.style.display = "none"
  root.appendChild(probe)

  const computed = getComputedStyle(root)
  const background = resolveColor(computed.getPropertyValue("--background"), probe)
  const tokens: ThemeTokens = {}
  for (const token of THEME_TOKENS) {
    const { hex, alpha } = resolveColor(computed.getPropertyValue(`--${token}`), probe)
    tokens[token] = composite(hex, alpha, background.hex)
  }

  probe.remove()
  if (previousTheme === undefined) delete root.dataset.colorTheme
  else root.dataset.colorTheme = previousTheme
  root.classList.toggle("dark", previousDark)
  return tokens
}

/** The base half of a built-in, read from its `--theme-*` echo vars. A theme
    that declares none (or a value this build no longer knows) yields no key at
    all, which means "inherit the app default" — the same thing a v1 theme
    means, and the safe reading of an unknown id. */
export function readThemeBase(builtin: string): BaseTokens {
  const root = document.documentElement
  const previousTheme = root.dataset.colorTheme
  root.dataset.colorTheme = builtin

  const computed = getComputedStyle(root)
  const read = (name: string) => computed.getPropertyValue(`--theme-${name}`).trim()
  const base: BaseTokens = {}
  const radius = read("radius")
  if (RADIUS_PRESETS.some((p) => p.id === radius)) base.radius = radius
  const depth = read("depth")
  if (DEPTH_PRESETS.some((p) => p.id === depth)) base.depth = depth
  const tracking = read("tracking")
  if (TRACKING_PRESETS.some((p) => p.id === tracking)) base.tracking = tracking
  const blur = read("blur")
  if (BLUR_PRESETS.some((p) => p.id === blur)) base.blur = blur
  const width = read("width")
  if (WIDTH_PRESETS.some((p) => p.id === width)) base.width = width
  for (const slot of FONT_SLOTS) {
    const value = read(slot.key)
    if (value) base[slot.key] = value
  }

  if (previousTheme === undefined) delete root.dataset.colorTheme
  else root.dataset.colorTheme = previousTheme
  return base
}

export function seedTheme(name: string, builtin: string): CustomTheme {
  return {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name,
    light: readTheme(builtin, "light"),
    dark: readTheme(builtin, "dark"),
    base: readThemeBase(builtin),
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
    return raw
      .filter(
        (entry): entry is CustomTheme =>
          !!entry &&
          typeof (entry as CustomTheme).id === "string" &&
          typeof (entry as CustomTheme).name === "string" &&
          isTokens((entry as CustomTheme).light) &&
          isTokens((entry as CustomTheme).dark)
      )
      // A theme saved before the studio grew past colours has no `base`. An
      // empty one emits no declarations, so it inherits the app defaults —
      // which is exactly what it looked like when it was saved.
      .map((entry) => ({ ...entry, base: isTokens(entry.base) ? entry.base : {} }))
  } catch {
    return []
  }
}

const colorDeclarations = (tokens: ThemeTokens) =>
  THEME_TOKENS.filter((token) => tokens[token]).map((token) => `  --${token}: ${tokens[token]};`)

/** The half of a theme that differs by mode: the colours, and only those. */
const modeDeclarations = (theme: CustomTheme, mode: "light" | "dark") =>
  colorDeclarations(theme[mode]).join("\n")

/** The half that does not: radius, fonts, tracking and depth. Emitted in a
    block with no mode qualifier, so it applies to both — including depth,
    whose two `--depth-*` vars are themselves redeclared under `.dark`, so one
    declaration here still yields the right shadow after dark. */
function baseDeclarations(base: BaseTokens): string {
  const lines: string[] = []
  const radius = radiusPreset(base.radius)
  if (radius) {
    lines.push(`  --radius: ${radius.value};`, `  --app-radius-pill: ${radius.pill};`)
  }
  const blur = blurValue(base.blur)
  if (blur) lines.push(`  --app-blur: ${blur};`)
  const width = widthValue(base.width)
  if (width) lines.push(`  --harness-chat-width: ${width};`)
  const tracking = trackingValue(base.tracking)
  if (tracking) lines.push(`  --app-tracking: ${tracking};`)
  if (depthPreset(base.depth)) {
    lines.push(
      `  --app-shadow-glass: var(--depth-${base.depth}-glass);`,
      `  --app-shadow-glass-lg: var(--depth-${base.depth}-glass-lg);`
    )
  }
  for (const slot of FONT_SLOTS) {
    const id = base[slot.key]
    if (id) lines.push(`  --${slot.cssVar}: ${fontStack(id, slot.role)};`)
  }
  return lines.join("\n")
}

/** Same selector shape the built-ins use — the attribute doubled, which
    outranks the defaults in index.css without restricting the block to the
    document element (the gallery previews themes on nested divs). See the
    header of styles/themes.css. A custom theme and a shipped one are
    indistinguishable to every component. */
export function themeCss(theme: CustomTheme): string {
  const value = customThemeValue(theme.id)
  const selector = `[data-color-theme="${value}"][data-color-theme]`
  const blocks: string[] = []
  const base = baseDeclarations(theme.base)
  if (base) blocks.push(`${selector} {\n${base}\n}`)
  const light = modeDeclarations(theme, "light")
  if (light) blocks.push(`${selector}:not(.dark) {\n${light}\n}`)
  const dark = modeDeclarations(theme, "dark")
  if (dark) blocks.push(`${selector}.dark {\n${dark}\n}`)
  return blocks.join("\n\n")
}

/** A theme as inline custom properties, for drawing a *draft* — a sample in
    the studio renders from this rather than from the stylesheet, so an edit
    shows before it is written and a theme can be previewed without wearing it.
    Inline declarations outrank every selector, which is what makes that work.

    It is here rather than in the studio so that the mapping from a stored key
    to a CSS variable — `depth` → two `var(--depth-*)` references, a font id →
    `fontStack()` — has exactly one implementation, shared with `themeCss`. */
export function themeStyleVars(
  theme: CustomTheme,
  mode: "light" | "dark"
): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const token of THEME_TOKENS) {
    const value = theme[mode][token]
    if (value) vars[`--${token}`] = value
  }
  const radius = radiusPreset(theme.base?.radius)
  if (radius) {
    vars["--radius"] = radius.value
    vars["--app-radius-pill"] = radius.pill
  }
  const blur = blurValue(theme.base?.blur)
  if (blur) vars["--app-blur"] = blur
  const width = widthValue(theme.base?.width)
  if (width) vars["--harness-chat-width"] = width
  const tracking = trackingValue(theme.base?.tracking)
  if (tracking) vars["--app-tracking"] = tracking
  if (depthPreset(theme.base?.depth)) {
    vars["--app-shadow-glass"] = `var(--depth-${theme.base.depth}-glass)`
    vars["--app-shadow-glass-lg"] = `var(--depth-${theme.base.depth}-glass-lg)`
  }
  for (const slot of FONT_SLOTS) {
    const id = theme.base?.[slot.key]
    if (id) vars[`--${slot.cssVar}`] = fontStack(id, slot.role)
  }
  return vars
}

/** Every Google family any saved theme names. All of them, not just the worn
    one: the gallery draws a live preview of every theme at once, and a swatch
    rendering in a fallback face is a swatch that lies about what it would look
    like to wear. */
export function webFontsOf(themes: readonly CustomTheme[]): string[] {
  const families = new Set<string>()
  for (const theme of themes) {
    for (const slot of FONT_SLOTS) {
      const id = theme.base?.[slot.key]
      if (id && isGoogleFont(id)) families.add(googleFontFamily(id))
    }
  }
  return [...families]
}

export function applyCustomThemes(themes: CustomTheme[]): void {
  let style = document.getElementById(STYLE_ID)
  if (!style) {
    style = document.createElement("style")
    style.id = STYLE_ID
    document.head.appendChild(style)
  }
  style.textContent = themes.map(themeCss).filter(Boolean).join("\n\n")
  syncWebFonts(webFontsOf(themes))
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

/* Another tab (or another window of the Electron shell) editing a theme is the
   same edit — adopt it instead of letting the two drift apart. */
window.addEventListener("storage", (event) => {
  if (event.key !== null && event.key !== STORAGE_KEY) return
  cache = loadCustomThemes()
  applyCustomThemes(cache)
  for (const listener of listeners) listener()
})
