/* ── The built-in schemes ──
   Built-in themes beside Default, written to a stylesheet at load by
   `applyBuiltinSchemes` (custom-themes.ts) and listed by builtin-themes.ts.
   `PALETTE_PRESETS` (custom-themes.ts) drives the ramp in theme-ramp.ts from a
   hue, which guarantees coherence and AA but can only ever produce the same
   design in a different colour. These are the opposite: the look of the AI products people already live in — OpenCode,
   Claude, ChatGPT, Gemini, Perplexity, Grok, Cursor, Copilot — where the relationship between the
   neutrals and the one accent is the whole point and no formula would land on
   it.

   **None of these products publishes a token table**, so the values are the
   products' own surfaces *as shipped*, approximated and then adjusted: every
   entry says in `source` what it was modelled on. Where a product's own accent
   fails WCAG AA for a button label or for secondary text, the nearest passing
   shade of the same hue is used and the line is marked `adjusted:`. Every pair in
   `CONTRAST_PAIRS` must clear AA in both modes.

   A product has fewer named surfaces than this app, so where it runs out of
   steps the gap is filled from its own neighbours and marked `derived:`, never
   by a colour from outside the palette.

   A scheme also carries the **Design half** that goes with it — Claude under a
   geometric sans with capsule badges is not Claude. To change one, "New theme"
   copies the one you are wearing into the studio. Colours are
   transcribed as colours: no logo, wordmark or typeface is bundled. */

import type { BaseTokens, ThemeTokens } from "./custom-themes"

export interface SchemeAnchors {
  /** --background */
  bg: string
  /** --card / --popover: the panel that floats on the page. */
  card: string
  /** --muted / --secondary: the quiet surface, e.g. a user's own message. */
  muted: string
  /** --accent: one step further from the background than muted. */
  accent: string
  /** --border / --input */
  border: string
  /** --foreground */
  fg: string
  /** --muted-foreground: secondary text, which must clear AA on `muted`. */
  fgMuted: string
  primary: string
  primaryFg: string
  destructive: string
  /** --sidebar. Defaults to `card`. */
  sidebar?: string
  /** --chart-1…5, in reading order. */
  charts: readonly [string, string, string, string, string]
}

export interface ColorScheme {
  id: string
  label: string
  /** Shown under the name — what the scheme is, in a few words. */
  note: string
  /** What it was modelled on, so the next person can re-check it. */
  source: string
  light: SchemeAnchors
  dark: SchemeAnchors
  /** The Design half this scheme is applied with. */
  design: BaseTokens
}

