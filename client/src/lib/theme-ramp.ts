/* ── The palette ramp ──
   One function turns three numbers — a hue, a brand chroma and a neutral tint —
   into a whole coherent palette, light and dark. It is what the twelve built-in
   themes are generated from (scripts/gen-themes.mjs) *and* what the studio's
   "Generate palette" control runs, which is the only reason a user-made theme
   can be as internally consistent as a shipped one: the ramp decides what
   "muted" means relative to "background", and thirty-three hand-picked swatches
   never agree about that for long.

   **This module must stay pure.** It is imported by a Node script as well as by
   the browser (Node 22 strips the types on the way in), so it may not touch
   `document`, `localStorage` or anything else that only exists in a tab.

   Values come out as `oklch(...)` strings because that is what the stylesheet
   wants; the studio converts them to the hex it stores with `parseColor` +
   `composite`, which is also what folds the two alpha-carrying dark tokens
   (border, input) onto their background. */

export interface RampSpec {
  /** 0–360. The whole palette's angle. */
  hue: number
  /** Chroma of --primary. ~0.01 reads as neutral, ~0.16 as saturated. */
  brand: number
  /** Chroma of the neutrals. Above ~0.02 the greys stop reading as grey. */
  tint: number
}

export type Ramp = Record<string, string>

const round = (n: number, places: number) => Number(n.toFixed(places))

export const ok = (L: number, C: number, H: number, alphaPct?: number): string =>
  alphaPct === undefined
    ? `oklch(${round(L, 3)} ${round(C, 3)} ${round(H, 1)})`
    : `oklch(${round(L, 3)} ${round(C, 3)} ${round(H, 1)} / ${alphaPct}%)`

/** Chart hues fan out from the theme's own, so a chart reads as part of the
    theme rather than as a stock ramp dropped on top of it. The offsets are
    uneven on purpose: evenly spaced hues put two adjacent series at the same
    apparent lightness, which is exactly where a reader stops telling them
    apart. */
export const CHART_SPIN = [0, 46, -52, 96, -104]

const spin = (hue: number, i: number) => (hue + CHART_SPIN[i] + 360) % 360

export function lightRamp({ hue: h, brand: C, tint: t }: RampSpec): Ramp {
  const ramp: Ramp = {
    background: ok(0.99, t * 0.35, h),
    foreground: ok(0.205, t * 1.6, h),
    card: ok(1, t * 0.2, h),
    "card-foreground": ok(0.205, t * 1.6, h),
    popover: ok(1, t * 0.2, h),
    "popover-foreground": ok(0.205, t * 1.6, h),
    primary: ok(0.5, C, h),
    "primary-foreground": ok(0.985, Math.min(t, 0.01), h),
    secondary: ok(0.955, t * 1.1, h),
    "secondary-foreground": ok(0.27, t * 2.4, h),
    muted: ok(0.958, t * 0.95, h),
    "muted-foreground": ok(0.475, t * 2.1, h),
    accent: ok(0.928, t * 2.1, h),
    "accent-foreground": ok(0.245, t * 2.8, h),
    destructive: "oklch(0.577 0.245 27.325)",
    border: ok(0.9, t * 1.25, h),
    input: ok(0.895, t * 1.45, h),
    ring: ok(0.62, C * 0.82, h),
    sidebar: ok(0.968, t * 1.15, h),
    "sidebar-foreground": ok(0.205, t * 1.6, h),
    "sidebar-primary": ok(0.5, C, h),
    "sidebar-primary-foreground": ok(0.985, Math.min(t, 0.01), h),
    "sidebar-accent": ok(0.92, t * 2.3, h),
    "sidebar-accent-foreground": ok(0.245, t * 2.8, h),
    "sidebar-border": ok(0.888, t * 1.5, h),
    "sidebar-ring": ok(0.62, C * 0.82, h),
  }
  for (let i = 0; i < CHART_SPIN.length; i++) {
    ramp[`chart-${i + 1}`] = ok(0.605, Math.max(C, 0.035) * 0.95, spin(h, i))
  }
  return ramp
}

