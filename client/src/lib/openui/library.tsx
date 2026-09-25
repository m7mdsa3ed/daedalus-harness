/* ── The openui language's component library ──
   A model that answers in `openui` writes `identifier = Component(...)` lines,
   and this is the table those names resolve against. Three rules decided it:

   — **one surface rule, held in context.** Anything framed goes through `Box`,
     and `Box` asks where it is: on the page it is a raised card (`FRAME`), inside
     another frame it is a recessed well (`INSET`), inside a `StatRow` it is a
     bare cell. So a Table in a Card is never a second bordered card inside the
     first — the bargain `settings/primitives.tsx` makes with its own `INSET` —
     and no component picks its own ground;
   — **one type scale**: `TITLE` for a thing's name, `BODY` for its text,
     `META` for what qualifies it, `LABEL` (small caps) for a column or a metric's
     name. Every inset is `PAD` or `PAD_ROW`. A component that wants a new size is
     a component that has stopped matching the rest;
   — the schemas stay flat and shallow, which is what the language asks of its
     libraries: every component is a container of strings or a small record, and
     composition is `z.array(Component.ref)`. A deeply nested prop burns tokens
     and is where generation goes wrong.

   `Notice` and `Empty` are still the app's two message boxes, and the
   `--chart-*` tokens colour every chart, so a generated view follows the
   reader's palette. Every text node is `min-w-0` + `break-words`: the panel's
   width is the one thing the model cannot control.

   Nothing here reaches the network or the app's state. The fence's caller does
   not pass a `toolProvider`, so a `Query(...)` in a generated program has no
   tool to find and is dropped by the parser — the model composes a *view* over
   what it already knows, and every tool call the thread makes stays a normal
   ACP call. `bindings` and `toolCalls` are off in the prompt for that reason
   (`scripts/gen-openui.mjs`). */
import { z } from "zod/v4"
import { createContext, useContext, useState, type ReactNode } from "react"
import { Check, ChevronRight, Minus, Plus, X } from "lucide-react"
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  Radar,
  RadarChart,
  XAxis,
  YAxis,
} from "recharts"
import { createLibrary, defineComponent } from "@openuidev/react-lang"
import { Empty } from "@/components/empty"
import { Accordion as UiAccordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious } from "@/components/ui/carousel"
import { DiffView } from "@/components/ui/diff-view"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { Tabs as UiTabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Notice } from "@/components/notice"
import { MermaidFigure, diagramToMermaid } from "@/lib/openui/mermaid"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"
import { cn } from "@/lib/utils"

/* ── The system ── */

const TITLE = "break-words text-[13.5px] leading-snug font-semibold tracking-tight text-foreground"
const BODY = "break-words text-[13px] leading-relaxed text-foreground/90"
const META = "break-words text-xs leading-snug text-muted-foreground"
const LABEL = "break-words text-[10.5px] leading-tight font-medium tracking-[0.06em] uppercase text-muted-foreground"
const PAD = "px-3 py-2.5 @panel-sm:px-3.5 @panel-sm:py-3"
const PAD_ROW = "px-3 py-2 @panel-sm:px-3.5"
/** Between siblings, everywhere: a stack, a card's body, a tab's panel. */
const FLOW = "flex min-w-0 flex-col gap-2.5 @panel-sm:gap-3"
const HAIRLINE = "border-border/60"

const FRAME = "rounded-xl border border-border/70 bg-card shadow-xs"
const INSET = "rounded-lg border border-border/40 bg-muted/40"

type Surface = "page" | "frame" | "cell"
const SurfaceContext = createContext<Surface>("page")

/** The one framed thing. What it looks like is where it is, never the caller's
    choice — which is the whole of "styled the same". Its children are inside a
    frame, so anything framed among them draws as a well. */
function Box({ className, children }: { className?: string; children: ReactNode }) {
  const surface = useContext(SurfaceContext)
  return (
    <SurfaceContext.Provider value="frame">
      <div
        className={cn(
          "min-w-0 overflow-hidden",
          surface === "page" ? FRAME : surface === "frame" ? INSET : "bg-card",
          className
        )}
      >
        {children}
      </div>
    </SurfaceContext.Provider>
  )
}

/** A frame's top band: a name and what qualifies it, over a hairline. */
function BoxHeader({ title, meta }: { title: ReactNode; meta?: ReactNode }) {
  return (
    <header className={cn("min-w-0 space-y-0.5 border-b", HAIRLINE, PAD_ROW, "py-2.5")}>
      <div className={TITLE}>{title}</div>
      {meta && <div className={cn(META, "text-pretty")}>{meta}</div>}
    </header>
  )
}

const TONE_DOT = {
  neutral: "bg-muted-foreground/50",
  info: "bg-chart-2",
  success: "bg-primary",
  warn: "bg-chart-3",
  error: "bg-destructive",
} as const

/* ── Layout ── */

