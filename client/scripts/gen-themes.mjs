/* ── Built-in theme generator ──
   Writes src/styles/themes.css. Run with `node scripts/gen-themes.mjs`.

   The palettes are *derived*, not hand-picked: each theme names a hue, a brand
   chroma and a neutral tint, and the ramps below place every token at a fixed
   lightness relative to those. That is what makes twelve themes agree about
   what "muted" means, and it is what lets the contrast check at the bottom be
   a real gate — a hand-authored palette fails it somewhere and gets nudged
   until it passes, which is how the old file drifted into pairs that only
   worked in one mode.

   Character comes from the other half of a theme now: radius, the three font
   roles, depth and tracking. That is the whole point of the refactor — twelve
   recolourings of one layout were never twelve themes.

   This script is checked in and the output is checked in. It is not part of
   the build: themes.css is edited by re-running this, not by hand. */

import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

import {
  CONTRAST_PAIRS,
  darkRamp,
  lightRamp,
  MIN_CONTRAST,
  rampContrast,
  relativeLuminance,
} from "../src/lib/theme-ramp.ts"
import { COLOR_SCHEMES, schemePalette } from "../src/lib/color-schemes.ts"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const OUT_CSS = join(ROOT, "src", "styles", "themes.css")
const OUT_TS = join(ROOT, "src", "lib", "builtin-themes.ts")

/* The ramps, the colour maths and the contrast pairs all come from
   src/lib/theme-ramp.ts — the same module the studio's "Generate palette"
   control runs, so a user-made theme and a shipped one are built by one
   implementation. Node 22 strips the types on import; nothing in that module
   may touch the DOM. */
// ---- the catalog ----

/** A theme's ramp, with its own overrides applied on top. Only Default has
    any: its background is pinned rather than derived (see below). */
const rampOf = (theme, mode) => ({
  ...(mode === "light" ? lightRamp(theme) : darkRamp(theme)),
  ...(theme.overrides?.[mode] ?? {}),
})

/* Shape presets: the base radius and, separately, what `rounded-pill` draws.
   Keep in sync with RADIUS_PRESETS in src/lib/custom-themes.ts, which is what
   the studio offers — these are the values, that is the picker. */
const RADIUS = {
  square: { radius: "0rem", pill: "0rem" },
  sharp: { radius: "0.25rem", pill: "0.375rem" },
  soft: { radius: "0.5rem", pill: "calc(infinity * 1px)" },
  default: { radius: "0.625rem", pill: "calc(infinity * 1px)" },
  round: { radius: "0.875rem", pill: "calc(infinity * 1px)" },
  pill: { radius: "1.25rem", pill: "calc(infinity * 1px)" },
}

/** Glass strength — the backdrop blur behind cards, popovers and the composer.
    Keep in sync with BLUR_PRESETS in src/lib/custom-themes.ts. */
const BLUR = { none: "0px", light: "8px", medium: "14px", heavy: "24px" }

/** The transcript's content column. Keep in sync with WIDTH_PRESETS. */
const WIDTH = { narrow: "640px", default: "748px", wide: "880px", full: "1100px" }

/** The @fontsource families index.css imports. Every one costs bundle size on
    every device, so the coverage gate below refuses a build where one of them
    is not worn by any theme — that is the only signal that an import has gone
    stale. The `system-*` catalog entries are not here: they load nothing. */
const BUNDLED_FONTS = [
  "figtree",
  "inter",
  "geist",
  "roboto",
  "source-serif",
  "newsreader",
  "jetbrains-mono",
  "geist-mono",
]

/* Keep `label` in sync with BUILTIN_THEMES in src/lib/theme.tsx — that array
   is what the gallery and the command palette list, this is what paints. */
