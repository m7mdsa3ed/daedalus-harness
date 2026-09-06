/* ── Typefaces a theme can name ──
   A theme stores a font *id*, never a CSS stack. A bundled family's real face
   name (`'Geist Variable'`, which is what @fontsource-variable registers — not
   `'Geist'`) is spelled once, as a `--font-family-<id>` custom property in
   styles/themes.css, and everything else refers to it by id — so a built-in
   theme and a user-made copy of it resolve through the same declaration and
   cannot drift apart, and a package that renames its face is one line to fix.

   Two kinds of id:
   - a catalog id (`figtree`, `jetbrains-mono`, `system-sans`) — bundled, so the
     @import in index.css has already loaded it and nothing here has to fetch;
   - `google:<Family Name>` — fetched at runtime by `syncWebFonts`.

   The split matters for more than bundle size. The bundled ones are the only
   ones a *built-in* theme may name, because a built-in has to paint correctly
   on a first load with no network — an Electron shell offline, a PWA cold —
   and a Google family that has not arrived yet is a fallback stack, which is a
   different design from the one that shipped. A user-made theme may name
   anything, because it was made on this device by someone watching it load. */

export type FontRole = "sans" | "heading" | "mono"
export type FontCategory = "sans" | "serif" | "mono"

export interface FontDef {
  id: string
  label: string
  category: FontCategory
  /** A note under the label in the picker — what the face is *for*. */
  hint?: string
}

/** The generic that closes every stack, so a face that fails to load still
    lands on something of the right shape rather than on Times. */
const FALLBACK: Record<FontCategory, string> = {
  sans: "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif",
  serif: "ui-serif, Georgia, Cambria, serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
}

/* Bundled families. Every entry here needs two things elsewhere: an @import in
   index.css that loads the faces, and a `--font-family-<id>` declaration in
   styles/themes.css that spells the stack. This list carries neither — it is
   what the picker *offers*, and the stack is the stylesheet's, so a built-in
   theme naming `inter` and a user-made copy of it resolve through the exact
   same declaration and cannot drift apart. `system-*` are the exception: they
   name no file, and their stack is the category fallback below. */
export const FONT_CATALOG: readonly FontDef[] = [
  {
    id: "figtree",
    label: "Figtree",
    category: "sans",
    hint: "Geometric, friendly — the app's default.",
  },
  {
    id: "inter",
    label: "Inter",
    category: "sans",
    hint: "Neutral UI workhorse, tall x-height.",
  },
  {
    id: "geist",
    label: "Geist",
    category: "sans",
    hint: "Tight, technical, low contrast.",
  },
  {
    id: "roboto",
    label: "Roboto",
    category: "sans",
    hint: "Compact, sets densely.",
  },
  {
    id: "source-serif",
    label: "Source Serif",
    category: "serif",
    hint: "A serif that holds up at UI sizes.",
  },
  {
    id: "newsreader",
    label: "Newsreader",
    category: "serif",
    hint: "Editorial, high contrast — headings.",
  },
  {
    id: "jetbrains-mono",
    label: "JetBrains Mono",
    category: "mono",
    hint: "Tall, roomy — built for code.",
  },
  {
    id: "geist-mono",
    label: "Geist Mono",
    category: "mono",
    hint: "Narrow, even colour.",
  },
  { id: "system-sans", label: "System sans", category: "sans", hint: "The OS UI face." },
  { id: "system-serif", label: "System serif", category: "serif", hint: "The OS serif." },
  { id: "system-mono", label: "System mono", category: "mono", hint: "The OS mono face." },
]

const BY_ID = new Map(FONT_CATALOG.map((font) => [font.id, font]))

const GOOGLE_PREFIX = "google:"

export const isGoogleFont = (id: string): boolean => id.startsWith(GOOGLE_PREFIX)
export const googleFontId = (family: string): string => GOOGLE_PREFIX + family.trim()
export const googleFontFamily = (id: string): string => id.slice(GOOGLE_PREFIX.length)

/** The category a role falls back to when the id names nothing known — which
    is also the generic a Google family gets, since we cannot ask Google what
    shape a face is without a second request nobody is waiting for. */
const ROLE_CATEGORY: Record<FontRole, FontCategory> = {
  sans: "sans",
  heading: "sans",
  mono: "mono",
}

/** Font id → a full CSS `font-family` value. Unknown ids resolve to the role's
    plain fallback rather than to nothing: a theme naming a family this build
    dropped should read as the system face, not as an empty declaration that
    lets the token inherit something arbitrary. */
export function fontStack(id: string | undefined, role: FontRole): string {
  if (!id) return FALLBACK[ROLE_CATEGORY[role]]
  if (isGoogleFont(id)) {
    const family = googleFontFamily(id)
    return family ? `'${family.replace(/'/g, "")}', ${FALLBACK[ROLE_CATEGORY[role]]}` : FALLBACK[ROLE_CATEGORY[role]]
  }
  const font = BY_ID.get(id)
  if (!font) return FALLBACK[ROLE_CATEGORY[role]]
  if (font.id.startsWith("system-")) return FALLBACK[font.category]
  // The stack itself is styles/themes.css's — see the catalog comment. The
  // second argument is the fallback the browser uses if that declaration is
  // missing, which is the one failure this indirection introduces and the one
  // it has to survive.
  return `var(--font-family-${font.id}, ${FALLBACK[font.category]})`
}

/** What to call this id on screen, for a picker and for a theme's summary. */
export function fontLabel(id: string | undefined): string {
  if (!id) return "Default"
  if (isGoogleFont(id)) return googleFontFamily(id) || "Default"
  return BY_ID.get(id)?.label ?? `Unknown (${id})`
}


// ---- runtime loading for Google families ----

const LINK_ATTR = "data-daedalus-webfont"

/* Google's css2 endpoint 400s a family that does not publish every weight
   asked for, and a 400 is a stylesheet that never arrives — so the weighted
   request is only the *first* attempt. The link's own `error` event is the
   signal, and the retry drops the axis entirely, which every family serves. */
const weightedHref = (family: string) =>
  `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}:wght@400;500;600;700&display=swap`

const plainHref = (family: string) =>
  `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}&display=swap`

/** Add/remove `<link>` elements so exactly `families` are loaded. Idempotent —
    it is called on every theme write, and a family already linked is left
    alone rather than torn down and re-fetched (which would flash every surface
    it paints). */
export function syncWebFonts(families: readonly string[]): void {
  if (typeof document === "undefined") return
  const wanted = new Set(families.filter(Boolean))
  const existing = new Map<string, HTMLLinkElement>()
  for (const node of document.querySelectorAll<HTMLLinkElement>(`link[${LINK_ATTR}]`)) {
    existing.set(node.getAttribute(LINK_ATTR) ?? "", node)
  }

  for (const [family, node] of existing) {
    if (!wanted.has(family)) node.remove()
  }
  for (const family of wanted) {
    if (existing.has(family)) continue
    const link = document.createElement("link")
    link.rel = "stylesheet"
    link.setAttribute(LINK_ATTR, family)
    link.href = weightedHref(family)
    link.addEventListener(
      "error",
      () => {
        // Only ever retried once: `plainHref` asks for the one weight every
        // family on Google Fonts publishes, so a second failure is the family
        // not existing, and the stack falls through to the generic.
        if (link.href !== plainHref(family)) link.href = plainHref(family)
      },
      { once: true }
    )
    document.head.appendChild(link)
  }
}
