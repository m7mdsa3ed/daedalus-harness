/* ── Curated colour schemes ──
   The other kind of colour preset. `PALETTE_PRESETS` (custom-themes.ts) drives
   the ramp in theme-ramp.ts from a hue, which guarantees coherence and AA but
   can only ever produce the same design in a different colour. These are the
   opposite: real, hand-authored schemes with identities of their own, where the
   relationship between the greens and the purples is the whole point and no
   formula would land on it.

   **The values are transcribed from each project's own source**, not recalled
   or eyedropped — see the `source` on every entry. Six schemes were verified
   against those files; Tokyo Night was dropped because its light variant is
   computed by an `invert()` function rather than published as a table, and a
   guess shipped under that name is worse than its absence.

   Two honest caveats, both of which the comments below mark per scheme.

   **These are editor schemes, and an editor has fewer surfaces than this app.**
   Every one of them names a background, a foreground, a comment colour and a
   set of accents; none names "the colour of a popover behind a card on a
   sidebar". So where a scheme runs out of documented steps, the gap is filled
   by a value derived from its own neighbours and marked `derived:` — never by a
   colour from outside the palette.

   **A comment colour is not body text.** Several schemes' comment tones fall
   under WCAG AA against the surface this app puts secondary text on, because in
   an editor they sit on the plain background and are *meant* to recede. Where
   that happens the scheme's own next-brighter documented neutral is used for
   `--muted-foreground` instead, and the swap is marked. The gate in
   scripts/gen-themes.mjs is what enforces this, and it runs over these exactly
   as it runs over the built-ins.

   All six are MIT-licensed. Nothing here is redistributed but the colour
   values, which is what a "theme preset" is. */

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
  /** Shown under the name — what the scheme is, in the author's own terms. */
  note: string
  /** Where the values came from, so the next person can re-check them. */
  source: string
  light: SchemeAnchors
  dark: SchemeAnchors
  /** The Design half this scheme is applied with. A curated scheme is a whole
      look, and Gruvbox under a geometric sans with capsule badges is not
      Gruvbox — so the preset carries the shape and type that go with it. Every
      part stays editable on the Design tab afterwards, and Revert undoes the
      lot. */
  design: BaseTokens
}