const THEMES = [
  {
    id: "default",
    label: "Default",
    note: "The app as it ships: warm neutral, soft corners, frosted surfaces.",
    hue: 50,
    brand: 0.012,
    tint: 0.004,
    radius: "default",
    depth: "soft",
    tracking: "tight",
    blur: "medium",
    width: "default",
    fonts: { sans: "figtree", heading: "figtree", mono: "jetbrains-mono" },
    // The one theme whose background is pinned rather than derived: it is the
    // app's boot colour, duplicated in src/lib/boot-colors.ts for the splash,
    // the manifest and the address bar, none of which can read a stylesheet.
    overrides: {
      light: { background: "oklch(1 0 0)" },
      dark: { background: "oklch(0.147 0.004 49.25)" },
    },
  },
  {
    id: "graphite",
    label: "Graphite",
    note: "Cool grey and near-achromatic. Tight corners, one hairline of lift.",
    hue: 264,
    brand: 0.016,
    tint: 0.005,
    radius: "sharp",
    depth: "subtle",
    tracking: "normal",
    blur: "light",
    width: "default",
    fonts: { sans: "inter", heading: "inter", mono: "geist-mono" },
  },
  {
    id: "ocean",
    label: "Ocean",
    note: "Deep blue, generously rounded, frosted glass throughout.",
    hue: 243,
    brand: 0.135,
    tint: 0.016,
    radius: "round",
    depth: "soft",
    tracking: "tight",
    blur: "medium",
    width: "default",
    fonts: { sans: "inter", heading: "inter", mono: "jetbrains-mono" },
  },
  {
    id: "forest",
    label: "Forest",
    note: "Green and matte, a serif for headings, room enough for diffs.",
    hue: 152,
    brand: 0.115,
    tint: 0.014,
    radius: "soft",
    depth: "subtle",
    tracking: "normal",
    blur: "none",
    width: "wide",
    fonts: { sans: "figtree", heading: "source-serif", mono: "jetbrains-mono" },
  },
  {
    id: "ember",
    label: "Ember",
    note: "Warm orange, fully rounded, deep shadows and heavy glass.",
    hue: 40,
    brand: 0.145,
    tint: 0.018,
    radius: "pill",
    depth: "deep",
    tracking: "tight",
    blur: "heavy",
    width: "default",
    fonts: { sans: "figtree", heading: "figtree", mono: "geist-mono" },
  },
  {
    id: "violet",
    label: "Violet",
    note: "Saturated purple on a narrow measure — dramatic and focused.",
    hue: 295,
    brand: 0.15,
    tint: 0.016,
    radius: "round",
    depth: "deep",
    tracking: "tight",
    blur: "heavy",
    width: "narrow",
    fonts: { sans: "geist", heading: "geist", mono: "geist-mono" },
  },
  {
    id: "paper",
    label: "Paper",
    note: "Warm off-white, serif body under a display serif. Reads like print.",
    hue: 78,
    brand: 0.05,
    tint: 0.012,
    radius: "sharp",
    depth: "subtle",
    tracking: "normal",
    blur: "none",
    width: "narrow",
    fonts: { sans: "source-serif", heading: "newsreader", mono: "jetbrains-mono" },
  },
  {
    id: "terminal",
    label: "Terminal",
    note: "Monospace everywhere, square, flat, as wide as the window allows.",
    hue: 148,
    brand: 0.15,
    tint: 0.008,
    radius: "square",
    depth: "flat",
    tracking: "normal",
    blur: "none",
    width: "full",
    fonts: { sans: "geist-mono", heading: "geist-mono", mono: "geist-mono" },
  },
  {
    id: "claude",
    label: "Claude",
    note: "Anthropic's warm clay, with a serif for headings.",
    hue: 45,
    brand: 0.125,
    tint: 0.01,
    radius: "round",
    depth: "soft",
    tracking: "tight",
    blur: "medium",
    width: "default",
    fonts: { sans: "figtree", heading: "source-serif", mono: "jetbrains-mono" },
  },
  {
    id: "codex",
    label: "Codex",
    note: "OpenAI monochrome, Swiss: square, flat, openly tracked.",
    hue: 270,
    brand: 0.014,
    tint: 0.004,
    radius: "square",
    depth: "flat",
    tracking: "wide",
    blur: "none",
    width: "wide",
    fonts: { sans: "inter", heading: "inter", mono: "geist-mono" },
  },
  {
    id: "gemini",
    label: "Gemini",
    note: "Google's blue-violet, capsule shapes, heavy frosted glass.",
    hue: 262,
    brand: 0.16,
    tint: 0.013,
    radius: "pill",
    depth: "soft",
    tracking: "tight",
    blur: "heavy",
    width: "default",
    fonts: { sans: "geist", heading: "geist", mono: "geist-mono" },
  },
  {
    id: "copilot",
    label: "Copilot",
    note: "GitHub blue, restrained corners, a densely setting UI sans.",
    hue: 228,
    brand: 0.095,
    tint: 0.007,
    radius: "soft",
    depth: "soft",
    tracking: "normal",
    blur: "light",
    width: "default",
    fonts: { sans: "roboto", heading: "inter", mono: "geist-mono" },
  },
]

