/* ── The OpenUI kit ──
   The shared render helpers every component in this library draws with — the
   type scale, the one framed surface and the chart colours. They live apart from
   `library.tsx` so a component file can import them without importing the
   library (which imports it back). One `SurfaceContext` exists, defined here
   once, so every `Box` reads the same instance.

   The scale is a dense, editorial one and it is deliberately short: a heading, a
   sentence, a qualifying line, a column name and a figure. Nothing in the
   library states a size of its own — a component that wants a new one is a
   component that has stopped matching the rest. */
import { createContext, useContext, useMemo, type CSSProperties, type ReactNode } from "react"
import { Badge } from "@/components/ui/badge"
import { CodeBlockCopyButton } from "@/components/ui/code-block"
import { highlightTokens } from "@/lib/highlight"
import { cn } from "@/lib/utils"

/** A thing's name. Tight leading and a touch of negative tracking, so a two-line
    title reads as one block rather than as two paragraphs. */
export const TITLE = "font-heading break-words text-sm leading-snug font-semibold tracking-[-0.01em] text-foreground"
/** Its text. */
export const BODY = "break-words text-sm leading-[1.6] text-foreground"
/** What qualifies it — a fact line, a caption, a hint. */
export const META = "break-words text-xs leading-[1.5] text-muted-foreground"
/** A column's or a metric's name: the smallest step, and the only one that is
    not meant to be read as a sentence. */
export const LABEL = "break-words text-xs leading-snug font-medium text-muted-foreground"
/** A figure. One size for every number the library sets large — a `Stat`, a
    dial's reading — and the size a settings stat tile sets its own (`text-2xl`),
    so two metrics side by side are the same metric and a drawn one matches the
    product's. It does not step up with the panel: a figure already reads. */
export const FIG = "font-heading text-2xl leading-[1.15] font-semibold tracking-[-0.02em] tabular-nums text-foreground"

/** The body inset of a frame — the settings kit's `CARD` inset, so a drawn card
    and a settings card pad the same and step down together on a narrow panel. */
export const PAD = "p-3 @panel-sm:p-4"
/** `PAD` for a body that holds wells or a corner tile: the same inset, stated
    as the frame's (`frame-p-*`), so what is inside derives a concentric corner
    (`rounded-inner`) from the card's. */
export const WELL_PAD = "frame-p-3 @panel-sm:frame-p-4"
/** One row of a framed list — the same inset horizontally, less above and below,
    because a list supplies its own rhythm between its rows. */
export const PAD_ROW = "px-3 py-2 @panel-sm:px-4 @panel-sm:py-2.5"
/** A row of a list that is not framed: the page's own margin, and the first and
    last rows flush so the list sits at the same edge as the prose beside it. */
export const LIST_ROW = "min-w-0 py-3 first:pt-0 last:pb-0"
/** Between siblings, everywhere: a stack, a card's body, a tab's panel. */
export const FLOW = "openui-flow flex w-full min-w-0 flex-col gap-3 @panel-sm:gap-3.5"

/** The well a frame inside a frame becomes — the settings kit's `INSET`: a
    recessed ground under a lighter hairline, never a second identical frame. */
export const INSET = "rounded-inner border border-rule bg-muted/50"

export type Surface = "page" | "frame"
export const SurfaceContext = createContext<Surface>("page")

/** The one framed thing. What it looks like is where it is, never the caller's
    choice — which is the whole of "styled the same". On the page it is the
    product's card outline (`PAGE_FRAME`); inside a frame it is a recessed well
    (`INSET`), so a Table in a Card is never a second identical ring. Its
    children are inside a frame, so anything framed among them draws as the
    inner one. */
export function Box({ className, children, style }: { className?: string; children: ReactNode; style?: CSSProperties }) {
  const surface = useContext(SurfaceContext)
  return (
    <SurfaceContext.Provider value="frame">
      <div className={cn("w-full min-w-0 overflow-hidden", surface === "page" ? PAGE_FRAME : INSET, className)} style={style}>
        {children}
      </div>
    </SurfaceContext.Provider>
  )
}