export function darkRamp({ hue: h, brand: C, tint: t }: RampSpec): Ramp {
  const ramp: Ramp = {
    background: ok(0.155, t * 2.2, h),
    foreground: ok(0.972, t * 0.6, h),
    card: ok(0.215, t * 2.6, h),
    "card-foreground": ok(0.972, t * 0.6, h),
    popover: ok(0.215, t * 2.6, h),
    "popover-foreground": ok(0.972, t * 0.6, h),
    primary: ok(0.8, C * 0.62, h),
    "primary-foreground": ok(0.17, t * 2.6, h),
    secondary: ok(0.288, t * 3, h),
    "secondary-foreground": ok(0.965, t * 0.7, h),
    muted: ok(0.288, t * 2.8, h),
    "muted-foreground": ok(0.74, t * 1.5, h),
    accent: ok(0.318, t * 3.8, h),
    "accent-foreground": ok(0.965, t * 0.85, h),
    destructive: "oklch(0.704 0.191 22.216)",
    border: ok(0.85, Math.max(C, 0.02) * 0.4, h, 15),
    input: ok(0.85, Math.max(C, 0.02) * 0.4, h, 20),
    ring: ok(0.58, C * 0.75, h),
    sidebar: ok(0.198, t * 2.6, h),
    "sidebar-foreground": ok(0.972, t * 0.6, h),
    "sidebar-primary": ok(0.8, C * 0.62, h),
    "sidebar-primary-foreground": ok(0.17, t * 2.6, h),
    "sidebar-accent": ok(0.318, t * 3.8, h),
    "sidebar-accent-foreground": ok(0.965, t * 0.85, h),
    "sidebar-border": ok(0.85, Math.max(C, 0.02) * 0.4, h, 13),
    "sidebar-ring": ok(0.58, C * 0.75, h),
  }
  for (let i = 0; i < CHART_SPIN.length; i++) {
    ramp[`chart-${i + 1}`] = ok(0.72, Math.max(C, 0.035) * 0.8, spin(h, i))
  }
  return ramp
}

// ---- colour maths, shared with the contrast gate ----

/** oklch(L C H) → sRGB 0–1. Björn Ottosson's matrices. */
export function oklchToRgb(L: number, C: number, hDeg: number): [number, number, number] {
  const h = (hDeg * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}

export const gammaEncode = (x: number) =>
  x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055

const clamp01 = (x: number) => Math.max(0, Math.min(1, x))

/** An `oklch(...)` string from this module → gamma-encoded sRGB 0–1,
    composited over `over` when it carries alpha. Only understands the shape
    `ok()` emits, which is the only shape it is ever handed. */
export function rampRgb(value: string, over?: string): [number, number, number] {
  const m = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+)%)?\)$/.exec(value)
  if (!m) throw new Error(`not a ramp colour: ${value}`)
  const rgb = oklchToRgb(Number(m[1]), Number(m[2]), Number(m[3])).map((x) =>
    clamp01(gammaEncode(x))
  ) as [number, number, number]
  const alpha = m[4] === undefined ? 1 : Number(m[4]) / 100
  if (alpha >= 1 || !over) return rgb
  const base = rampRgb(over)
  return rgb.map((c, i) => c * alpha + base[i] * (1 - alpha)) as [number, number, number]
}

export function relativeLuminance([r, g, b]: [number, number, number]): number {
  const ch = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)
}

/** WCAG contrast between two ramp colours, alpha composited over `over`. */
export function rampContrast(a: string, b: string, over?: string): number {
  const [hi, lo] = [
    relativeLuminance(rampRgb(a, over)),
    relativeLuminance(rampRgb(b, over)),
  ].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** Foreground token → the surface it is drawn on. The contrast gate's subject,
    shared so the generator and the studio warn about exactly the same pairs. */
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

/** WCAG AA for body text. */
export const MIN_CONTRAST = 4.5