export const COLOR_SCHEMES: readonly ColorScheme[] = [
  {
    id: "opencode",
    label: "OpenCode",
    note: "Terminal-black with a peach primary. Flat, square, mono-leaning.",
    source: "OpenCode's default TUI theme (peach primary, blue/violet secondaries), as recalled",
    light: {
      bg: "#ffffff",
      card: "#fafafa",
      muted: "#f5f5f5",
      accent: "#ebebeb",
      border: "#d4d4d4", // adjusted: the TUI's #b8b8b8 border is heavy as a hairline
      fg: "#1a1a1a",
      fgMuted: "#5f5f5f", // adjusted: the TUI's muted #8a8a8a is 3.2:1
      primary: "#3b6fc4", // adjusted from the TUI's #3b7dd8 for a white label
      primaryFg: "#ffffff",
      destructive: "#d1383d",
      sidebar: "#fafafa",
      charts: ["#3b6fc4", "#7b5bb6", "#d68c27", "#3d9a57", "#318795"],
    },
    dark: {
      bg: "#0a0a0a",
      card: "#141414",
      muted: "#1e1e1e",
      accent: "#2a2a2a",
      border: "#2f2f2f", // adjusted: the TUI's #484848 is a frame, not a hairline
      fg: "#eeeeee",
      fgMuted: "#9a9a9a", // adjusted: the TUI's muted #808080 is 4.2:1 on #1e1e1e
      primary: "#fab283",
      primaryFg: "#0a0a0a",
      destructive: "#e06c75",
      sidebar: "#0a0a0a",
      charts: ["#fab283", "#5c9cf5", "#9d7cd8", "#7fd88f", "#e5c07b"],
    },
    design: {
      "font-sans": "geist",
      "font-heading": "geist",
      "font-mono": "geist-mono",
      radius: "sharp",
      depth: "flat",
      tracking: "normal",
      blur: "none",
      width: "wide",
    },
  },
  {
    id: "claude",
    label: "Claude",
    note: "Warm ivory and charcoal, a clay accent, serif headings.",
    source: "claude.ai's surfaces: ivory/oat neutrals, clay (#d97757) accent",
    light: {
      bg: "#faf9f5",
      card: "#ffffff",
      muted: "#f0eee6",
      accent: "#e8e6dc",
      border: "#e3dfd2", // derived
      fg: "#141413",
      fgMuted: "#5e5d59",
      primary: "#b5502f", // adjusted: clay #d97757 is 3.1:1 under a white label
      primaryFg: "#ffffff",
      destructive: "#b53333",
      sidebar: "#f0eee6",
      charts: ["#c96442", "#6a9bcc", "#788c5d", "#d4a27f", "#8b6f9e"],
    },
    dark: {
      bg: "#262624",
      card: "#30302e",
      muted: "#30302e",
      accent: "#3d3d3a",
      border: "#3d3d3a",
      fg: "#faf9f5",
      fgMuted: "#c2c0b6",
      primary: "#d97757",
      primaryFg: "#1f1e1d",
      destructive: "#ef6b63",
      sidebar: "#1f1e1d",
      charts: ["#d97757", "#6a9bcc", "#9aae7c", "#d4a27f", "#b79ac8"],
    },
    design: {
      "font-sans": "inter",
      "font-heading": "newsreader",
      "font-mono": "jetbrains-mono",
      radius: "round",
      depth: "subtle",
      tracking: "normal",
      blur: "none",
      width: "narrow",
    },
  },
  {
    id: "chatgpt",
    label: "ChatGPT",
    note: "White and graphite, an inverted black button, capsule shapes.",
    source: "chatgpt.com's surfaces: #fff / #212121, #171717 sidebar, #10a37f as the green",
    light: {
      bg: "#ffffff",
      card: "#ffffff",
      muted: "#f4f4f4",
      accent: "#ececec",
      border: "#e5e5e5",
      fg: "#0d0d0d",
      fgMuted: "#5d5d5d",
      primary: "#0d0d0d",
      primaryFg: "#ffffff",
      destructive: "#e02e2a",
      sidebar: "#f9f9f9",
      charts: ["#10a37f", "#5d5d5d", "#3b82f6", "#f59e0b", "#e02e2a"],
    },
    dark: {
      bg: "#212121",
      card: "#2a2a2a", // derived: between the page and the composer's #303030
      muted: "#303030",
      accent: "#424242",
      border: "#383838",
      fg: "#ececec",
      fgMuted: "#b4b4b4",
      primary: "#ececec",
      primaryFg: "#0d0d0d",
      destructive: "#f4605c",
      sidebar: "#171717",
      charts: ["#19c37d", "#b4b4b4", "#6ea8fe", "#f5b94a", "#f4605c"],
    },
    design: {
      "font-sans": "inter",
      "font-heading": "inter",
      "font-mono": "geist-mono",
      radius: "pill",
      depth: "flat",
      tracking: "normal",
      blur: "none",
      width: "default",
    },
  },
  {
    id: "gemini",
    label: "Gemini",
    note: "Google blue on cool greys, Material-soft, big round corners.",
    source: "gemini.google.com's surfaces: #fff / #131314, #f0f4f9 / #1e1f20 rails, Google blue",
    light: {
      bg: "#ffffff",
      card: "#ffffff",
      muted: "#f0f4f9",
      accent: "#dde3ea",
      border: "#c4c7c5",
      fg: "#1f1f1f",
      fgMuted: "#444746",
      primary: "#0b57d0",
      primaryFg: "#ffffff",
      destructive: "#b3261e",
      sidebar: "#f0f4f9",
      charts: ["#4285f4", "#ea4335", "#fbbc04", "#34a853", "#a142f4"],
    },
    dark: {
      bg: "#131314",
      card: "#1e1f20",
      muted: "#282a2c",
      accent: "#333537",
      border: "#444746",
      fg: "#e3e3e3",
      fgMuted: "#c4c7c5",
      primary: "#a8c7fa",
      primaryFg: "#062e6f",
      destructive: "#f2b8b5",
      sidebar: "#1e1f20",
      charts: ["#8ab4f8", "#f28b82", "#fdd663", "#81c995", "#c58af9"],
    },
    design: {
      "font-sans": "roboto",
      "font-heading": "roboto",
      "font-mono": "jetbrains-mono",
      radius: "pill",
      depth: "subtle",
      tracking: "normal",
      blur: "light",
      width: "default",
    },
  },
  {
    id: "perplexity",
    label: "Perplexity",
    note: "Paper-cream and deep teal on light; charcoal and aqua on dark.",
    source: "perplexity.ai's surfaces: cream paper, #13343b ink, teal (#21808d / #32b8c6)",
    light: {
      bg: "#fcfcf9",
      card: "#fffffd",
      muted: "#f3f3ee",
      accent: "#e7e7e0",
      border: "#dcdcd3", // derived
      fg: "#13343b",
      fgMuted: "#4f6469", // derived: ink lightened for AA on muted
      primary: "#21808d",
      primaryFg: "#ffffff",
      destructive: "#c0152f",
      sidebar: "#f3f3ee",
      charts: ["#21808d", "#a84b2f", "#626c71", "#e68161", "#5e5240"],
    },
    dark: {
      bg: "#1f2121",
      card: "#262828",
      muted: "#2d3030",
      accent: "#393c3d",
      border: "#3a3d3e",
      fg: "#f5f5f5",
      fgMuted: "#b5babb", // derived
      primary: "#32b8c6",
      primaryFg: "#13343b",
      destructive: "#ff5459",
      sidebar: "#1a1c1c",
      charts: ["#32b8c6", "#e68161", "#a8b2b5", "#e7b07a", "#7aa9d6"],
    },
    design: {
      "font-sans": "inter",
      "font-heading": "source-serif",
      "font-mono": "jetbrains-mono",
      radius: "round",
      depth: "subtle",
      tracking: "normal",
      blur: "none",
      width: "default",
    },
  },
  {
    id: "grok",
    label: "Grok",
    note: "Monochrome and near-black, no accent colour, sharp and quiet.",
    source: "grok.com's surfaces: pure neutrals, a white-on-black inverse button",
    light: {
      bg: "#ffffff",
      card: "#ffffff",
      muted: "#f5f5f5",
      accent: "#ebebeb",
      border: "#e4e4e4",
      fg: "#0a0a0a",
      fgMuted: "#5c5c5c",
      primary: "#0a0a0a",
      primaryFg: "#ffffff",
      destructive: "#dc2626",
      sidebar: "#fafafa",
      charts: ["#0a0a0a", "#6b6b6b", "#2563eb", "#d97706", "#dc2626"],
    },
    dark: {
      bg: "#101010",
      card: "#171717",
      muted: "#1f1f1f",
      accent: "#2a2a2a",
      border: "#2e2e2e",
      fg: "#f2f2f2",
      fgMuted: "#a1a1a1",
      primary: "#f2f2f2",
      primaryFg: "#0a0a0a",
      destructive: "#f87171",
      sidebar: "#0b0b0b",
      charts: ["#f2f2f2", "#a1a1a1", "#60a5fa", "#fbbf24", "#f87171"],
    },
    design: {
      "font-sans": "geist",
      "font-heading": "geist",
      "font-mono": "geist-mono",
      radius: "soft",
      depth: "flat",
      tracking: "tight",
      blur: "none",
      width: "default",
    },
  },
  {
    id: "cursor",
    label: "Cursor",
    note: "Warm paper and charcoal with an orange accent, editor-tight.",
    source: "cursor.com's surfaces: warm off-white (#f7f7f4) / #181818, orange (#f54e00)",
    light: {
      bg: "#f7f7f4",
      card: "#fcfcfa", // derived
      muted: "#efeee9",
      accent: "#e6e5e0",
      border: "#dcdbd4",
      fg: "#26251e",
      fgMuted: "#5c5b54",
      primary: "#c23f00", // adjusted: #f54e00 is 3.5:1 under a white label
      primaryFg: "#ffffff",
      destructive: "#cf2d56",
      sidebar: "#efeee9",
      charts: ["#c23f00", "#4a7ab5", "#5f8a5a", "#b8892b", "#9b5fa8"],
    },
    dark: {
      bg: "#181818",
      card: "#1e1e1e",
      muted: "#262626",
      accent: "#333333",
      border: "#2f2f2f",
      fg: "#ededed",
      fgMuted: "#a3a3a3",
      primary: "#f54e00",
      primaryFg: "#141414",
      destructive: "#f0647f",
      sidebar: "#141414",
      charts: ["#f54e00", "#6aa0e0", "#7fb87a", "#e0b04a", "#c58ad0"],
    },
    design: {
      "font-sans": "inter",
      "font-heading": "inter",
      "font-mono": "jetbrains-mono",
      radius: "soft",
      depth: "subtle",
      tracking: "normal",
      blur: "none",
      width: "default",
    },
  },
  {
    id: "copilot",
    label: "Copilot",
    note: "GitHub's Primer greys with Copilot purple.",
    source: "GitHub Primer light / dark (canvas, border, fg) with Copilot's purple accent",
    light: {
      bg: "#ffffff",
      card: "#ffffff",
      muted: "#f6f8fa",
      accent: "#eaeef2",
      border: "#d1d9e0",
      fg: "#1f2328",
      fgMuted: "#59636e",
      primary: "#8250df",
      primaryFg: "#ffffff",
      destructive: "#d1242f",
      sidebar: "#f6f8fa",
      charts: ["#8250df", "#0969da", "#1a7f37", "#bf8700", "#bf3989"],
    },
    dark: {
      bg: "#0d1117",
      card: "#151b23",
      muted: "#212830",
      accent: "#2a313c",
      border: "#3d444d",
      fg: "#f0f6fc",
      fgMuted: "#9198a1",
      primary: "#ab7df8",
      primaryFg: "#0d1117",
      destructive: "#f85149",
      sidebar: "#010409",
      charts: ["#ab7df8", "#4493f8", "#3fb950", "#d29922", "#db61a2"],
    },
    design: {
      "font-sans": "inter",
      "font-heading": "inter",
      "font-mono": "jetbrains-mono",
      radius: "soft",
      depth: "subtle",
      tracking: "normal",
      blur: "none",
      width: "default",
    },
  },
]