/** The page ground of a frame: the app's own card — `rounded-2xl`, `bg-card`
    and the single ring a card in this product wears (`settings/primitives`
    `CARD`, a task's comment, a suggestion group) — so a drawn block reads as one
    more card in the answer rather than a widget pasted onto it. The fill is
    what lifts it on dark, where `--card` is a real step off `--background`; on
    light the two are the same white and the outline is what draws it. It states its
    corner (`frame-2xl`) for `rounded-inner`. The outline is a `border`, not
    the card's `ring-1`: a ring is a shadow painted outside the box, and the
    transcript's overflow-clipped columns cut it off at both sides. */
const PAGE_FRAME = "frame-2xl [--frame-p:0px] bg-card text-card-foreground border border-foreground/10"

/** A frame's top line: a name and what qualifies it, over a hairline — no
    filled band, so a titled frame is a heading and its content. */
export function BoxHeader({ title, meta }: { title: ReactNode; meta?: ReactNode }) {
  return (
    <header className={cn("min-w-0 space-y-0.5 border-b border-rule", PAD_ROW)}>
      <div className={cn(TITLE, "[&_a]:font-semibold")}>{title}</div>
      {meta && <div className={cn(META, "text-pretty")}>{meta}</div>}
    </header>
  )
}

/** A rule that separates two runs of content without framing them — the line
    under a heading, or between two groups of a list that is not a frame. */
export function Rule({ className }: { className?: string }) {
  return <hr className={cn("w-full min-w-0 border-0 border-t border-rule", className)} />
}

/** The five tones every component that has a state spells the same way. */
export const TONES = ["neutral", "info", "success", "warn", "error"] as const

/** A frame in a tone: the tone mixed into the card's own ground (not laid
    over it, which would let the page show through) and a hairline of the same
    tone. One map, so a tinted `Card` and a `Callout` are the same tile. Applied
    to a `Box` through `cn`, which lets it replace the frame's ground and edge. */
export const TONE_TINT = {
  neutral: "",
  info: "bg-[color-mix(in_oklab,var(--primary)_5%,var(--card))] border-primary/25",
  success: "bg-[color-mix(in_oklab,var(--success)_6%,var(--card))] border-success/25",
  warn: "bg-[color-mix(in_oklab,var(--warning)_7%,var(--card))] border-warning/30",
  error: "bg-[color-mix(in_oklab,var(--destructive)_5%,var(--card))] border-destructive/25",
} as const

/** What a chip's tone dot is filled with: the app's status tokens. */
export const TONE_DOT = {
  neutral: "bg-muted-foreground",
  info: "bg-primary",
  success: "bg-success",
  warn: "bg-warning",
  error: "bg-destructive",
} as const

/** The same five tones as an area rather than a dot — a share bar's segments.
    The neutral one is part-filled: a section of a bar in full `--foreground`
    reads as a selected state rather than as "none of the above". */
export const TONE_BAR = {
  neutral: "bg-muted-foreground/30",
  info: "bg-primary/80",
  success: "bg-success/80",
  warn: "bg-warning/80",
  error: "bg-destructive/80",
} as const

/** A chip's ground: the app's own status chip — a faint tone wash with the tone
    as the text colour (`bg-success/10 text-success`, which is how a task, a
    workflow step and a command palette row draw a state), so a status means the
    same thing in a drawn answer as in the rest of the product. */
export const TONE_CHIP = {
  neutral: "bg-muted text-muted-foreground",
  info: "bg-primary/10 text-primary",
  success: "bg-success/10 text-success",
  warn: "bg-warning/10 text-warning",
  error: "bg-destructive/10 text-destructive",
} as const

/** Colours are the app's `--chart-*` tokens. */
export const chartColor = (index: number) => `var(--chart-${(index % 5) + 1})`

/** The one state chip: the tone as a wash and as the words, never a border — at
    this density an outline per status drew a column of six rings, and the app's
    statuses are tinted, not ringed. `Badges` and a finding's severity wear the
    same chip, so a status reads the same wherever it is drawn. */
export function ToneChip({ text, tone }: { text: string; tone?: keyof typeof TONE_DOT }) {
  return (
    <Badge
      variant="secondary"
      className={cn(
        "h-auto max-w-full gap-1 rounded-md px-1.5 py-0.5 text-xs leading-[1.4] font-medium whitespace-normal",
        TONE_CHIP[tone ?? "neutral"]
      )}
    >
      <span className="min-w-0 break-words">{text}</span>
    </Badge>
  )
}

/** The five tones as a glyph's colour — a tag's words, a verdict's icon, a
    gauge's arc. Every component that colours a tone spells it here. */
