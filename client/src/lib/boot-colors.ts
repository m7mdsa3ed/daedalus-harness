/* ── The boot colours ──
   The app's background for the moment before the app exists: the
   `<meta name="theme-color">` a platform reads to tint the address bar, the
   boot splash inlined in index.html, the manifest's `theme_color` /
   `background_color`, and `applyThemeColor`'s own fallback.

   They are the Default theme's `--background` — shadcn's stock `oklch(1 0 0)`
   and `oklch(0.145 0 0)` from `:root` / `.dark` in index.css — in hex, because
   platforms read them rather than CSS. `vite.config.ts` imports this for the
   manifest and `lib/theme.tsx` for its fallback; index.html (static, cannot
   import) repeats the two values as literals and must be kept equal by hand.
   Only the Default palette lives here, and only as a floor: ThemeProvider
   replaces it with the rendered body background once it mounts (see
   applyThemeColor in lib/theme.tsx). */
export const BOOT_COLORS = {
  light: "#ffffff",
  dark: "#0a0a0a",
} as const