export const COLOR_SCHEMES: readonly ColorScheme[] = [
  {
    id: "nord",
    label: "Nord",
    note: "Arctic, north-bluish. Polar Night under Snow Storm.",
    source: "nordtheme/nord src/nord.css (--nord0…15)",
    // Nord publishes no official *light* variant; Snow Storm (nord4–6) is the
    // documented light base and Polar Night the text, which is how every Nord
    // light port is built. `card` is the one value outside the sixteen.
    light: {
      bg: "#eceff4", // nord6
      card: "#ffffff", // derived: Snow Storm has no step above nord6
      muted: "#e5e9f0", // nord5
      accent: "#d8dee9", // nord4
      border: "#d8dee9", // nord4
      fg: "#2e3440", // nord0
      fgMuted: "#4c566a", // nord3
      // nord10 darkened: Frost has no darker step, and nord10 itself is
      // only 4.0:1 against white, which a button label has to clear.
      primary: "#57779f", // derived from nord10
      primaryFg: "#ffffff",
      destructive: "#bf616a", // nord11
      sidebar: "#e5e9f0",
      charts: ["#5e81ac", "#88c0d0", "#a3be8c", "#ebcb8b", "#b48ead"],
    },
    dark: {
      bg: "#2e3440", // nord0
      card: "#3b4252", // nord1
      muted: "#3b4252", // nord1
      accent: "#434c5e", // nord2
      border: "#434c5e", // nord2
      fg: "#eceff4", // nord6
      fgMuted: "#d8dee9", // nord4 — nord3 is the comment tone and fails AA here
      primary: "#88c0d0", // nord8
      primaryFg: "#2e3440",
      destructive: "#bf616a", // nord11
      sidebar: "#2e3440",
      charts: ["#88c0d0", "#a3be8c", "#ebcb8b", "#b48ead", "#d08770"],
    },
    design: {
      "font-sans": "inter",
      "font-heading": "inter",
      "font-mono": "jetbrains-mono",
      radius: "soft",
      depth: "subtle",
      tracking: "normal",
      blur: "light",
      width: "default",
    },
  },
  {
    id: "dracula",
    label: "Dracula",
    note: "The dark one everybody knows, with its official light twin, Alucard.",
    source: "dracula/dracula-theme README.md (Dracula + Alucard specs)",
    // Both modes are official. Alucard names only background/selection/
    // foreground/comment plus the accents, so the two mid surfaces are derived
    // from its background.
    light: {
      bg: "#fffbeb",
      card: "#ffffff", // derived
      muted: "#f6f1de", // derived
      accent: "#ece7d2", // derived
      border: "#ddd8c4", // derived
      fg: "#1f1f1f",
      fgMuted: "#6c664b", // Alucard's comment tone; clears AA on its surfaces
      primary: "#644ac9",
      primaryFg: "#fffbeb",
      destructive: "#cb3a2a",
      sidebar: "#f6f1de",
      charts: ["#644ac9", "#036a96", "#14710a", "#a34d14", "#a3144d"],
    },
    dark: {
      bg: "#282a36",
      card: "#343746", // derived: between background and selection
      muted: "#343746",
      accent: "#44475a", // selection
      border: "#44475a",
      fg: "#f8f8f2",
      // Dracula's comment #6272a4 is 3.0:1 on the surface above and is meant to
      // recede behind code. Lifted along its own hue to carry secondary text.
      fgMuted: "#a8b2d9",
      primary: "#bd93f9",
      primaryFg: "#282a36",
      destructive: "#ff5555",
      sidebar: "#21222c", // derived
      charts: ["#bd93f9", "#8be9fd", "#50fa7b", "#ffb86c", "#ff79c6"],
    },
    design: {
      "font-sans": "figtree",
      "font-heading": "figtree",
      "font-mono": "jetbrains-mono",
      radius: "round",
      depth: "soft",
      tracking: "tight",
      blur: "medium",
      width: "default",
    },
  },
  {
    id: "solarized",
    label: "Solarized",
    note: "Ethan Schoonover's precision pair — one accent set, two bases.",
    source: "altercation/vim-colors-solarized colors/solarized.vim",
    light: {
      bg: "#fdf6e3", // base3
      card: "#fffcf2", // derived
      muted: "#eee8d5", // base2
      accent: "#e4dcc4", // derived
      border: "#ddd6c1", // derived
      fg: "#073642", // base02
      fgMuted: "#546970", // derived: base01 darkened (4.4:1 on base2)
      primary: "#217ab9", // derived: blue darkened to clear AA against white
      primaryFg: "#ffffff",
      destructive: "#dc322f", // red
      sidebar: "#eee8d5",
      charts: ["#268bd2", "#2aa198", "#859900", "#b58900", "#d33682"],
    },
    dark: {
      bg: "#002b36", // base03
      card: "#073642", // base02
      muted: "#073642",
      accent: "#0f4a5a", // derived
      border: "#0f4a5a",
      fg: "#eee8d5", // base2 — base1 is the emphasised tone and reads dim here
      fgMuted: "#93a1a1", // base1
      primary: "#3a95d6", // derived: blue lifted to clear AA against base03
      primaryFg: "#002b36",
      destructive: "#dc322f",
      sidebar: "#002b36",
      charts: ["#268bd2", "#2aa198", "#859900", "#b58900", "#d33682"],
    },
    design: {
      "font-sans": "inter",
      "font-heading": "inter",
      "font-mono": "jetbrains-mono",
      radius: "sharp",
      depth: "subtle",
      tracking: "normal",
      blur: "none",
      width: "wide",
    },
  },
  {
    id: "gruvbox",
    label: "Gruvbox",
    note: "Retro groove: warm, low-contrast, heavy on the browns.",
    source: "morhetz/gruvbox colors/gruvbox.vim (s:gb.*)",
    // Every value here is one of Gruvbox's own named steps — it is the one
    // scheme in this list that publishes a full neutral ramp for both modes.
    light: {
      bg: "#fbf1c7", // light0
      card: "#f9f5d7", // light0_hard
      muted: "#ebdbb2", // light1
      accent: "#d5c4a1", // light2
      border: "#d5c4a1", // light2
      fg: "#3c3836", // dark1
      fgMuted: "#665c54", // dark3
      // faded_yellow is Gruvbox's signature but only 3.8:1 against white;
      // faded_orange is the next documented step and clears AA at 6.1:1.
      primary: "#af3a03", // faded_orange
      primaryFg: "#ffffff",
      destructive: "#9d0006", // faded_red
      sidebar: "#f2e5bc", // light0_soft
      charts: ["#b57614", "#79740e", "#076678", "#8f3f71", "#af3a03"],
    },
    dark: {
      bg: "#282828", // dark0
      card: "#32302f", // dark0_soft
      muted: "#3c3836", // dark1
      accent: "#504945", // dark2
      border: "#504945", // dark2
      fg: "#ebdbb2", // light1
      fgMuted: "#bdae93", // light3 — light4/gray fall under AA on dark2
      primary: "#fabd2f", // bright_yellow
      primaryFg: "#282828",
      destructive: "#fb4934", // bright_red
      sidebar: "#1d2021", // dark0_hard
      charts: ["#fabd2f", "#b8bb26", "#83a598", "#d3869b", "#fe8019"],
    },
    design: {
      "font-sans": "figtree",
      "font-heading": "figtree",
      "font-mono": "geist-mono",
      radius: "soft",
      depth: "flat",
      tracking: "normal",
      blur: "none",
      width: "wide",
    },
  },
  {
    id: "catppuccin",
    label: "Catppuccin",
    note: "Pastel, low-saturation. Latte by day, Mocha by night.",
    source: "catppuccin/palette palette.json v1.8.0",
    light: {
      bg: "#eff1f5", // base
      card: "#ffffff", // derived: Latte has no step above base
      muted: "#e6e9ef", // mantle
      accent: "#ccd0da", // surface0
      border: "#ccd0da", // surface0
      fg: "#4c4f69", // text
      fgMuted: "#5c5f77", // subtext1 — subtext0 is 4.1:1 on mantle
      primary: "#8839ef", // mauve
      primaryFg: "#ffffff",
      destructive: "#d20f39", // red
      sidebar: "#e6e9ef", // mantle
      charts: ["#8839ef", "#1e66f5", "#40a02b", "#fe640b", "#d20f39"],
    },
    dark: {
      bg: "#1e1e2e", // base
      card: "#292a3d", // derived: between base and surface0
      muted: "#313244", // surface0
      accent: "#45475a", // surface1
      border: "#45475a", // surface1
      fg: "#cdd6f4", // text
      fgMuted: "#a6adc8", // subtext0
      primary: "#cba6f7", // mauve
      primaryFg: "#1e1e2e",
      destructive: "#f38ba8", // red
      sidebar: "#181825", // mantle
      charts: ["#cba6f7", "#89b4fa", "#a6e3a1", "#fab387", "#f38ba8"],
    },
    design: {
      "font-sans": "geist",
      "font-heading": "geist",
      "font-mono": "geist-mono",
      radius: "pill",
      depth: "soft",
      tracking: "tight",
      blur: "heavy",
      width: "default",
    },
  },
  {
    id: "rose-pine",
    label: "Rosé Pine",
    note: "All natural pine, faux fur and a bit of soho vibes.",
    source: "rose-pine/palette palette.json (main + dawn)",
    light: {
      bg: "#faf4ed", // dawn base
      card: "#fffaf3", // dawn surface
      muted: "#f2e9e1", // dawn overlay
      accent: "#e8dbd0", // derived
      border: "#dfd5cb", // derived
      fg: "#464261", // dawn text
      fgMuted: "#69657f", // derived: dawn subtle darkened (3.7:1 on overlay)
      // Dawn iris is only 3.5:1 against white. Pine is equally canonical,
      // documented, and clears AA — iris stays as the first chart series.
      primary: "#286983", // dawn pine
      primaryFg: "#ffffff",
      destructive: "#b4637a", // dawn love
      sidebar: "#fffaf3",
      charts: ["#907aa9", "#286983", "#56949f", "#ea9d34", "#b4637a"],
    },
    dark: {
      bg: "#191724", // base
      card: "#1f1d2e", // surface
      muted: "#26233a", // overlay
      accent: "#302c48", // derived
      border: "#26233a", // overlay
      fg: "#e0def4", // text
      fgMuted: "#908caa", // subtle
      primary: "#c4a7e7", // iris
      primaryFg: "#191724",
      destructive: "#eb6f92", // love
      sidebar: "#1f1d2e",
      charts: ["#c4a7e7", "#9ccfd8", "#31748f", "#f6c177", "#eb6f92"],
    },
    design: {
      "font-sans": "figtree",
      "font-heading": "source-serif",
      "font-mono": "jetbrains-mono",
      radius: "round",
      depth: "soft",
      tracking: "tight",
      blur: "medium",
      width: "narrow",
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

export const schemeById = (id: string): ColorScheme | undefined =>
  COLOR_SCHEMES.find((scheme) => scheme.id === id)
