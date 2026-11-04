/* ── The OpenUI kit ──
   The shared render helpers every component in this library draws with — the
   type scale, the one framed surface and the chart colours. They live apart from
   `library.tsx` so a component file can import them without importing the
   library (which imports it back). One `SurfaceContext` exists, defined here
   once, so a `StatRow`'s cell and a `Box` read the same instance.

   The scale is a dense, editorial one and it is deliberately short: a heading, a
   sentence, a qualifying line, a column name and a figure. Nothing in the
   library states a size of its own — a component that wants a new one is a
   component that has stopped matching the rest. */
import { createContext, useContext, useMemo, type CSSProperties, type ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { CodeBlockCopyButton } from "@/components/ui/code-block"
import { highlightTokens } from "@/lib/highlight"
import { cn } from "@/lib/utils"

/** A thing's name. Tight leading and a touch of negative tracking, so a two-line
    title reads as one block rather than as two paragraphs. */
export const TITLE = "break-words font-heading text-[length:calc(var(--text-sm,0.875rem)+0.125rem)] leading-[1.3] font-semibold tracking-[-0.012em] text-foreground"
/** Its text. */
export const BODY = "break-words text-[length:var(--text-sm,0.875rem)] leading-[1.6] text-foreground"
/** What qualifies it — a fact line, a caption, a hint. */
export const META = "break-words text-[length:calc(var(--text-sm,0.875rem)-0.0625rem)] leading-[1.5] text-muted-foreground"
/** A column's or a metric's name: the smallest step, and the only one that is
    not meant to be read as a sentence. */
export const LABEL = "break-words text-[0.6875rem] leading-tight font-medium tracking-[0.06em] text-muted-foreground uppercase"
/** A figure. One size for every number the library sets large — a `Stat`, a
    `Sparkline`'s value — so two metrics side by side are the same metric. */
export const FIG = "font-heading text-[1.75rem] leading-[1.05] font-semibold tracking-[-0.03em] tabular-nums text-foreground @panel-sm:text-[2.25rem]"

/** The body inset of a frame. */
export const PAD = "p-3.5 @panel-sm:p-4"
/** `PAD` for a body that holds wells or a corner tile: the same inset, stated
    as the frame's (`frame-p-*`), so what is inside derives a concentric corner
    (`rounded-inner`) from the card's. */
export const WELL_PAD = "frame-p-3.5 @panel-sm:frame-p-4"
/** One row of a framed list — the same inset horizontally, less above and below,
    because a list supplies its own rhythm between its rows. */
export const PAD_ROW = "px-3.5 py-2.5 @panel-sm:px-4 @panel-sm:py-3"
/** A row of a list that is not framed: the page's own margin, and the first and
    last rows flush so the list sits at the same edge as the prose beside it. */
export const LIST_ROW = "min-w-0 py-3 first:pt-0 last:pb-0"
/** Between siblings, everywhere: a stack, a card's body, a tab's panel. */
export const FLOW = "flex w-full min-w-0 flex-col gap-3 @panel-sm:gap-4"

/** The well a frame inside a frame becomes — the settings kit's `INSET`. */
export const INSET = "rounded-inner border border-rule bg-wash"

export type Surface = "page" | "frame" | "cell"
export const SurfaceContext = createContext<Surface>("page")

/** The one framed thing. What it looks like is where it is, never the caller's
    choice — which is the whole of "styled the same". On the page it is the
    registry `Card` (its spacing and flex column zeroed, so the caller lays out
    its own body); inside a frame it is a well; inside a `StatRow` a bare cell.
    Its children are inside a frame, so anything framed among them draws as a well.

    The page ground is the registry card's own hairline, unchanged: at this
    density what separates two frames is the rule in them and the space between
    them, so the frame keeps the card's corner and states it (`frame-2xl`) — the
    one value the body's `WELL_PAD` derives `rounded-inner` from. */
export function Box({ className, children, style }: { className?: string; children: ReactNode; style?: CSSProperties }) {
  const surface = useContext(SurfaceContext)
  const box = cn("w-full min-w-0 overflow-hidden", className)
  return (
    <SurfaceContext.Provider value="frame">
      {surface === "page" ? (
        // The card is the frame (`frame-2xl`, which is the card's own corner);
        // its own padding is 0 until a body states one with `WELL_PAD`, so an
        // outer frame's never leaks in.
        <Card className={cn("block gap-0 py-0 frame-2xl [--frame-p:0px]", box)} style={style}>
          {children}
        </Card>
      ) : (
        <div className={cn(surface === "frame" && INSET, box)} style={style}>
          {children}
        </div>
      )}
    </SurfaceContext.Provider>
  )
}

/** A frame's top band: a name and what qualifies it, over a hairline. */
export function BoxHeader({ title, meta }: { title: ReactNode; meta?: ReactNode }) {
  return (
    <header className={cn("min-w-0 space-y-0.5 border-b bg-wash", PAD_ROW)}>
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

/** A chip's ground: the tone as a faint wash with a matching hairline, so a
    status reads at a glance without a saturated fill. */
export const TONE_CHIP = {
  neutral: "border-rule bg-wash",
  info: "border-primary/25 bg-primary/8",
  success: "border-success/30 bg-success/10",
  warn: "border-warning/35 bg-warning/10",
  error: "border-destructive/30 bg-destructive/10",
} as const

/** Colours are the app's `--chart-*` tokens. */
export const chartColor = (index: number) => `var(--chart-${(index % 5) + 1})`

/** The one state chip: an outline whose tone is a dot and never a fill, so a
    column of six statuses reads as a column and not as six colours. `Badges`,
    a `Rows` row and a finding's severity wear the same chip — a status means
    the same thing in all of them. */
export function ToneChip({ text, tone }: { text: string; tone?: keyof typeof TONE_DOT }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-auto max-w-full gap-1.5 rounded-full px-2 py-0.5 text-[0.75rem] leading-[1.35] font-medium whitespace-normal text-foreground",
        TONE_CHIP[tone ?? "neutral"]
      )}
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[tone ?? "neutral"])} />
      <span className="min-w-0 break-words">{text}</span>
    </Badge>
  )
}

