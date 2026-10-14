/* The themes that ship in styles/themes.css, in gallery order. Default is the
   only one, and it is shadcn's stock palette: everything else is user-made. */

export interface BuiltinTheme {
  value: string
  label: string
  /** One line for the gallery: what this theme *is*, past its hue. */
  note: string
}

export const BUILTIN_THEMES: readonly BuiltinTheme[] = [
  { value: "default", label: "Default", note: "shadcn's stock palette, soft corners, frosted surfaces." },
]