// ---- the gates ----

/* Three things are checked before anything is written, because all three went
   wrong by hand and none of them is visible in a diff.

   1. Contrast: every foreground/surface pair at WCAG AA for body text.
   2. Distinctness: no two themes may share a design signature. Graphite and
      Codex were literally the same theme — same radius, depth, tracking, blur,
      measure and all three fonts, six degrees apart in hue — which is the exact
      failure this whole refactor was meant to end. A hue is not a theme.
   3. Coverage: every preset value has to be worn by at least one built-in.
      A shape or a depth nothing ships is a control the user meets with no
      example of what it does — and `roboto` sat in the bundle for months
      without a single theme naming it, which is bytes shipped to every device
      for nothing. */

const signature = (theme) =>
  [
    theme.radius,
    theme.depth,
    theme.tracking,
    theme.blur,
    theme.width,
    theme.fonts.sans,
    theme.fonts.heading,
    theme.fonts.mono,
  ].join("·")

const failures = []

const seen = new Map()
for (const theme of THEMES) {
  const key = signature(theme)
  if (seen.has(key)) failures.push(`${theme.id} is design-identical to ${seen.get(key)}: ${key}`)
  else seen.set(key, theme.id)
}

for (const [axis, values] of Object.entries({
  radius: Object.keys(RADIUS),
  depth: ["flat", "subtle", "soft", "deep"],
  tracking: ["tight", "normal", "wide"],
  blur: Object.keys(BLUR),
  width: Object.keys(WIDTH),
})) {
  for (const value of values) {
    if (!THEMES.some((theme) => theme[axis] === value)) {
      failures.push(`no built-in theme uses ${axis}: ${value}`)
    }
  }
}

/* The curated colour schemes (lib/color-schemes.ts) are studio presets rather
   than shipped themes, so they never reach this file — but they are palettes a
   user can wear with one click, and they are transcribed from editor schemes
   whose comment tones were never meant to carry UI text. They get the same
   gate. Their values are plain hex, so the contrast maths is done here rather
   than through rampContrast, which speaks oklch. */
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
const hexContrast = (a, b) => {
  const [hi, lo] = [relativeLuminance(hexRgb(a)), relativeLuminance(hexRgb(b))].sort(
    (x, y) => y - x
  )
  return (hi + 0.05) / (lo + 0.05)
}
for (const scheme of COLOR_SCHEMES) {
  for (const mode of ["light", "dark"]) {
    const palette = schemePalette(scheme[mode])
    for (const [fg, bg] of Object.entries(CONTRAST_PAIRS)) {
      const ratio = hexContrast(palette[fg], palette[bg])
      if (ratio < MIN_CONTRAST) {
        failures.push(
          `scheme ${scheme.id}/${mode}: --${fg} on --${bg} = ${ratio.toFixed(2)}:1 (AA needs ${MIN_CONTRAST}:1)`
        )
      }
    }
  }
}

const namedFonts = new Set(THEMES.flatMap((t) => Object.values(t.fonts)))
for (const font of BUNDLED_FONTS) {
  if (!namedFonts.has(font)) failures.push(`bundled font never used by a theme: ${font}`)
}

for (const theme of THEMES) {
  for (const mode of ["light", "dark"]) {
    const ramp = rampOf(theme, mode)
    for (const [fg, bg] of Object.entries(CONTRAST_PAIRS)) {
      const ratio = rampContrast(ramp[fg], ramp[bg], ramp.background)
      if (ratio < MIN_CONTRAST) {
        failures.push(
          `${theme.id}/${mode}: --${fg} on --${bg} = ${ratio.toFixed(2)}:1 (AA needs ${MIN_CONTRAST}:1)`
        )
      }
    }
  }
}
if (failures.length) {
  console.error("Theme gates failed:")
  for (const line of failures) console.error("  " + line)
  process.exit(1)
}

// ---- emit ----