export const TONE_TEXT = {
  neutral: "text-muted-foreground",
  info: "text-primary",
  success: "text-success",
  warn: "text-warning",
  error: "text-destructive",
} as const

/* ── A cell read as a state ──
   The same bargain `Matrix` makes with its verdicts, and for the same reason: a
   typed cell per column (`{text, tone}`) is what a model gets wrong, and the
   library's schemas stay one string deep. So a cell OPENS with its state and the
   rest is what qualifies it — `yes, per request`, `fail, 3 flaky`, `warn 2 left`
   — and the leading word is drawn as a state, with the qualification after it.
   `yes/no/partial/n/a` mean the same thing in a `Table` as in a `Matrix`; a
   `Matrix` only has a glyph for those four and draws the rest as text, while a
   `Table` chipped every word in this list.

   In a table it is opt-in per table (`tones: true`), and that is the whole
   design: a table of ordinary prose is the common case, and `Warning:
   deprecated` in a cell would come back as a warn chip — a table reformatted by
   a rule nobody asked for, differently depending on the first word of every
   cell. So the model asks for it, on the tables that carry a state, and every
   other table is drawn exactly as it was.

   The word list is deliberately status words and not log prefixes: `error` and
   `warning` are left out for the reason above, and `pass` is in because a column
   of pass/fail is the shape this exists for. Anything not in the list is drawn
   as text, so a cell can opt out by starting with something else. */
export const CELL_STATES: Record<string, { word: string; tone: keyof typeof TONE_DOT }> = {
  yes: { word: "Yes", tone: "success" },
  no: { word: "No", tone: "error" },
  partial: { word: "Partly", tone: "warn" },
  partly: { word: "Partly", tone: "warn" },
  "n/a": { word: "Not applicable", tone: "neutral" },
  na: { word: "Not applicable", tone: "neutral" },
  pass: { word: "Pass", tone: "success" },
  passed: { word: "Pass", tone: "success" },
  ok: { word: "OK", tone: "success" },
  done: { word: "Done", tone: "success" },
  success: { word: "Success", tone: "success" },
  fail: { word: "Fail", tone: "error" },
  failed: { word: "Fail", tone: "error" },
  blocked: { word: "Blocked", tone: "error" },
  warn: { word: "Warn", tone: "warn" },
  running: { word: "Running", tone: "info" },
  active: { word: "Active", tone: "info" },
  skip: { word: "Skip", tone: "neutral" },
  skipped: { word: "Skip", tone: "neutral" },
  pending: { word: "Pending", tone: "neutral" },
  todo: { word: "To do", tone: "neutral" },
}

/* `pass, 3 flaky` / `no` / `no.` — the word, then any punctuation, then the
   qualification. `no` is matched before `none` by the word boundary. */
const CELL_LEAD = new RegExp(`^\\s*(${Object.keys(CELL_STATES).map((k) => k.replace(/[/-]/g, "\\$&")).join("|")})\\b[\\s:;,.-]*`, "i")

/** A cell read as its state and what qualifies it; `state` is absent when the
    cell opens with no verdict, which is the case for nearly every cell. */
export function readStateCell(raw: string | undefined): { state?: string; note: string } {
  const text = (raw ?? "").trim()
  const lead = CELL_LEAD.exec(text)
  if (!lead) return { note: text }
  return { state: lead[1].toLowerCase(), note: text.slice(lead[0].length).trim() }
}

/* ── A run of code, one way ──
   `Code` and a `List` row's `code` are the places a generated view draws
   characters meant to be copied — a snippet, a shell session, a diff, a step's
   command. This is the one surface they share, so a snippet reads the same
   wherever the model puts it:

   — the ground is the caller's `Box`, never this: a top-level snippet IS the
     frame (a card whose body is the code), and the same well inside a list
     row is a card's `INSET`. Stating one here made every snippet two borders
     deep;
   — the palette is `.hljs-*` / `--code-*`, the tokens the transcript's fenced
     code and Monaco already read, so a drawn snippet and the same file in a
     tool call are one language;
   — the copy button is `CodeBlockCopyButton`, the app's own — it carries the
     copied state, the live region and the Electron clipboard path
     (`writeClipboard`), none of which a fourth implementation would remember;
   — it appears on hover and while focused, and is always there under a coarse
     pointer, where there is no hover to reveal it.

   `language` is what the model declared; an unregistered one draws plain rather
   than guessing a grammar. */