/** `root` is the container the prompt insists on wrapping every program in:
    vertical by default, a wrapping grid for a cluster of cards. The panel's
    width decides the columns, never the window's. */
const Stack = defineComponent({
  name: "Stack",
  description: "Vertical container. The root element every OpenUI program starts from.",
  props: z.object({
    children: z.array(z.any()),
    direction: z.enum(["column", "row"]).optional(),
    gap: z.enum(["sm", "md", "lg"]).optional(),
  }),
  component: ({ props, renderNode }) => (
    <div
      className={cn(
        "min-w-0",
        props.direction === "row"
          ? "grid grid-cols-1 items-start gap-2.5 @panel-sm:grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] @panel-sm:gap-3"
          : FLOW,
        props.gap === "sm" && "gap-1.5 @panel-sm:gap-2",
        props.gap === "lg" && "gap-4 @panel-sm:gap-5"
      )}
    >
      {renderNode(props.children)}
    </div>
  ),
})

/** A titled frame: the header is a band of its own, the body the one flow. */
const Card = defineComponent({
  name: "Card",
  description: "A titled panel holding a group of sections.",
  props: z.object({
    title: z.string(),
    subtitle: z.string().optional(),
    children: z.array(z.any()),
  }),
  component: ({ props, renderNode }) => (
    <Box>
      <BoxHeader title={props.title} meta={props.subtitle} />
      <div className={cn(FLOW, PAD)}>{renderNode(props.children)}</div>
    </Box>
  ),
})

/* A heading and a line under it. Plain characters rather than the app's
   markdown renderer: that lives in `tool-parts.tsx`, which is what this library
   is reached *from*, and importing `Prose` here would close that cycle. */
const Section = defineComponent({
  name: "Section",
  description: "A heading with an optional line of explanatory text.",
  props: z.object({
    title: z.string(),
    text: z.string().optional(),
  }),
  component: ({ props }) => (
    <div className="min-w-0 space-y-1 pt-0.5">
      <h3 className="break-words text-[15px] leading-snug font-semibold tracking-tight text-balance text-foreground">
        {props.title}
      </h3>
      {props.text && <p className={cn(BODY, "text-pretty text-muted-foreground")}>{props.text}</p>}
    </div>
  ),
})

/** A divider, for a generated dashboard that wants one. */
const Divider = defineComponent({
  name: "Divider",
  description: "A horizontal rule.",
  props: z.object({}),
  component: () => <hr className={HAIRLINE} />,
})

/** A folded section: native `<details>`, so it needs no state and survives the
    streaming re-render. */
const Details = defineComponent({
  name: "Details",
  description: "A collapsible section, closed unless `open` is true.",
  props: z.object({
    summary: z.string(),
    children: z.array(z.any()),
    open: z.boolean().optional(),
  }),
  component: ({ props, renderNode }) => (
    <Box>
      <details open={props.open} className="group/details">
        <summary
          className={cn(
            "flex cursor-pointer list-none items-center gap-2 select-none hover:bg-muted/40 [&::-webkit-details-marker]:hidden",
            PAD_ROW,
            "py-2.5"
          )}
        >
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/details:rotate-90" />
          <span className={cn(TITLE, "min-w-0 font-medium")}>{props.summary}</span>
        </summary>
        <div className={cn(FLOW, "border-t", HAIRLINE, PAD)}>{renderNode(props.children)}</div>
      </details>
    </Box>
  ),
})

/** Tabs: alternatives the reader flips between. The `line` variant, so the
    strip reads as a heading over the panel rather than as a pill of its own. */