const decls = (map) =>
  Object.entries(map)
    .map(([k, v]) => `  --${k}: ${v};`)
    .join("\n")

function block(theme) {
  const base = {
    radius: RADIUS[theme.radius].radius,
    "app-radius-pill": RADIUS[theme.radius].pill,
    "app-blur": BLUR[theme.blur],
    "harness-chat-width": WIDTH[theme.width],
    "app-font-sans": `var(--font-family-${theme.fonts.sans})`,
    "app-font-heading": `var(--font-family-${theme.fonts.heading})`,
    "app-font-mono": `var(--font-family-${theme.fonts.mono})`,
    "app-shadow-glass": `var(--depth-${theme.depth}-glass)`,
    "app-shadow-glass-lg": `var(--depth-${theme.depth}-glass-lg)`,
    "app-tracking": `var(--tracking-${theme.tracking})`,
    // Echo vars: the studio's seeder reads the *ids* back off these, so a copy
    // of a built-in reopens with the same named radius, fonts and depth it was
    // authored with rather than with a resolved stack nothing maps to a picker
    // row. See readThemeBase() in src/lib/custom-themes.ts.
    "theme-radius": theme.radius,
    "theme-depth": theme.depth,
    "theme-tracking": theme.tracking,
    "theme-blur": theme.blur,
    "theme-width": theme.width,
    "theme-font-sans": theme.fonts.sans,
    "theme-font-heading": theme.fonts.heading,
    "theme-font-mono": theme.fonts.mono,
  }
  // The attribute is repeated on purpose — see the header comment.
  const sel = `[data-color-theme="${theme.id}"][data-color-theme]`
  return [
    `${sel} {\n${decls(base)}\n}`,
    `${sel}:not(.dark) {\n${decls(rampOf(theme, "light"))}\n}`,
    `${sel}.dark {\n${decls(rampOf(theme, "dark"))}\n}`,
  ].join("\n\n")
}

