/* ── Layout primitives ──
   The generic half of the library: a grid, a row, an untitled panel, a line of
   text and a heading, for a view no semantic component names (a dashboard, a
   hero, a split). The freedom is in the arrangement, never in the paint: every
   prop is an enum that resolves to a token class, so there is no colour, size
   or CSS string a model can write, and a Box still picks its own ground, the
   type scale still sizes the text, and the grid still reflows on the panel's
   width. Class names are spelled out whole so Tailwind can see them. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import {
  Activity, ArrowDown, ArrowUp, Bug, Check, Clock, Cloud, Code, Database, DollarSign, Globe, Info, Lock, Server, Shield, Star,
  TriangleAlert, Users, X, Zap, type LucideIcon,
} from "lucide-react"
import { BODY, META, SurfaceContext, TITLE, TONE_DOT } from "@/lib/openui/kit"
import { RichText } from "@/lib/openui/rich-text"

const GAP = {
  sm: "gap-1.5 @panel-sm:gap-2",
  md: "gap-2.5 @panel-sm:gap-3",
  lg: "gap-4 @panel-sm:gap-6",
} as const

const TEXT_TONE = {
  default: "text-foreground",
  muted: "text-muted-foreground",
  success: "text-success",
  warn: "text-warning",
  error: "text-destructive",
} as const

const gapOf = (gap?: keyof typeof GAP) => GAP[gap ?? "md"]

export const Grid = defineComponent({
  name: "Grid",
  description:
    "Children in columns. `columns` (1-4) is equal columns, one on a narrow panel; `split` (2:1, 1:2, 3:1, 1:3) makes two unequal columns; `min` (sm, md, lg) fits as many as the panel holds and ignores the other two. `phone` (1 or 2) is the column count on a narrow panel: 2 for small tiles such as metrics, 1 (default) for anything with text. Give a Panel a `span` to cross every column.",
  props: z.object({
    children: z.array(z.any()),
    columns: z.number().optional(),
    gap: z.enum(["sm", "md", "lg"]).optional(),
    split: z.enum(["2:1", "1:2", "3:1", "1:3"]).optional(),
    min: z.enum(["sm", "md", "lg"]).optional(),
    phone: z.number().optional(),
  }),
  component: ({ props, renderNode }) => {
    const columns = Math.min(4, Math.max(1, Math.round(props.columns ?? 2)))
    return (
      <div
        className={cn(
          "grid w-full min-w-0 items-stretch [&>*]:min-w-0",
          !props.min && (Math.round(props.phone ?? 1) >= 2 ? "grid-cols-2" : "grid-cols-1"),
          props.min === "sm" && "grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),1fr))]",
          props.min === "md" && "grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))]",
          props.min === "lg" && "grid-cols-[repeat(auto-fit,minmax(min(100%,22rem),1fr))]",
          !props.min && props.split === "2:1" && "@panel-sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]",
          !props.min && props.split === "1:2" && "@panel-sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]",
          !props.min && props.split === "3:1" && "@panel-sm:grid-cols-[minmax(0,3fr)_minmax(0,1fr)]",
          !props.min && props.split === "1:3" && "@panel-sm:grid-cols-[minmax(0,1fr)_minmax(0,3fr)]",
          !props.min && !props.split && columns === 2 && "@panel-sm:grid-cols-2",
          !props.min && !props.split && columns === 3 && "@panel-sm:grid-cols-2 @panel-md:grid-cols-3",
          !props.min && !props.split && columns === 4 && "@panel-sm:grid-cols-2 @panel-md:grid-cols-4",
          gapOf(props.gap)
        )}
      >
        {renderNode(props.children)}
      </div>
    )
  },
})

export const Row = defineComponent({
  name: "Row",
  description:
    "Children in a wrapping line, sized to their content: buttons, badges, a label beside a figure. Use Grid for equal columns.",
  props: z.object({
    children: z.array(z.any()),
    align: z.enum(["start", "center", "end", "between"]).optional(),
    gap: z.enum(["sm", "md", "lg"]).optional(),
  }),
  component: ({ props, renderNode }) => (
    <div
      className={cn(
        "flex w-full min-w-0 flex-wrap items-center [&>*]:max-w-full [&>*]:min-w-0",
        (props.align ?? "start") === "start" && "justify-start",
        props.align === "center" && "justify-center",
        props.align === "end" && "justify-end",
        props.align === "between" && "justify-between",
        gapOf(props.gap)
      )}
    >
      {renderNode(props.children)}
    </div>
  ),
})

// `col-span-full` crosses every column the grid has at that width, so a span
// can never invent a column the grid does not own; below `panel-sm` the grid is
// one column and the class is a no-op.
const SPAN = "@panel-sm:col-span-full"

const TINT = {
  neutral: "bg-muted/50",
  info: "bg-primary/[0.07]",
  success: "bg-success/10",
  warn: "bg-warning/10",
  error: "bg-destructive/10",
} as const

export const Panel = defineComponent({
  name: "Panel",
  description:
    "A soft filled tile with no border; its content draws on that same ground, so it reads as one block. Optional `title`, a `tone` (neutral, info, success, warn, error) that tints the tile and puts a status dot before the title, a `footer` line under a soft divider, and a `span` (2 or more) to cross every column of the Grid. Use Card when a bordered, titled frame is wanted.",
  props: z.object({
    children: z.array(z.any()),
    title: z.string().optional(),
    tone: z.enum(["neutral", "info", "success", "warn", "error"]).optional(),
    footer: z.string().optional(),
    span: z.number().optional(),
  }),
  component: ({ props, renderNode }) => (
    <section
      className={cn(
        "flex h-full w-full min-w-0 flex-col gap-3 rounded-2xl p-4 @panel-sm:gap-3.5 @panel-sm:p-5",
        TINT[props.tone ?? "neutral"],
        Math.round(props.span ?? 1) >= 2 && SPAN
      )}
    >
      {props.title && (
        <div className={cn(TITLE, "inline-flex min-w-0 items-center gap-2")}>
          {props.tone && props.tone !== "neutral" && <span aria-hidden className={cn("size-2 shrink-0 rounded-full", TONE_DOT[props.tone])} />}
          <span className="min-w-0 text-balance">{props.title}</span>
        </div>
      )}
      {/* A bare cell: a Stat or Chart draws without a border or ground, and the
          tile's own inset is the only one, so `[&>div]:p-0` takes the Stat's back. */}
      <SurfaceContext.Provider value="cell">
        <div className="flex w-full min-w-0 flex-1 flex-col gap-3 [&>div]:p-0">{renderNode(props.children)}</div>
      </SurfaceContext.Provider>
      {props.footer && (
        <div className={cn(META, "border-t border-foreground/10 pt-3")}>
          <RichText text={props.footer} />
        </div>
      )}
    </section>
  ),
})