const Tabs = defineComponent({
  name: "Tabs",
  description: "Switchable panels: each tab has a label and its own children.",
  props: z.object({
    tabs: z.array(z.object({ label: z.string(), children: z.array(z.any()) })),
  }),
  component: ({ props, renderNode }) => (
    <UiTabs defaultValue={0} className="min-w-0 gap-3">
      {/* Scrolls sideways rather than wrapping; `scrollbar-none` keeps a
          classic scrollbar from eating the fixed-height strip's content box,
          which clipped every label against it. */}
      <TabsList
        variant="line"
        className={cn("w-full max-w-full min-w-0 justify-start overflow-x-auto border-b scrollbar-none", HAIRLINE)}
      >
        {props.tabs.map((tab, index) => (
          <TabsTrigger key={index} value={index} className="min-w-0 flex-none text-[13px]">
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {props.tabs.map((tab, index) => (
        <TabsContent key={index} value={index} className={FLOW}>
          {renderNode(tab.children)}
        </TabsContent>
      ))}
    </UiTabs>
  ),
})

/** An FAQ-shaped fold: one frame, a hairline between questions. */
const Accordion = defineComponent({
  name: "Accordion",
  description: "A list of collapsible items, each a title over its own children. Good for FAQs.",
  props: z.object({
    items: z.array(z.object({ title: z.string(), children: z.array(z.any()) })),
  }),
  component: ({ props, renderNode }) => (
    <Box>
      <UiAccordion className="min-w-0">
        {props.items.map((item, index) => (
          <AccordionItem key={index} value={index} className={cn("border-b last:border-b-0", HAIRLINE)}>
            <AccordionTrigger
              className={cn(
                "min-w-0 gap-2 rounded-none hover:bg-muted/40 hover:no-underline [&_[data-slot=accordion-trigger-icon]]:mt-0.5",
                PAD_ROW,
                "py-2.5"
              )}
            >
              <span className={cn(TITLE, "min-w-0 font-medium")}>{item.title}</span>
            </AccordionTrigger>
            <AccordionContent className={cn(PAD, "pt-0")}>
              <div className={FLOW}>{renderNode(item.children)}</div>
            </AccordionContent>
          </AccordionItem>
        ))}
      </UiAccordion>
    </Box>
  ),
})

/* ── Content ── */

/** Short lines. Numbered items wear a counter chip, bullets a dot centred on
    the first line — both in the same 20px column, so a list is aligned
    whichever it is. */
const List = defineComponent({
  name: "List",
  description: "Short lines, numbered or bulleted.",
  props: z.object({
    items: z.array(z.string()),
    numbered: z.boolean().optional(),
  }),
  component: ({ props }) => {
    const Tag = props.numbered ? "ol" : "ul"
    return (
      <Tag className="min-w-0 space-y-1.5">
        {props.items.map((item, index) => (
          <li key={index} className="flex min-w-0 gap-2.5">
            <span className="flex h-[1.625em] w-5 shrink-0 items-center justify-center text-[13px]">
              {props.numbered ? (
                <span className="flex size-5 items-center justify-center rounded-md bg-muted text-[11px] font-medium tabular-nums text-muted-foreground">
                  {index + 1}
                </span>
              ) : (
                <span className="size-1.5 rounded-full bg-foreground/35" />
              )}
            </span>
            <span className={cn(BODY, "min-w-0 flex-1")}>{item}</span>
          </li>
        ))}
      </Tag>
    )
  },
})

/** A cell is a number when it reads as one — a figure, a currency, a percent,
    a short unit. A column whose every filled cell is one aligns to the end. */
const NUMERIC = /^[-+~]?[$€£¥]?\s?\d[\d,.]*\s?(%|[a-zA-Z]{1,3})?$/
function numericColumns(columns: string[], rows: string[][]) {
  return columns.map((_, c) => {
    const cells = rows.map((row) => row[c]?.trim() ?? "").filter(Boolean)
    return cells.length > 0 && cells.every((cell) => NUMERIC.test(cell))
  })
}

/**
 * A table. Plain string margins rather than a row-of-cells schema: a model that
 * has to declare a column set *and* keep its rows in that order gets the pairing
 * wrong far more often than it gets one array of strings wrong.
 *
 * The frame is the scroll container, so a table wider than a phone panel
 * scrolls inside the turn rather than widening it. `tone`: `muted` greys the
 * cells; otherwise the first column is the row's name and wears it.
 */
const Table = defineComponent({
  name: "Table",
  description: "A grid of text cells. `columns` names the headings and each entry of `rows` is one row.",
  props: z.object({
    columns: z.array(z.string()),
    rows: z.array(z.array(z.string())),
    header: z.boolean().optional(),
    tone: z.enum(["default", "muted", "accent"]).optional(),
  }),
  component: ({ props }) => {
    const numeric = numericColumns(props.columns, props.rows)
    const cell = "px-3 py-2 align-top first:ps-3 last:pe-3 @panel-sm:first:ps-3.5 @panel-sm:last:pe-3.5"
    return (
      <Box>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            {props.header !== false && (
              <thead className="bg-muted/40">
                <tr className={cn("border-b", HAIRLINE)}>
                  {props.columns.map((column, index) => (
                    <th key={index} className={cn(cell, LABEL, numeric[index] ? "text-end" : "text-start")}>
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody className="divide-y divide-border/50">
              {props.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="hover:bg-muted/30">
                  {props.columns.map((_, cellIndex) => (
                    <td
                      key={cellIndex}
                      className={cn(
                        cell,
                        "min-w-24 break-words text-foreground/90",
                        numeric[cellIndex] && "min-w-0 text-end whitespace-nowrap tabular-nums",
                        props.tone === "muted" && "text-muted-foreground",
                        cellIndex === 0 && props.tone !== "muted" && "font-medium text-foreground"
                      )}
                    >
                      {row[cellIndex] ?? ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Box>
    )
  },
})

/**
 * A callout. `Notice` is the app's one alert box and its four tones are
 * semantic there, so this passes the tone through rather than painting its own.
 */
const Callout = defineComponent({
  name: "Callout",
  description: "A boxed aside: info, warn, error or neutral, with an optional title.",
  props: z.object({
    text: z.string(),
    tone: z.enum(["neutral", "info", "warn", "error"]).optional(),
    title: z.string().optional(),
  }),
  component: ({ props }) => (
    <Notice
      className="min-w-0 [&_p]:break-words [&_button]:max-w-full [&_button]:whitespace-normal [&_button]:break-words"
      tone={props.tone ?? "neutral"}
      size="sm"
    >
      {props.title && <p className="break-words font-medium text-pretty">{props.title}</p>}
      <span className="break-words">{props.text}</span>
    </Notice>
  ),
})

/** Preformatted text. The language, when named, is the frame's label band — a
    reference, not a highlighted pane. Wraps rather than scrolling, because a
    long token in a phone panel would push the whole answer sideways. */
const Code = defineComponent({
  name: "Code",
  description: "Preformatted text, a snippet or a log.",
  props: z.object({
    text: z.string(),
    language: z.string().optional(),
  }),
  component: ({ props }) => (
    <Box>
      {props.language && (
        <div className={cn("border-b bg-muted/40", HAIRLINE, PAD_ROW, "py-1.5", LABEL)}>{props.language}</div>
      )}
      <pre
        className={cn(
          "overflow-auto font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap text-foreground/90",
          PAD
        )}
      >
        {props.text}
      </pre>
    </Box>
  ),
})

/** A definition list, set like a receipt: the name at the start, the value at
    the end, and a value too long for the line wraps under its name on its own —
    no breakpoint, the flex-wrap is the reflow. */
const KeyValue = defineComponent({
  name: "KeyValue",
  description: "A list of named facts.",
  props: z.object({
    items: z.array(z.object({ key: z.string(), value: z.string() })),
  }),
  component: ({ props }) => (
    <Box>
      <dl className="divide-y divide-border/50">
        {props.items.map((item, index) => (
          <div
            key={index}
            className={cn("flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5", PAD_ROW)}
          >
            <dt className="min-w-0 break-words text-[13px] text-muted-foreground">{item.key}</dt>
            <dd className="ms-auto min-w-0 text-end break-words text-[13px] font-medium text-foreground tabular-nums">
              {item.value}
            </dd>
          </div>
        ))}
      </dl>
    </Box>
  ),
})

/** An absence, drawn as one: the app's dashed box, never an alert. */
const EmptyState = defineComponent({
  name: "EmptyState",
  description: "A box saying there is nothing to show.",
  props: z.object({
    text: z.string(),
  }),
  component: ({ props }) => (
    <Empty className="min-w-0 max-w-full [&_p]:break-words" size="sm">
      {props.text}
    </Empty>
  ),
})

/**
 * An image. Remote images are the one thing in this library that would reach
 * the network, and a URL the model writes can carry whatever the thread has read
 * (a prompt-injected page asking for `https://evil/?q=<secret>`). So a `data:`
 * image draws at once and an `http(s)` one waits behind a click that names its
 * host — the reader's consent is the fetch. Anything else is not drawn.
 */
const Image = defineComponent({
  name: "Image",
  description: "An image from an https or data: URL, with alt text and an optional caption.",
  props: z.object({
    src: z.string(),
    alt: z.string(),
    caption: z.string().optional(),
  }),
  component: ({ props }) => <GeneratedImage {...props} />,
})

function GeneratedImage({ src, alt, caption }: { src: string; alt: string; caption?: string }) {
  const inline = /^data:image\/(png|jpe?g|gif|webp);/i.test(src)
  let host: string | null = null
  try {
    const url = new URL(src)
    if (url.protocol === "https:" || url.protocol === "http:") host = url.host
  } catch {
    /* not a URL — drawn as the alt text below */
  }
  const [shown, setShown] = useState(inline)
  const [failed, setFailed] = useState(false)
  if (failed || (!shown && !host)) {
    return <Empty size="sm">{failed ? `Image failed to load: ${alt}` : alt}</Empty>
  }
  return (
    <Box>
      <figure className="min-w-0">
        {shown ? (
          <img
            src={src}
            alt={alt}
            referrerPolicy="no-referrer"
            onError={() => setFailed(true)}
            className="mx-auto block max-h-96 max-w-full object-contain"
          />
        ) : (
          <button
            type="button"
            onClick={() => setShown(true)}
            className={cn("flex w-full flex-col items-start gap-0.5 text-start hover:bg-muted/40", PAD)}
          >
            <span className={cn(BODY, "[overflow-wrap:anywhere]")}>{alt}</span>
            <span className={cn(META, "[overflow-wrap:anywhere]")}>Load image from {host}</span>
          </button>
        )}
        {caption && (
          <figcaption className={cn(META, "border-t text-pretty", HAIRLINE, PAD_ROW)}>{caption}</figcaption>
        )}
      </figure>
    </Box>
  )
}

/** Short tags. Every chip is the same neutral chip and the tone is a dot, so a
    row of six statuses reads as one row and not as six colours. */
const Badges = defineComponent({
  name: "Badges",
  description: "A row of short tags, each with an optional tone.",
  props: z.object({
    items: z.array(
      z.object({
        text: z.string(),
        tone: z.enum(["neutral", "info", "success", "warn", "error"]).optional(),
      })
    ),
  }),
  component: ({ props }) => (
    <div className="flex min-w-0 flex-wrap gap-1.5">
      {props.items.map((item, index) => (
        <span
          key={index}
          className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/70 bg-card px-2 py-0.5 text-xs font-medium text-foreground/90 shadow-xs"
        >
          <span className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[item.tone ?? "neutral"])} />
          <span className="min-w-0 break-words">{item.text}</span>
        </span>
      ))}
    </div>
  ),
})

/** Ordered events with a state each. The rail is the list; the marker says the
    state by shape as well as by colour. */
const Timeline = defineComponent({
  name: "Timeline",
  description: "Ordered steps or events: a title, optional time and text, and a status.",
  props: z.object({
    items: z.array(
      z.object({
        title: z.string(),
        time: z.string().optional(),
        text: z.string().optional(),
        status: z.enum(["done", "active", "pending", "failed"]).optional(),
      })
    ),
  }),
  component: ({ props }) => (
    <ol className="min-w-0">
      {props.items.map((item, index) => {
        const status = item.status ?? "pending"
        return (
          <li key={index} className="relative flex min-w-0 gap-3 pb-4 last:pb-0">
            {index < props.items.length - 1 && (
              <span className="absolute top-6 bottom-1 left-[9.5px] w-px bg-border" />
            )}
            <span
              className={cn(
                "mt-px flex size-5 shrink-0 items-center justify-center rounded-full",
                status === "done" && "bg-primary text-primary-foreground",
                status === "active" && "bg-primary/15 ring-1 ring-primary ring-inset",
                status === "failed" && "bg-destructive text-white",
                status === "pending" && "bg-card ring-1 ring-border ring-inset"
              )}
            >
              {status === "done" && <Check className="size-3" strokeWidth={3} />}
              {status === "failed" && <X className="size-3" strokeWidth={3} />}
              {status === "active" && <span className="size-2 animate-pulse rounded-full bg-primary" />}
            </span>
            <div className="min-w-0 flex-1 space-y-0.5 pt-px">
              <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3">
                <span
                  className={cn(TITLE, "min-w-0 text-[13px] font-medium", status === "pending" && "text-muted-foreground")}
                >
                  {item.title}
                </span>
                {item.time && <span className={cn(META, "max-w-full tabular-nums")}>{item.time}</span>}
              </div>
              {item.text && <p className={cn(META, "text-pretty")}>{item.text}</p>}
            </div>
          </li>
        )
      })}
    </ol>
  ),
})

/** Options side by side: one frame each, name and verdict as its header band,
    pros and cons marked by glyph as well as by colour. Stacks below `@panel-sm`. */
const Compare = defineComponent({
  name: "Compare",
  description: "Options side by side, each with a name, optional verdict, pros and cons.",
  props: z.object({
    options: z.array(
      z.object({
        name: z.string(),
        verdict: z.string().optional(),
        pros: z.array(z.string()).optional(),
        cons: z.array(z.string()).optional(),
      })
    ),
  }),
  component: ({ props }) => (
    <div className="grid min-w-0 gap-2.5 @panel-sm:grid-cols-[repeat(auto-fit,minmax(min(100%,13rem),1fr))] @panel-sm:gap-3">
      {props.options.map((option, index) => (
        <Box key={index}>
          <BoxHeader title={option.name} meta={option.verdict} />
          <ul className={cn("min-w-0 space-y-1.5", PAD)}>
            {option.pros?.map((pro, i) => (
              <li key={`p${i}`} className="flex min-w-0 gap-2">
                <Plus className="mt-[0.3em] size-3.5 shrink-0 text-primary" strokeWidth={2.5} />
                <span className={cn(BODY, "min-w-0")}>{pro}</span>
              </li>
            ))}
            {option.cons?.map((con, i) => (
              <li key={`c${i}`} className="flex min-w-0 gap-2">
                <Minus className="mt-[0.3em] size-3.5 shrink-0 text-destructive" strokeWidth={2.5} />
                <span className={cn(BODY, "min-w-0")}>{con}</span>
              </li>
            ))}
          </ul>
        </Box>
      ))}
    </div>
  ),
})

/** A before/after of text, drawn by the same line diff tool steps use. */
const Diff = defineComponent({
  name: "Diff",
  description: "A line diff between old and new text, with an optional path.",
  props: z.object({
    before: z.string(),
    after: z.string(),
    path: z.string().optional(),
  }),
  component: ({ props }) => <DiffView oldText={props.before} newText={props.after} path={props.path} />,
})

/** Keyboard chords: the action at the start, the keycaps at the end. */
const Keys = defineComponent({
  name: "Keys",
  description: "Keyboard shortcuts: each entry is a list of keys and what the chord does.",
  props: z.object({
    items: z.array(z.object({ keys: z.array(z.string()), action: z.string() })),
  }),
  component: ({ props }) => (
    <Box>
      <div className="divide-y divide-border/50">
        {props.items.map((item, index) => (
          <div
            key={index}
            className={cn("flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1", PAD_ROW)}
          >
            <span className={cn(BODY, "min-w-0 flex-1 basis-40")}>{item.action}</span>
            <KbdGroup className="ms-auto min-w-0 max-w-full flex-wrap">
              {item.keys.map((key, i) => (
                <Kbd key={i}>{key}</Kbd>
              ))}
            </KbdGroup>
          </div>
        ))}
      </div>
    </Box>
  ),
})

/** People: initials avatars, never a fetched picture (see `Image` for why),
    in a grid of equal cells so the names line up in columns. */
const People = defineComponent({
  name: "People",
  description: "A list of people with a name and optional role, drawn as initials avatars.",
  props: z.object({
    items: z.array(z.object({ name: z.string(), role: z.string().optional() })),
  }),
  component: ({ props }) => (
    <div className="grid min-w-0 grid-cols-[repeat(auto-fill,minmax(min(100%,11rem),1fr))] gap-x-4 gap-y-3">
      {props.items.map((person, index) => (
        <div key={index} className="flex min-w-0 items-center gap-2.5">
          <Avatar>
            <AvatarFallback className="text-xs font-medium">
              {person.name
                .split(/\s+/)
                .slice(0, 2)
                .map((word) => word[0]?.toUpperCase() ?? "")
                .join("")}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 leading-tight">
            <p className="truncate text-[13px] font-medium text-foreground">{person.name}</p>
            {person.role && <p className={cn(META, "truncate")}>{person.role}</p>}
          </div>
        </div>
      ))}
    </div>
  ),
})

/** Several images, one at a time. Each slide is an `Image`, so the click-to-load
    rule holds; the arrows sit inside the frame, which a transcript column has
    room for and shadcn's `-left-12` does not. */
const Gallery = defineComponent({
  name: "Gallery",
  description: "A carousel of images, each with src, alt and optional caption.",
  props: z.object({
    images: z.array(z.object({ src: z.string(), alt: z.string(), caption: z.string().optional() })),
  }),
  component: ({ props }) => (
    <Carousel className="min-w-0">
      <CarouselContent>
        {props.images.map((image, index) => (
          <CarouselItem key={index}>
            <GeneratedImage {...image} />
          </CarouselItem>
        ))}
      </CarouselContent>
      {props.images.length > 1 && (
        <>
          <CarouselPrevious className="left-2" />
          <CarouselNext className="right-2" />
        </>
      )}
    </Carousel>
  ),
})

/* ── Diagrams ── */

/** The frame a diagram sits in is `Box`'s, so it is a card on the page and a
    well inside one, like everything else. */
function Figure({ code, narrowCode, caption }: { code: string; narrowCode?: string; caption?: string }) {
  return (
    <Box className={PAD}>
      <MermaidFigure code={code} narrowCode={narrowCode} caption={caption} box="p-0" />
    </Box>
  )
}

/** A graph written as what it is — nodes and edges — rather than as mermaid
    source: mermaid's syntax is one more thing to get wrong. */
const Diagram = defineComponent({
  name: "Diagram",
  description: "A flowchart from nodes and edges: each node has an id and a label, each edge joins two ids.",
  props: z.object({
    nodes: z.array(
      z.object({
        id: z.string(),
        label: z.string().optional(),
        shape: z.enum(["box", "round", "diamond", "circle"]).optional(),
      })
    ),
    edges: z.array(
      z.object({
        from: z.string(),
        to: z.string(),
        label: z.string().optional(),
        dashed: z.boolean().optional(),
      })
    ),
    direction: z.enum(["down", "right"]).optional(),
    caption: z.string().optional(),
  }),
  /* A pipeline drawn sideways on a phone is a strip of 6px text; below
     `@panel-sm` it is drawn top-down, which is the one shape a column keeps. */
  component: ({ props }) => (
    <Figure
      code={diagramToMermaid(props.nodes, props.edges, props.direction ?? "down")}
      narrowCode={props.direction === "right" ? diagramToMermaid(props.nodes, props.edges, "down") : undefined}
      caption={props.caption}
    />
  ),
})

/** Mermaid source, drawn. The escape hatch for what `Diagram` cannot spell. */
const Mermaid = defineComponent({
  name: "Mermaid",
  description: "A diagram written in Mermaid syntax (sequence, state, class, gantt, flowchart).",
  props: z.object({
    code: z.string(),
    caption: z.string().optional(),
  }),
  component: ({ props }) => <Figure code={props.code} caption={props.caption} />,
})

/* ── Numbers ── */

/** One metric: its name in small caps, the figure large and tabular, the hint
    under it. On its own it is a frame; inside a `StatRow` it is a cell of the
    row's frame. */
const Stat = defineComponent({
  name: "Stat",
  description: "A single metric: a label and a value.",
  props: z.object({
    label: z.string(),
    value: z.string(),
    hint: z.string().optional(),
  }),
  component: ({ props }) => (
    <Box className={cn(PAD, "space-y-1")}>
      <p className={cn(LABEL, "text-balance")}>{props.label}</p>
      <p className="break-words text-xl leading-tight font-semibold tracking-tight text-foreground tabular-nums @panel-sm:text-2xl">
        {props.value}
      </p>
      {props.hint && <p className={cn(META, "text-pretty")}>{props.hint}</p>}
    </Box>
  ),
})

/** A row of `Stat`s as one frame split into cells. Each cell draws its own
    right and bottom hairline as a shadow, and the frame's `overflow-hidden`
    clips the ones on its outer edge — so a row that wraps short leaves card
    ground in the gap, not the grey block a `gap-px` grid would. */
const StatRow = defineComponent({
  name: "StatRow",
  description: "A row of metrics across the width of the page.",
  props: z.object({
    stats: z.array(Stat.ref),
  }),
  component: ({ props, renderNode }) => (
    <Box
      className={cn(
        "grid bg-card [&>*]:shadow-[1px_0_0_0_var(--border),0_1px_0_0_var(--border)]",
        props.stats.length > 1
          ? "grid-cols-2 @panel-sm:grid-cols-[repeat(auto-fit,minmax(9rem,1fr))]"
          : "grid-cols-1"
      )}
    >
      <SurfaceContext.Provider value="cell">{renderNode(props.stats)}</SurfaceContext.Provider>
    </Box>
  ),
})

/** A labelled 0-100 meter: label and figure on one line, the bar under them. */
const Progress = defineComponent({
  name: "Progress",
  description: "A labelled 0–100 meter.",
  props: z.object({
    label: z.string(),
    value: z.number(),
    hint: z.string().optional(),
  }),
  component: ({ props }) => (
    <div className="min-w-0 space-y-1.5">
      <div className="flex min-w-0 items-baseline justify-between gap-x-3">
        <span className={cn(BODY, "min-w-0 truncate")}>{props.label}</span>
        <span className="shrink-0 text-xs font-medium text-foreground tabular-nums">
          {props.hint ?? `${Math.round(props.value)}%`}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-pill bg-muted">
        <div
          className="h-full rounded-pill bg-primary"
          style={{ width: `${Math.min(100, Math.max(0, props.value))}%` }}
        />
      </div>
    </div>
  ),
})

/** A chart: `labels` x-axis, `series` one mark each, the value at index `i`
    belonging to `labels[i]`. Colours are the app's `--chart-*` tokens.
    `pie`/`donut` read the first series only — a slice per label. */
const chartColor = (index: number) => `var(--chart-${(index % 5) + 1})`

const Chart = defineComponent({
  name: "Chart",
  description:
    "A chart over a shared set of labels: line, bar, area, radar, or pie/donut (first series only, one slice per label).",
  props: z.object({
    kind: z.enum(["line", "bar", "area", "pie", "donut", "radar"]),
    labels: z.array(z.string()),
    series: z.array(
      z.object({
        name: z.string(),
        values: z.array(z.number()),
      })
    ),
    height: z.number().optional(),
    stacked: z.boolean().optional(),
  }),
  component: ({ props }) => {
    const round = props.kind === "pie" || props.kind === "donut"
    const data = props.labels.map((label, index) => {
      const row: Record<string, string | number> = { label }
      for (const series of props.series) row[series.name] = series.values[index] ?? 0
      return row
    })
    const config = Object.fromEntries(
      round
        ? props.labels.map((label, index) => [label, { label, color: chartColor(index) }])
        : props.series.map((series, index) => [series.name, { label: series.name, color: chartColor(index) }])
    )
    const stack = props.stacked ? "a" : undefined
    /* A chart cannot reflow, so the mobile work is all in the gutters: a 32px Y
       gutter and 11px ticks give a 320px panel most of its width back, and
       `preserveStartEnd` keeps the ends instead of every colliding label.
       `ChartContainer` passes `initialDimension`, so a panel not yet laid out
       draws a sized chart rather than an empty box. */
    const axes = (
      <>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          fontSize={11}
          interval="preserveStartEnd"
        />
        <YAxis tickLine={false} axisLine={false} width={32} fontSize={11} />
        <ChartTooltip content={<ChartTooltipContent />} />
      </>
    )
    const margin = { left: 0, right: 8, top: 4 }
    const legend = props.series.length > 1 && <ChartLegend content={<ChartLegendContent />} />
    return (
      <Box className="px-2 pt-3 pb-2 @panel-sm:px-3">
        <ChartContainer
          config={config}
          className="aspect-auto w-full min-w-0"
          style={{ height: `${props.height ?? (round || props.kind === "radar" ? 240 : 200)}px` }}
        >
          {round ? (
            <PieChart>
              <ChartTooltip content={<ChartTooltipContent nameKey="label" hideLabel />} />
              <Pie
                data={props.labels.map((label, index) => ({ label, value: props.series[0]?.values[index] ?? 0 }))}
                dataKey="value"
                nameKey="label"
                innerRadius={props.kind === "donut" ? "58%" : 0}
                paddingAngle={props.kind === "donut" ? 2 : 0}
                stroke="var(--card)"
                strokeWidth={2}
              >
                {props.labels.map((label, index) => (
                  <Cell key={label} fill={chartColor(index)} />
                ))}
              </Pie>
              <ChartLegend content={<ChartLegendContent nameKey="label" />} />
            </PieChart>
          ) : props.kind === "radar" ? (
            <RadarChart data={data}>
              <PolarGrid />
              <PolarAngleAxis dataKey="label" fontSize={11} />
              <ChartTooltip content={<ChartTooltipContent />} />
              {props.series.map((series, index) => (
                <Radar
                  key={series.name}
                  dataKey={series.name}
                  stroke={chartColor(index)}
                  fill={chartColor(index)}
                  fillOpacity={0.2}
                />
              ))}
              {legend}
            </RadarChart>
          ) : props.kind === "bar" ? (
            <BarChart data={data} margin={margin}>
              {axes}
              {props.series.map((series, index) => (
                <Bar
                  key={series.name}
                  dataKey={series.name}
                  stackId={stack}
                  fill={chartColor(index)}
                  radius={stack ? 0 : [4, 4, 0, 0]}
                  maxBarSize={40}
                />
              ))}
              {legend}
            </BarChart>
          ) : props.kind === "area" ? (
            <AreaChart data={data} margin={margin}>
              {axes}
              {props.series.map((series, index) => (
                <Area
                  key={series.name}
                  type="monotone"
                  dataKey={series.name}
                  stackId={stack}
                  stroke={chartColor(index)}
                  strokeWidth={2}
                  fill={chartColor(index)}
                  fillOpacity={0.15}
                />
              ))}
              {legend}
            </AreaChart>
          ) : (
            <LineChart data={data} margin={margin}>
              {axes}
              {props.series.map((series, index) => (
                <Line
                  key={series.name}
                  type="monotone"
                  dataKey={series.name}
                  stroke={chartColor(index)}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              ))}
              {legend}
            </LineChart>
          )}
        </ChartContainer>
      </Box>
    )
  },
})

export const openuiLibrary = createLibrary({
  root: "Stack",
  components: [
    Stack,
    Card,
    Section,
    StatRow,
    Stat,
    Table,
    List,
    Callout,
    Code,
    Chart,
    Progress,
    KeyValue,
    EmptyState,
    Divider,
    Image,
    Badges,
    Timeline,
    Compare,
    Details,
    Tabs,
    Accordion,
    Diff,
    Keys,
    People,
    Gallery,
    Diagram,
    Mermaid,
  ],
  componentGroups: [
    {
      name: "Layout",
      components: ["Stack", "Card", "Section", "Divider", "Details", "Tabs", "Accordion"],
      notes: [
        "- `root = Stack([...])` is the entry point: every program must define it.",
        '- Use direction "row" for a cluster of cards; never nest a Stack in a Stack for spacing alone.',
        "- Tabs for alternatives the reader picks between (per OS, before/after); Accordion for FAQs; Details for one optional fold.",
      ],
    },
    {
      name: "Content",
      components: ["List", "Table", "Callout", "Code", "KeyValue", "EmptyState", "Image", "Badges", "Timeline", "Compare", "Diff", "Keys", "People", "Gallery"],
      notes: [
        "- Write each table row as its own array of strings, in the SAME order as `columns`.",
        "- A short answer is prose; reach for these when the answer is a structure.",
        "- Image only with a URL you were actually given; never invent one. Remote images are loaded only when the reader clicks.",
        "- Diff for a before/after of text, Keys for shortcuts, People for who is involved, Gallery for several images.",
        "- Compare for weighing options, Timeline for ordered steps or history, Badges for short statuses.",
      ],
    },
    {
      name: "Diagrams",
      components: ["Diagram", "Mermaid"],
      notes: [
        "- Diagram is the default: give nodes and edges, never Mermaid syntax. Every edge's `from`/`to` must be a node's `id`.",
        "- Mermaid only for what Diagram cannot spell — a sequence, a state machine, a gantt. Write the diagram type on the first line.",
        '- Keep a diagram under ~12 nodes and use direction "right" for a pipeline, "down" for a hierarchy; a wide graph does not survive a narrow panel.',
      ],
    },
    {
      name: "Numbers",
      components: ["StatRow", "Stat", "Chart", "Progress"],
      notes: [
        "- `values` must be the same length as `labels`.",
        "- Prefer StatRow for a handful of figures and Chart for a trend.",
        "- Chart kind: line/area for trends, bar for comparisons (stacked for parts of a total), pie/donut for shares of one whole (few slices), radar for scoring options on several axes.",
      ],
    },
  ],
})
