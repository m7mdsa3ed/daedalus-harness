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
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"
import { createLibrary, defineComponent } from "@openuidev/react-lang"
import { Empty } from "@/components/empty"
import { Notice } from "@/components/notice"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { cn } from "@/lib/utils"

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
        props.gap === "sm" ? "gap-2" : props.gap === "lg" ? "gap-3 @panel-sm:gap-5" : "gap-2.5 @panel-sm:gap-3"
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
      <header className="mb-2 space-y-0.5">
        <h3 className="text-sm font-semibold text-pretty text-foreground">{props.title}</h3>
        {props.subtitle && (
          <p className="text-xs text-pretty text-muted-foreground">{props.subtitle}</p>
        )}
      </header>
      {renderNode(props.children)}
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

/** A chart: `labels` x-axis, `series` one line each, the value at index `i`
    belonging to `labels[i]`. The colours are the app's `--chart-*` tokens, so a
    generated chart follows the reader's palette instead of naming its own. */
const Chart = defineComponent({
  name: "Chart",
  description: "A line or bar chart over a shared set of labels.",
  props: z.object({
    kind: z.enum(["line", "bar"]),
    labels: z.array(z.string()),
    series: z.array(
      z.object({
        name: z.string(),
        values: z.array(z.number()),
      })
    ),
    height: z.number().optional(),
  }),
  component: ({ props }) => {
    const data = props.labels.map((label, index) => {
      const row: Record<string, string | number> = { label }
      for (const series of props.series) row[series.name] = series.values[index] ?? 0
      return row
    })
    const config = Object.fromEntries(
      props.series.map((series, index) => [
        series.name,
        { label: series.name, color: `var(--chart-${(index % 5) + 1})` },
      ])
    )
    /* The mobile work here is all in the gutters, because a chart cannot reflow:
       the Y axis was 36px of tick gutter — a fifth of a 320px panel — and the
       default 12px ticks collide once the plot is that narrow. Thirty pixels and
       an 11px font give the plot back most of the width, `interval:
       "preserveStartEnd"` keeps the first and last label instead of drawing
       every one until they overlap, and the left margin goes to zero because the
       tick gutter is already the margin.

       The zero-width-on-first-measure problem that usually bites a chart in a
       narrow flex parent is already solved one level down: `ChartContainer`
       passes `initialDimension` to its `ResponsiveContainer`, precisely so a
       panel that has not been laid out yet draws a correct-sized chart rather
       than an empty box. */
    return (
      <ChartContainer
        config={config}
        className="aspect-auto w-full"
        style={{ height: `${props.height ?? 200}px` }}
      >
        {props.kind === "bar" ? (
          <BarChart data={data} margin={{ left: 0, right: 6 }}>
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
            {props.series.map((series, index) => (
              <Bar
                key={series.name}
                dataKey={series.name}
                fill={`var(--chart-${(index % 5) + 1})`}
                radius={4}
              />
            ))}
          </BarChart>
        ) : (
          <LineChart data={data} margin={{ left: 0, right: 6 }}>
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
            {props.series.map((series, index) => (
              <Line
                key={series.name}
                type="monotone"
                dataKey={series.name}
                stroke={`var(--chart-${(index % 5) + 1})`}
                strokeWidth={2}
                dot={false}
              />
            ))}
          </LineChart>
        )}
      </ChartContainer>
    )
  },
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
  ],
  componentGroups: [
    {
      name: "Layout",
      components: ["Stack", "Card", "Section", "Divider"],
      notes: [
        "- `root = Stack([...])` is the entry point: every program must define it.",
        '- Use direction "row" for a cluster of cards; never nest a Stack in a Stack for spacing alone.',
      ],
    },
    {
      name: "Content",
      components: ["Section", "List", "Table", "Callout", "Code", "KeyValue", "EmptyState"],
      notes: [
        "- Write each table row as its own array of strings, in the SAME order as `columns`.",
        "- A short answer is prose; reach for these when the answer is a structure.",
      ],
    },
    {
      name: "Numbers",
      components: ["StatRow", "Stat", "Chart", "Progress"],
      notes: [
        "- `values` must be the same length as `labels`.",
        "- Prefer StatRow for a handful of figures and Chart for a trend.",
      ],
    },
  ],
})

