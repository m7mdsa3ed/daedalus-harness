/**
 * A barrel, nothing more: the theme gallery and studio live in
 * `theme-builder/` now — the grid of cards and the one way a theme is created
 * in `gallery.tsx`, the studio and every write to a theme in `editor.tsx`, its
 * three tabs in `presets-tab.tsx`, `design-tab.tsx` (with the typeface control
 * in `font-picker.tsx`) and `token-field.tsx`, and everything that only *draws*
 * a theme in `preview.tsx`. This file stays so `@/components/theme-builder`
 * keeps resolving for the two callers that import from it — `settings/appearance`
 * statically, `routes.tsx` as a lazy page.
 */
export { ThemeGallery } from "./theme-builder/gallery"
export { ThemePreview } from "./theme-builder/preview"
export { ThemeEditorPage } from "./theme-builder/editor"