/** The band over a well: its name (a path, a cwd, the language) over a
    hairline. It reaches the frame's edges because it sits inside `Box`, whose
    own padding a band is allowed to own, exactly as `BoxHeader` does. */
export function CodeBand({ start }: { start?: ReactNode }) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2 border-b border-rule py-1.5", PAD_ROW)}>
      <span className={cn(LABEL, "min-w-0 flex-1 font-mono")}>{start}</span>
    </div>
  )
}

export function CodeWell({
  code,
  language,
  header,
  className,
}: {
  code: string
  language?: string
  /** A band above the code inside the well — `CodeBand`. */
  header?: ReactNode
  className?: string
}) {
  const tokens = useMemo(() => highlightTokens(code, language), [code, language])
  const body = code.replace(/\n+$/, "")
  return (
    <div className={cn("openui-code group/code w-full min-w-0", className)}>
      {header}
      {/* The button is anchored to the code, not to the well: over the whole
          well it landed on top of the band's own text. */}
      <div className="relative min-w-0">
        <pre
          tabIndex={0}
          dir="ltr"
          className="min-w-0 overflow-auto px-3 py-2.5 font-mono text-xs leading-[1.65] break-words whitespace-pre-wrap text-foreground"
        >
          <code>
            {tokens
              ? tokens.map((token, index) => (token.className ? <span key={index} className={token.className}>{token.text}</span> : token.text))
              : body}
          </code>
        </pre>
        <div className="absolute end-1 top-1 z-10 opacity-0 transition-opacity group-focus-within/code:opacity-100 group-hover/code:opacity-100 pointer-coarse:opacity-100">
          <CodeBlockCopyButton value={body} className="bg-background/80 ring-1 ring-rule backdrop-blur-sm" />
        </div>
      </div>
    </div>
  )
}

/* ── A titled frame with a body ──
   Six charting components drew the same three things by hand: the frame, a
   `BoxHeader` that is drawn only when the model gave a title, and a body with
   the frame's inset. The body takes `className` because that is the whole of
   what differed between them (`space-y-2.5`, `overflow-x-auto`, none at all),
   and `pad={false}` is the one that supplies its own. */
export function TitledFrame({
  title,
  meta,
  children,
  className,
  pad = true,
}: {
  title?: string
  meta?: ReactNode
  children: ReactNode
  className?: string
  pad?: boolean
}) {
  return (
    <Box>
      {title && <BoxHeader title={title} meta={meta} />}
      <div className={cn("min-w-0", pad && PAD, className)}>{children}</div>
    </Box>
  )
}

/* ── The record list ──
   Ten components are one shape: a frame whose body is a divided list of
   records, each record a run of named facts. `Agenda`, `Endpoints`, `Glossary`,
   `KeyValue`, `Keys`, `People` and the map's rows each re-declared the frame,
   the divider and the inset by hand, which is where their insets drifted.

   `RecordList` is the frame and the rhythm; `RecordRow` is one record of it. A
   record is always a *list of parts*, because that is the general case — a
   `KeyValue` row is two, an `Agenda` entry is a time and a block, an
   `Endpoints` route is a method and a path — and a component that has a shape
   of its own (a person's avatar) passes it as a part rather than asking the
   list to know about people. */
export function RecordList({
  children,
  className,
  as: Tag = "ul",
}: {
  children: ReactNode
  className?: string
  /** `dl` where the record is a term and its definition (`Glossary`,
      `KeyValue`): the semantics are the point of the pairing, so the frame
      follows the caller rather than forcing every list onto one tag. */
  as?: "ul" | "dl"
}) {
  return (
    <RecordInside.Provider value={Tag}>
      <Tag className={cn("w-full min-w-0 list-none divide-y divide-rule", className)}>{children}</Tag>
    </RecordInside.Provider>
  )
}

/** One record of a `RecordList`. `wrap` is the receipt shape (`KeyValue`,
    `Keys`): the parts sit at the two ends of the line and a part too long
    wraps under the one before it. Without it the parts are a track each —
    `columns` names the tracks as a class, never an inline style, because
    `Agenda`'s time column only becomes a column where the panel has room for
    one and a style would apply at every width. */