/** A state said as a dot and a word, where a chip's border would be one frame
    too many — a row of a list that is already inside one. */
export function StateLine({
  tone,
  children,
  className,
}: {
  tone?: keyof typeof TONE_DOT
  children: ReactNode
  className?: string
}) {
  return (
    <span className={cn(META, "inline-flex items-center gap-1", className)}>
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[tone ?? "neutral"])} />
      {children}
    </span>
  )
}

/** The five tones as a glyph's colour. */
const TONE_TEXT = {
  neutral: "text-muted-foreground",
  info: "text-primary",
  success: "text-success",
  warn: "text-warning",
  error: "text-destructive",
} as const

/** How far a status list has got, as one thin bar under its header: a segment
    per tone, as wide as its count. The remainder is the ground, so what has not
    happened yet needs no segment of its own — pass `total` when it is more than
    the parts add up to. */
export function TallyBar({ parts, total: of }: { parts: { tone: keyof typeof TONE_DOT; count: number }[]; total?: number }) {
  const total = of ?? parts.reduce((sum, part) => sum + part.count, 0)
  if (total === 0) return null
  return (
    <div aria-hidden className="flex h-1 w-full min-w-0 overflow-hidden bg-wash-strong">
      {parts.map((part, index) =>
        part.count > 0 ? (
          <span
            key={index}
            className={cn(TONE_BAR[part.tone], "transition-[width] duration-500 ease-out motion-reduce:transition-none")}
            style={{ width: `${(part.count / total) * 100}%` }}
          />
        ) : null
      )}
    </div>
  )
}

export interface StatusRow {
  tone: keyof typeof TONE_DOT
  /** Absent draws an empty disc — a step not begun. */
  Icon?: LucideIcon
  spin?: boolean
  /** The state in words, for a screen reader; the disc says it to the eye. */
  word: string
  name: ReactNode
  detail?: ReactNode
  /** A chip at the row's end — a plan step's priority. */
  end?: ReactNode
  /** Drawn quieter: a step that is finished and no longer asks to be read. */
  dim?: boolean
}

/** A framed list of things with a state — `Checks` after the fact, `Plan` before
    it — so a report and a checklist are one row: a tinted disc carrying the
    state's glyph, the name, and a line that qualifies it. */
