/* ── Retired components, still drawn ──
   The library was cut from 76 components to the current table (94762247), and
   the prompt stopped teaching the rest. But a stored answer still names them,
   and so does a model that copies its own earlier answers back out of a long
   thread's context. The parser drops a name it does not know without failing
   the parse (`unknown-component`), so `Tabs([{children: [Checks(...)]}])`
   drew every tab as an empty panel, with no error the reader could see.

   Each name here keeps its old positional signature, so an old call parses
   exactly as it did before, and draws through the current component that
   absorbed it (mostly `List`). They are registered with the *renderer* only
   (`openuiRenderLibrary`) and never with the prompt's library, which would list
   them under "### Other" and teach them again. Schemas are deliberately looser
   than the originals (a state is any string): a model writing an old name has
   already got its vocabulary from somewhere other than the prompt. */
import type { ReactNode } from "react"
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { Box, BoxHeader, FLOW, TONES, WELL_PAD } from "@/lib/openui/kit"
import { Accordion } from "@/lib/openui/components/Accordion"
import { Callout } from "@/lib/openui/components/Callout"
import { Card } from "@/lib/openui/components/Card"
import { Chart } from "@/lib/openui/components/Chart"
import { Code } from "@/lib/openui/components/Code"
import { List } from "@/lib/openui/components/List"
import { Stack } from "@/lib/openui/components/Stack"
import { Grid, Heading, Text } from "@/lib/openui/components/primitives"

type Tone = (typeof TONES)[number]
type Item = { text: string; meta?: string; state?: string; tone?: Tone; href?: string; code?: string; language?: string }

const joined = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(" - ") || undefined

/** A titled frame around one body, as the retired list components drew. */
function Framed({ title, meta, children }: { title?: string; meta?: string; children: ReactNode }) {
  return (
    <Box>
      {title && <BoxHeader title={title} meta={meta} />}
      <div className={cn(FLOW, WELL_PAD)}>{children}</div>
    </Box>
  )
}

const ListOf = ({ items, numbered, renderNode }: { items: Item[]; numbered?: boolean; renderNode: (value: unknown) => ReactNode }) => (
  <List.component props={{ items, numbered }} renderNode={renderNode} />
)

const Checks = defineComponent({
  name: "Checks",
  description: "Retired: a List with a state per row.",
  props: z.object({
    items: z.array(z.object({ name: z.string(), state: z.string().optional(), detail: z.string().optional() })),
    title: z.string().optional(),
  }),
  component: ({ props, renderNode }) => (
    <Framed title={props.title}>
      <ListOf renderNode={renderNode} items={(props.items ?? []).map((item) => ({ text: item.name, state: item.state, meta: item.detail }))} />
    </Framed>
  ),
})

const Plan = defineComponent({
  name: "Plan",
  description: "Retired: a List of steps with a status.",
  props: z.object({
    title: z.string(),
    steps: z.array(z.object({ text: z.string(), status: z.string().optional(), note: z.string().optional(), priority: z.string().optional() })),
    goal: z.string().optional(),
  }),
  component: ({ props, renderNode }) => (
    <Framed title={props.title} meta={props.goal}>
      <ListOf renderNode={renderNode} items={(props.steps ?? []).map((step) => ({ text: step.text, state: step.status, meta: step.note }))} />
    </Framed>
  ),
})

const Steps = defineComponent({
  name: "Steps",
  description: "Retired: a numbered List with a command per step.",
  props: z.object({
    title: z.string(),
    steps: z.array(z.object({ title: z.string(), text: z.string().optional(), code: z.string().optional(), language: z.string().optional() })),
  }),
  component: ({ props, renderNode }) => (
    <Framed title={props.title}>
      <ListOf
        numbered
        renderNode={renderNode}
        items={(props.steps ?? []).map((step) => ({ text: step.title, meta: step.text, code: step.code, language: step.language }))}
      />
    </Framed>
  ),
})

const SEVERITY_TONE: Record<string, Tone> = { critical: "error", high: "error", medium: "warn", low: "info", info: "neutral" }

