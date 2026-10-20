/* ── The typeface control ──
   One of the three Design-tab font slots: the bundled catalog grouped by
   category, plus the escape hatch to Google Fonts and the two sentinels the
   select needs to say "default" and "custom" without either being storable as a
   font id. */
import * as React from "react"
import { Type } from "lucide-react"

import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  FONT_CATALOG,
  fontLabel,
  fontStack,
  googleFontFamily,
  googleFontId,
  isGoogleFont,
  type FontCategory,
  type FontRole,
} from "@/lib/fonts"

const CATEGORY_LABEL: Record<FontCategory, string> = {
  sans: "Sans",
  serif: "Serif",
  mono: "Mono",
}
const CATEGORY_ORDER: readonly FontCategory[] = ["sans", "serif", "mono"]
// The catalog is a module constant and so is this grouping of it — three
// pickers re-filtering the same frozen list on every keystroke bought nothing.
const CATEGORY_FONTS: Record<FontCategory, typeof FONT_CATALOG> = {
  sans: FONT_CATALOG.filter((font) => font.category === "sans"),
  serif: FONT_CATALOG.filter((font) => font.category === "serif"),
  mono: FONT_CATALOG.filter((font) => font.category === "mono"),
}

/* `""` is the stored form of "inherit the app default" — `baseDeclarations`
   skips falsy values, so it emits no declaration at all. The select needs a
   non-empty string to represent it, since Base UI reads `""` as "no value". */
const DEFAULT_VALUE = ""
const DEFAULT_SENTINEL = "__default__"
const CUSTOM_SENTINEL = "__google__"

/** Bundled families in a grouped select, plus a free-text escape to Google
    Fonts. The two are one control because they answer one question, and the
    text field only appears once "Google Fonts" is chosen — an always-visible
    second input reads as a second, competing choice.

    Every row is drawn in the face it names, which is the only honest preview
    of a typeface and costs nothing for the bundled ones. */
export function FontPicker({
  value,
  role,
  onChange,
}: {
  value: string | undefined
  role: FontRole
  onChange: (value: string) => void
}) {
  const custom = !!value && isGoogleFont(value)
  const [draft, setDraft] = React.useState(custom ? googleFontFamily(value) : "")
  // `custom` is a mode, not a stored value: it is entered by picking the
  // sentinel and left by picking any real family, so it has to survive the
  // moment the field is empty and the theme still says "google:".
  const [showCustom, setShowCustom] = React.useState(custom)
  React.useEffect(() => {
    if (custom) {
      setDraft(googleFontFamily(value))
      setShowCustom(true)
      return
    }
    // A real family arriving from outside — Revert, a style preset, another tab
    // — closes the custom field. An *empty* value does not: that is what a
    // half-typed family name stores, and closing the field under the caret is
    // worse than showing it for a theme that currently names nothing.
    if (value) setShowCustom(false)
  }, [custom, value])

  const select = (next: string | null) => {
    if (next === null) return
    if (next === CUSTOM_SENTINEL) {
      setShowCustom(true)
      if (draft.trim()) onChange(googleFontId(draft))
      return
    }
    setShowCustom(false)
    // Both sentinels are the select's own vocabulary and neither is a font id
    // — writing one through would store `__default__` as the theme's family.
    onChange(next === DEFAULT_SENTINEL ? DEFAULT_VALUE : next)
  }

  return (
    <div className="flex w-40 shrink-0 flex-col gap-1.5">
      <Select
        value={showCustom ? CUSTOM_SENTINEL : (value ?? DEFAULT_SENTINEL)}
        onValueChange={select}
      >
        <SelectTrigger size="sm" className="w-full">
          <SelectValue>
            <span style={{ fontFamily: fontStack(value, role) }} className="truncate">
              {fontLabel(value)}
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT_SENTINEL}>Default</SelectItem>
          {CATEGORY_ORDER.map((category) => (
            <SelectGroup key={category}>
              <SelectLabel>{CATEGORY_LABEL[category]}</SelectLabel>
              {CATEGORY_FONTS[category].map((font) => (
                <SelectItem key={font.id} value={font.id}>
                  <span style={{ fontFamily: fontStack(font.id, role) }}>{font.label}</span>
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
          <SelectGroup>
            <SelectLabel>Other</SelectLabel>
            <SelectItem value={CUSTOM_SENTINEL}>
              <Type className="size-3.5" />
              Google Fonts…
            </SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
      {showCustom && (
        <Input
          value={draft}
          spellCheck={false}
          placeholder="Family name"
          aria-label="Google Fonts family name"
          onChange={(event) => {
            setDraft(event.target.value)
            // Written through on every keystroke like every other control here;
            // an empty field falls back to the app default rather than to
            // `google:` with nothing after it, which resolves to nothing.
            onChange(event.target.value.trim() ? googleFontId(event.target.value) : DEFAULT_VALUE)
          }}
          className="h-8"
        />
      )}
    </div>
  )
}
