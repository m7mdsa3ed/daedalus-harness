/* The themes that ship with the app, in gallery order. Default is shadcn's stock
   palette (styles/themes.css); the rest are the product-inspired schemes in
   lib/color-schemes.ts, whose CSS custom-themes.ts writes at load. Everything
   else is user-made. */

import { COLOR_SCHEMES } from "./color-schemes"

export interface BuiltinTheme {
  value: string
  label: string
  /** One line for the gallery: what this theme *is*, past its hue. */
  note: string
}

export const BUILTIN_THEMES: readonly BuiltinTheme[] = [
  { value: "default", label: "Default", note: "shadcn's stock palette, soft corners, frosted surfaces." },
  ...COLOR_SCHEMES.map(({ id, label, note }) => ({ value: id, label, note })),
]