const Findings = defineComponent({
  name: "Findings",
  description: "Retired: a List with the severity as the state.",
  props: z.object({
    items: z.array(
      z.object({ title: z.string(), severity: z.string().optional(), location: z.string().optional(), text: z.string().optional(), fix: z.string().optional() })
    ),
    title: z.string().optional(),
  }),
  component: ({ props, renderNode }) => (
    <Framed title={props.title}>
      <ListOf
        renderNode={renderNode}
        items={(props.items ?? []).map((item) => ({
          text: item.title,
          state: item.severity,
          tone: item.severity ? SEVERITY_TONE[item.severity.toLowerCase()] : undefined,
          meta: joined(item.location, item.text, item.fix && `Fix: ${item.fix}`),
        }))}
      />
    </Framed>
  ),
})

const Rows = defineComponent({
  name: "Rows",
  description: "Retired: a List of records.",
  props: z.object({
    items: z.array(
      z.object({ title: z.string(), status: z.string().optional(), tone: z.enum(TONES).optional(), meta: z.string().optional(), text: z.string().optional(), href: z.string().optional() })
    ),
  }),
  component: ({ props, renderNode }) => (
    <ListOf
      renderNode={renderNode}
      items={(props.items ?? []).map((item) => ({ text: item.title, state: item.status, tone: item.tone, meta: joined(item.meta, item.text), href: item.href }))}
    />
  ),
})

const Timeline = defineComponent({
  name: "Timeline",
  description: "Retired: a List of dated entries.",
  props: z.object({
    items: z.array(z.object({ title: z.string(), time: z.string().optional(), text: z.string().optional(), status: z.string().optional() })),
  }),
  component: ({ props, renderNode }) => (
    <ListOf renderNode={renderNode} items={(props.items ?? []).map((item) => ({ text: item.title, state: item.status, meta: joined(item.time, item.text) }))} />
  ),
})

const Stepper = defineComponent({
  name: "Stepper",
  description: "Retired: stages with the current one marked.",
  props: z.object({ stages: z.array(z.string()), current: z.number() }),
  component: ({ props, renderNode }) => {
    const at = Math.round(props.current ?? 0)
    return (
      <ListOf
        renderNode={renderNode}
        items={(props.stages ?? []).map((stage, index) => ({ text: stage, state: index + 1 < at ? "done" : index + 1 === at ? "active" : "pending" }))}
      />
    )
  },
})

const Compare = defineComponent({
  name: "Compare",
  description: "Retired: options with a verdict, pros and cons.",
  props: z.object({
    options: z.array(z.object({ name: z.string(), verdict: z.string().optional(), pros: z.array(z.string()).optional(), cons: z.array(z.string()).optional() })),
  }),
  component: ({ props, renderNode }) => (
    <ListOf
      renderNode={renderNode}
      items={(props.options ?? []).map((option) => ({
        text: option.name,
        state: option.verdict,
        meta: joined(option.pros?.length ? `Pros: ${option.pros.join("; ")}` : undefined, option.cons?.length ? `Cons: ${option.cons.join("; ")}` : undefined),
      }))}
    />
  ),
})

const KeyValue = defineComponent({
  name: "KeyValue",
  description: "Retired: a List of keys over values.",
  props: z.object({ items: z.array(z.object({ key: z.string(), value: z.string() })) }),
  component: ({ props, renderNode }) => <ListOf renderNode={renderNode} items={(props.items ?? []).map((item) => ({ text: item.key, meta: item.value }))} />,
})

const Glossary = defineComponent({
  name: "Glossary",
  description: "Retired: a List of terms over definitions.",
  props: z.object({ items: z.array(z.object({ term: z.string(), definition: z.string() })) }),
  component: ({ props, renderNode }) => <ListOf renderNode={renderNode} items={(props.items ?? []).map((item) => ({ text: item.term, meta: item.definition }))} />,
})

const Section = defineComponent({
  name: "Section",
  description: "Retired: a Heading over a Text.",
  props: z.object({ title: z.string(), text: z.string().optional() }),
  component: ({ props, renderNode }) => (
    <div className={FLOW}>
      <Heading.component props={{ text: props.title, level: 2 }} renderNode={renderNode} />
      {props.text && <Text.component props={{ text: props.text }} renderNode={renderNode} />}
    </div>
  ),
})

