/* ── The boot colours ──
   The app's background for the moment before the app exists.

   Four things have to name it before any stylesheet does: the
   `<meta name="theme-color">` a platform reads to tint the address bar, the
   boot splash inlined in index.html, the manifest's `theme_color` /
   `background_color`, and `applyThemeColor`'s own fallback for the paint where
   `--background` computes to nothing. All four used to guess independently, and
   all four guessed `#0a0a0a` — which is `.dark` in index.css, a state that only
   exists before React mounts. ThemeProvider always sets `data-color-theme`, so
   what the app *actually* paints is the Default palette's `--background`: a
   warm near-black. The gap showed as a hairline shift between the splash and
   the app behind it.

   So this is the one definition. `vite.config.ts` imports it for the manifest
   and substitutes it into index.html (which is static and cannot import
   anything); `lib/theme.tsx` imports it for its fallback.

   The values are `oklch(1 0 0)` and `oklch(0.147 0.004 49.25)` from
   `[data-color-theme="default"]` in `src/styles/themes.css`, in hex because
   these are read by platforms rather than by CSS. Nothing can compute them at
   build time — the stylesheet is Tailwind's to produce — so changing that
   palette's `--background` means changing this too.

   Only the Default palette lives here, and only as a floor: it is what shows on
   a first-ever load and behind a blocked script. Every load after one paints
   from the real palette, which ThemeProvider caches per `<palette>:<mode>`
   (see THEME_COLOR_KEY in lib/theme.tsx). */
export const BOOT_COLORS = {
  light: "#ffffff",
  dark: "#0c0a09",
} as const