const HEADER = `/* ── Themes ──
   GENERATED by scripts/gen-themes.mjs — edit that, then re-run it. The ramps
   are derived from a hue, a brand chroma and a neutral tint per theme, and the
   generator refuses to write a file where any foreground/surface pair falls
   below WCAG AA for body text.

   A theme is three blocks, split by what the value depends on:

     [data-color-theme="x"][data-color-theme]            radius, fonts, depth
                                                         and tracking — none of
                                                         which change with mode
     [data-color-theme="x"][data-color-theme]:not(.dark) the light colours
     [data-color-theme="x"][data-color-theme].dark       the dark colours

   **The attribute is written twice on purpose.** It has to out-specify the
   defaults in index.css, which sit at (0,1,0) for \`:root\`/\`.dark\` and
   (0,2,0) for the \`:root:not(.dark)\` block that derives --composer: a single
   \`[data-color-theme="x"]\` is (0,1,0) and loses the radius and font
   declarations outright, and \`[...]:not(.dark)\` is (0,2,0) and ties on
   --composer, which source order then hands to index.css. Doubling the
   attribute buys one level (0,2,0 / 0,3,0) and changes nothing about what
   matches.

   The obvious alternative — \`:root[...]\` — buys the same level but restricts
   the block to the document element, and the gallery draws a live preview of
   every theme by putting \`data-color-theme\` on a nested <div>. That would
   have left twelve identical swatches.

   User-made themes are NOT here — the studio writes them into a
   <style id="daedalus-custom-themes"> element at runtime
   (src/lib/custom-themes.ts) using this exact vocabulary. Adding a token here
   means adding it to THEME_TOKEN_GROUPS there. */

/* ── The font vocabulary ──
   One declaration per bundled family, named by the id lib/fonts.ts offers in
   its picker. Both a built-in theme (above) and a user-made one (which emits
   \`var(--font-family-<id>)\` from fontStack()) resolve through these, so the
   real face name @fontsource registers is spelled exactly once in the app.
   Every entry needs a matching @import in index.css. */
:root {
  --font-family-figtree: 'Figtree Variable', ui-sans-serif, system-ui, sans-serif;
  --font-family-inter: 'Inter Variable', ui-sans-serif, system-ui, sans-serif;
  --font-family-geist: 'Geist Variable', ui-sans-serif, system-ui, sans-serif;
  --font-family-roboto: 'Roboto Variable', ui-sans-serif, system-ui, sans-serif;
  --font-family-source-serif: 'Source Serif 4 Variable', ui-serif, Georgia, serif;
  --font-family-newsreader: 'Newsreader', ui-serif, Georgia, serif;
  --font-family-jetbrains-mono: 'JetBrains Mono Variable', ui-monospace, Menlo, monospace;
  --font-family-geist-mono: 'Geist Mono Variable', ui-monospace, Menlo, monospace;

  --tracking-tight: -0.011em;
  --tracking-normal: 0em;
  --tracking-wide: 0.012em;
}

/* ── The depth vocabulary ──
   Named shadow pairs, declared once here and again under \`.dark\`. That
   redeclaration is what lets depth be a single, mode-independent choice on a
   theme: \`--app-shadow-glass: var(--depth-soft-glass)\` resolves to whichever
   pair the root is currently in. The dark values are far heavier because the
   same black at 6% that lifts a card off white is invisible over near-black —
   a card there separated only by its own fill.
   Labels for these live in DEPTH_PRESETS (src/lib/custom-themes.ts). */
:root {
  --depth-flat-glass: none;
  --depth-flat-glass-lg: none;
  --depth-subtle-glass: 0 1px 2px oklch(0 0 0 / 5%);
  --depth-subtle-glass-lg: 0 2px 6px oklch(0 0 0 / 7%);
  --depth-soft-glass: 0 8px 32px oklch(0 0 0 / 6%), 0 1px 4px oklch(0 0 0 / 4%);
  --depth-soft-glass-lg: 0 16px 48px oklch(0 0 0 / 10%), 0 2px 8px oklch(0 0 0 / 6%);
  --depth-deep-glass: 0 12px 40px oklch(0 0 0 / 12%), 0 2px 8px oklch(0 0 0 / 8%);
  --depth-deep-glass-lg: 0 28px 72px oklch(0 0 0 / 18%), 0 4px 14px oklch(0 0 0 / 12%);
}

.dark {
  --depth-subtle-glass: 0 1px 2px oklch(0 0 0 / 30%);
  --depth-subtle-glass-lg: 0 2px 8px oklch(0 0 0 / 38%);
  --depth-soft-glass: 0 8px 32px oklch(0 0 0 / 34%), 0 1px 4px oklch(0 0 0 / 26%);
  --depth-soft-glass-lg: 0 16px 48px oklch(0 0 0 / 46%), 0 2px 8px oklch(0 0 0 / 32%);
  --depth-deep-glass: 0 12px 40px oklch(0 0 0 / 50%), 0 2px 8px oklch(0 0 0 / 38%);
  --depth-deep-glass-lg: 0 28px 72px oklch(0 0 0 / 62%), 0 4px 14px oklch(0 0 0 / 46%);
}
`

writeFileSync(OUT_CSS, HEADER + "\n" + THEMES.map(block).join("\n\n") + "\n")

/* The list the app lists. It used to be hand-maintained in lib/theme.tsx with
   a "keep in sync" comment on both ends, which is how Sunset and Slate outlived
   the blocks that painted them. It is emitted from the same table now, so a
   theme exists in exactly one place and its label and note cannot drift from
   its CSS. */
const TS_HEADER = `/* GENERATED by scripts/gen-themes.mjs — do not edit.
   The themes that ship in styles/themes.css, in gallery order. Emitted from
   the same table that writes the CSS so a label can never name a block that
   does not exist (and vice versa): add a theme to THEMES there and re-run
   \`pnpm themes\`. */

export interface BuiltinTheme {
  value: string
  label: string
  /** One line for the gallery: what this theme *is*, past its hue. */
  note: string
}

export const BUILTIN_THEMES: readonly BuiltinTheme[] = [
`
writeFileSync(
  OUT_TS,
  TS_HEADER +
    THEMES.map(
      (t) =>
        `  { value: ${JSON.stringify(t.id)}, label: ${JSON.stringify(t.label)}, note: ${JSON.stringify(t.note)} },`
    ).join("\n") +
    "\n]\n"
)

console.log(
  `wrote ${OUT_CSS} + ${OUT_TS} — ${THEMES.length} themes + ${COLOR_SCHEMES.length} schemes, all gates passed`
)