const Verdict = defineComponent({
  name: "Verdict",
  description: "Retired: a lead Callout.",
  props: z.object({ headline: z.string(), tone: z.enum(TONES).optional(), text: z.string().optional(), facts: z.array(z.string()).optional() }),
  component: ({ props, renderNode }) => (
    <Callout.component
      props={{ title: props.headline, tone: props.tone, lead: true, text: [props.text, ...(props.facts ?? [])].filter(Boolean).join(" · ") }}
      renderNode={renderNode}
    />
  ),
})

const EmptyState = defineComponent({
  name: "EmptyState",
  description: "Retired: a neutral Callout.",
  props: z.object({ text: z.string() }),
  component: ({ props, renderNode }) => <Callout.component props={{ text: props.text, tone: "neutral" }} renderNode={renderNode} />,
})

const Panel = defineComponent({
  name: "Panel",
  description: "Retired: a Card.",
  props: z.object({
    children: z.array(z.any()),
    title: z.string().optional(),
    tone: z.enum(TONES).optional(),
    footer: z.string().optional(),
    span: z.number().optional(),
  }),
  component: ({ props, renderNode }) => (
    <Card.component props={{ title: props.title ?? "", children: props.children, tone: props.tone, footer: props.footer, span: props.span }} renderNode={renderNode} />
  ),
})

const Details = defineComponent({
  name: "Details",
  description: "Retired: a one-item Accordion.",
  props: z.object({ summary: z.string(), children: z.array(z.any()), open: z.boolean().optional() }),
  component: ({ props, renderNode }) => (
    <Accordion.component props={{ items: [{ title: props.summary, children: props.children, open: props.open }] }} renderNode={renderNode} />
  ),
})

const StatRow = defineComponent({
  name: "StatRow",
  description: "Retired: a Grid of Stats.",
  props: z.object({ stats: z.array(z.any()) }),
  component: ({ props, renderNode }) => {
    const stats = props.stats ?? []
    return <Grid.component props={{ children: stats, columns: Math.min(4, Math.max(1, stats.length)), phone: 2 }} renderNode={renderNode} />
  },
})

const Row = defineComponent({
  name: "Row",
  description: "Retired: a row Stack.",
  props: z.object({ children: z.array(z.any()), align: z.enum(["start", "center", "end", "between"]).optional(), gap: z.enum(["sm", "md", "lg"]).optional() }),
  component: ({ props, renderNode }) => (
    <Stack.component props={{ children: props.children, direction: "row", align: props.align, gap: props.gap }} renderNode={renderNode} />
  ),
})

const Spacer = defineComponent({
  name: "Spacer",
  description: "Retired: draws nothing.",
  props: z.object({ size: z.enum(["sm", "md", "lg"]).optional() }),
  component: () => null,
})

const Diff = defineComponent({
  name: "Diff",
  description: "Retired: a diff Code block.",
  props: z.object({ before: z.string(), after: z.string(), path: z.string().optional() }),
  component: ({ props, renderNode }) => {
    const lines = (text: string | undefined, sign: string) => (text ?? "").split("\n").map((line) => sign + line)
    const text = [...lines(props.before, "-"), ...lines(props.after, "+")].join("\n")
    return <Code.component props={{ text, language: "diff", title: props.path }} renderNode={renderNode} />
  },
})

const Breakdown = defineComponent({
  name: "Breakdown",
  description: "Retired: a bar Chart.",
  props: z.object({ items: z.array(z.object({ label: z.string(), value: z.number(), tone: z.enum(TONES).optional() })), title: z.string().optional() }),
  component: ({ props, renderNode }) => {
    const items = props.items ?? []
    return (
      <Chart.component
        props={{ kind: "bar", labels: items.map((item) => item.label), series: [{ name: props.title ?? "Value", values: items.map((item) => item.value) }], title: props.title }}
        renderNode={renderNode}
      />
    )
  },
})

/** Every retired name a stored answer still uses, for the renderer's library only. */
export const LEGACY_COMPONENTS = [
  Checks,
  Plan,
  Steps,
  Findings,
  Rows,
  Timeline,
  Stepper,
  Compare,
  KeyValue,
  Glossary,
  Section,
  Verdict,
  EmptyState,
  Panel,
  Details,
  StatRow,
  Row,
  Spacer,
  Diff,
  Breakdown,
]