export function RecordRow({
  children,
  wrap,
  columns,
  className,
}: {
  children: ReactNode
  wrap?: boolean
  columns?: string
  className?: string
}) {
  const classes = cn(
    "min-w-0",
    PAD_ROW,
    wrap ? "flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5" : "grid gap-x-4 gap-y-0.5",
    columns,
    className
  )
  /* A `<dl>` may only hold `<div>`s around its pairs, never an `<li>`. */
  const insideDefinitionList = useContext(RecordInside)
  return insideDefinitionList ? (
    <div className={classes}>{children}</div>
  ) : (
    <li className={classes}>{children}</li>
  )
}

/** Set by `RecordList` so `RecordRow` knows which element it may be. */
const RecordInside = createContext<"ul" | "dl">("ul")

/* ── Initials ──
   A person drawn without a picture: the first two words' first letters. It was
   written three times — `People`, `AvatarGroup`, `Testimonial` — and only one of
   them guarded the empty name. */
export function initials(name: string | undefined): string {
  return (name ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("")
}

/* ── Numbers, written one way ──
   Six components formatted a figure and three of them built the same
   `Intl.NumberFormat` per render. Two formatters cover the library: the plain
   one a count is read as, and the compact one a chart axis or a heatmap cell
   needs to stay inside its column. */
const PLAIN_NUMBER = new Intl.NumberFormat()
const COMPACT_NUMBER = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 })

/** `1,204` — the figure as a reader says it. */
export const formatNumber = (value: number) => PLAIN_NUMBER.format(value)
/** `1.2K` — the figure where the room is a tick label or a cell. */
export const formatCompact = (value: number) => COMPACT_NUMBER.format(value)

/* ── A single bar against its maximum ──
   The other half of a share bar: one value, one track, no parts. `Bars` ranks
   with it, `Funnel` narrows with it. A value above zero never draws as nothing
   — a sliver still says "some" — which is the rule both callers had written
   out by hand. */
export function Meter({
  value,
  max,
  tone = "info",
  ground = "bg-muted",
  height = "h-1",
  rounded = true,
  color,
  floor = 2,
  className,
}: {
  value: number
  max: number
  tone?: keyof typeof TONE_DOT
  ground?: string
  height?: string
  rounded?: boolean
  /** A CSS colour, for the one caller that is not a tone (`Funnel`'s primary). */
  color?: string
  /** The width a non-zero value never goes below, so a sliver still reads as
      "some". `Funnel` passes 0: its stages are a share of the first, and a
      stage that retained almost nothing should draw as almost nothing. */
  floor?: number
  className?: string
}) {
  const share = max > 0 && value > 0 ? Math.max(floor, Math.min(100, (value / max) * 100)) : 0
  return (
    <div aria-hidden className={cn("w-full min-w-0 overflow-hidden", ground, height, rounded && "rounded-full", className)}>
      {share > 0 && (
        <span
          className={cn(
            "block h-full transition-[width] duration-500 ease-out motion-reduce:transition-none",
            rounded && "rounded-full",
            !color && TONE_BAR[tone]
          )}
          style={{ width: `${share}%`, background: color }}
        />
      )}
    </div>
  )
}

/* ── A cell read as one of the four verdicts ──
   The glyph form of `readStateCell`: a cell that opens with yes, no, partial or
   n/a is drawn as that verdict's glyph with the rest as its note. A `Table` with
   `verdicts` asks for it; before, it was a `Matrix` component of its own and a
   second reader of the same four words. The word is kept as a screen-reader
   text, so the glyph is never the only carrier. */
export const VERDICT_STATE = {
  yes: { word: "Yes", glyph: "check" },
  no: { word: "No", glyph: "x" },
  partial: { word: "Partly", glyph: "minus" },
  na: { word: "Not applicable", glyph: null },
} as const

export type VerdictState = keyof typeof VERDICT_STATE

/** A cell read as one of the four verdicts; anything else is only a note. */
export function readVerdict(raw: string | undefined): { state?: VerdictState; note: string } {
  const { state, note } = readStateCell(raw)
  if (!state) return { note }
  const verdict: VerdictState | undefined =
    state === "yes" ? "yes" : state === "no" ? "no" : state === "n/a" || state === "na" ? "na" : /^(partial|partly)$/.test(state) ? "partial" : undefined
  return verdict ? { state: verdict, note } : { note: (raw ?? "").trim() }
}
