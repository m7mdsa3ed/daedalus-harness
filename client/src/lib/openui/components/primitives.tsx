/* ── Layout primitives ──
   The generic half of the library: a grid, a line of text and a heading, for a
   view no semantic component names (a dashboard, a hero, a split). The freedom is in the arrangement, never in the paint: every
   prop is an enum that resolves to a token class, so there is no colour, size
   or CSS string a model can write, and a Box still picks its own ground, the
   type scale still sizes the text, and the grid still reflows on the panel's
   width. Class names are spelled out whole so Tailwind can see them. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { BODY, LABEL, META, TITLE } from "@/lib/openui/kit"
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
    "Children in columns. `columns` (1-4) is equal columns, one on a narrow panel; `split` (2:1, 1:2, 3:1, 1:3) makes two unequal columns; `min` (sm, md, lg) fits as many as the panel holds and ignores the other two. `phone` (1 or 2) is the column count on a narrow panel: 2 for small tiles such as metrics, 1 (default) for anything with text. Give a Card a `span` to cross every column.",
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
          "openui-flow grid w-full min-w-0 items-stretch [&>*]:min-w-0",
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
          level === 1 && "font-heading text-base leading-snug font-semibold tracking-[-0.015em] break-words text-foreground @panel-sm:text-lg",
          level === 2 && TITLE,
          level === 3 && LABEL,
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
    "A paragraph: every sentence of prose in a view. Inline markdown (bold, italic, code, links) and inline chips (`[[done]]`, `[[Beta|info]]`), in the body or the small caption size, with an optional tone.",
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