/** Anchors → the token map a theme stores.

    `--surface` and `--composer` are deliberately absent: index.css derives both
    from the palette, and a scheme that named them would lose the light/dark
    asymmetry that derivation exists to provide. */
export function schemePalette(anchors: SchemeAnchors): ThemeTokens {
  const sidebar = anchors.sidebar ?? anchors.card
  const tokens: ThemeTokens = {
    background: anchors.bg,
    foreground: anchors.fg,
    card: anchors.card,
    "card-foreground": anchors.fg,
    popover: anchors.card,
    "popover-foreground": anchors.fg,
    primary: anchors.primary,
    "primary-foreground": anchors.primaryFg,
    secondary: anchors.muted,
    "secondary-foreground": anchors.fg,
    muted: anchors.muted,
    "muted-foreground": anchors.fgMuted,
    accent: anchors.accent,
    "accent-foreground": anchors.fg,
    destructive: anchors.destructive,
    border: anchors.border,
    input: anchors.border,
    ring: anchors.primary,
    sidebar,
    "sidebar-foreground": anchors.fg,
    "sidebar-primary": anchors.primary,
    "sidebar-primary-foreground": anchors.primaryFg,
    "sidebar-accent": anchors.accent,
    "sidebar-accent-foreground": anchors.fg,
    "sidebar-border": anchors.border,
    "sidebar-ring": anchors.primary,
  }
  anchors.charts.forEach((hex, i) => {
    tokens[`chart-${i + 1}`] = hex
  })
  return tokens
}