export const Heading = defineComponent({
  name: "Heading",
  description: "A heading at one of the type scale's steps: 1 is the view's subject, 2 a division, 3 a small label above a group.",
  props: z.object({
    text: z.string(),
    level: z.number().optional(),
    align: z.enum(["start", "center"]).optional(),
  }),
  component: ({ props }) => {
    const level = Math.min(3, Math.max(1, Math.round(props.level ?? 2)))
    return (
      <div
        role="heading"
        aria-level={level + 1}
        className={cn(
          "w-full min-w-0 text-balance",
          level === 1 && "font-heading text-[1.375rem] leading-tight font-semibold tracking-[-0.02em] break-words text-foreground @panel-sm:text-[1.625rem]",
          level === 2 && TITLE,
          level === 3 && "break-words text-[0.6875rem] leading-tight font-medium tracking-[0.06em] text-muted-foreground uppercase",
          props.align === "center" && "text-center"
        )}
      >
        <RichText text={props.text} />
      </div>
    )
  },
})

export const Text = defineComponent({
  name: "Text",
  description:
    "A paragraph of inline markdown (bold, italic, code, links) in the body or the small caption size, with an optional tone.",
  props: z.object({
    text: z.string(),
    size: z.enum(["body", "small"]).optional(),
    tone: z.enum(["default", "muted", "success", "warn", "error"]).optional(),
    align: z.enum(["start", "center"]).optional(),
  }),
  component: ({ props }) => (
    <p
      className={cn(
        "w-full min-w-0 text-pretty",
        props.size === "small" ? META : BODY,
        props.tone && TEXT_TONE[props.tone],
        props.align === "center" && "text-center"
      )}
    >
      <RichText text={props.text} />
    </p>
  ),
})

const ICONS: Record<string, LucideIcon> = {
  activity: Activity, "arrow-down": ArrowDown, "arrow-up": ArrowUp, bug: Bug, check: Check, clock: Clock, cloud: Cloud, code: Code,
  database: Database, dollar: DollarSign, globe: Globe, info: Info, lock: Lock, server: Server, shield: Shield, star: Star,
  alert: TriangleAlert, users: Users, x: X, zap: Zap,
}

export const Icon = defineComponent({
  name: "Icon",
  description:
    "A small symbol from a fixed set: activity, arrow-down, arrow-up, bug, check, clock, cloud, code, database, dollar, globe, info, lock, server, shield, star, alert, users, x, zap. Put it in a Row beside a Heading or Text.",
  props: z.object({
    name: z.enum(Object.keys(ICONS) as [string, ...string[]]),
    tone: z.enum(["default", "muted", "success", "warn", "error"]).optional(),
  }),
  component: ({ props }) => {
    const Glyph = ICONS[props.name]
    return Glyph ? <Glyph aria-hidden className={cn("size-5 shrink-0", TEXT_TONE[props.tone ?? "muted"])} /> : null
  },
})

const SPACER = { sm: "h-2", md: "h-4", lg: "h-8" } as const

export const Spacer = defineComponent({
  name: "Spacer",
  description: "Empty vertical space (sm, md, lg) between two sections. Use Divider when a rule is wanted.",
  props: z.object({ size: z.enum(["sm", "md", "lg"]).optional() }),
  component: ({ props }) => <div aria-hidden className={cn("w-full", SPACER[props.size ?? "md"])} />,
})