export function StatusRows({ items }: { items: StatusRow[] }) {
  if (items.length === 0) return null
  return (
    <ul className="w-full min-w-0 list-none divide-y divide-rule">
      {items.map((item, index) => (
        <li key={index} className={cn("flex min-w-0 items-start gap-3", PAD_ROW)}>
          <span aria-hidden className={cn("mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border", TONE_CHIP[item.tone])}>
            {item.Icon && (
              <item.Icon className={cn("size-3", TONE_TEXT[item.tone], item.spin && "motion-safe:animate-spin")} strokeWidth={2.75} />
            )}
          </span>
          <span className="sr-only">{item.word}:</span>
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className={cn(BODY, "font-medium", item.dim && "text-muted-foreground")}>{item.name}</p>
            {item.detail && <p className={cn(META, "text-pretty")}>{item.detail}</p>}
          </div>
          {item.end && <div className="mt-0.5 shrink-0">{item.end}</div>}
        </li>
      ))}
    </ul>
  )
}

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
   `Code`, `Terminal` and a `Steps` command are the three places a generated
   view draws characters that are meant to be copied, and they were three
   hand-rolled `<pre>`s with three insets and no way to take the text. This is
   the one surface they share, so a snippet reads the same wherever the model
   puts it:

   — the ground is the caller's `Box`, never this: a top-level snippet IS the
     frame (a card whose body is the code), and the same well inside a step's
     body is a card's `INSET`. Stating one here made every snippet two borders
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

/** The band over a well: a caption at the start, a reading at the end, over a
    hairline. One declaration for `Code`'s language and `Terminal`'s cwd-and-exit
    line, so the two headers are the same geometry — they were different insets
    and one of them had no rule at all. It reaches the frame's edges because it
    sits inside `Box`, whose own padding a band is allowed to own, exactly as
    `BoxHeader` does. */
export function CodeBand({ start, end }: { start?: ReactNode; end?: ReactNode }) {
  return (
    <div className={cn("flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-rule bg-wash py-1", PAD_ROW)}>
      <span className={cn(LABEL, "min-w-0 flex-1 basis-32 font-mono")}>{start}</span>
      {end}
    </div>
  )
}

export function CodeWell({
  code,
  language,
  prefix,
  tail,
  header,
  className,
}: {
  code: string
  language?: string
  /** A prompt mark drawn before the code, never copied — Terminal's `$`. */
  prefix?: string
  /** Text after the code, drawn plain and not parsed by the grammar — a
      command's output, which is whatever it printed and never a language. */
  tail?: string
  /** A band above the code inside the well — `CodeBand` for the language, or
      Terminal's cwd and exit line. */
  header?: ReactNode
  className?: string
}) {
  const tokens = useMemo(() => highlightTokens(code, language), [code, language])
  const body = code.replace(/\n+$/, "")
  const rest = (tail ?? "").replace(/\n+$/, "")
  /* What the reader pastes, which is the code and its output — never the
     prompt mark. */
  const copied = rest ? `${body}\n\n${rest}` : body
  return (
    <div className={cn("openui-code group/code w-full min-w-0", className)}>
      {header}
      {/* The button is anchored to the code, not to the well: over the whole
          well it landed on top of the band's own text. */}
      <div className="relative min-w-0">
        <pre
          tabIndex={0}
          dir="ltr"
          className="min-w-0 overflow-auto px-2.5 py-2 font-mono text-[0.75rem] leading-[1.6] break-words whitespace-pre-wrap text-foreground @panel-sm:px-3"
        >
          <code>
            {prefix && (
              <span aria-hidden className="select-none text-muted-foreground">
                {prefix}{" "}
              </span>
            )}
            {tokens
              ? tokens.map((token, index) => (token.className ? <span key={index} className={token.className}>{token.text}</span> : token.text))
              : body}
            {rest && <span className="mt-1.5 block">{rest}</span>}
          </code>
        </pre>
        <div className="absolute end-1 top-1 z-10 opacity-0 transition-opacity group-focus-within/code:opacity-100 group-hover/code:opacity-100 pointer-coarse:opacity-100">
          <CodeBlockCopyButton value={copied} className="bg-background/80 ring-1 ring-rule backdrop-blur-sm" />
        </div>
      </div>
    </div>
  )
}
