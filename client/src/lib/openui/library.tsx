/* ── The openui language's component library ──
   A model that answers in `openui` writes `identifier = Component(...)` lines,
   and this is the table those names resolve against. Three rules decided it:

   — **one surface rule, held in context.** Anything framed goes through `Box`
     (`kit.tsx`), and `Box` asks where it is: on the page it is the registry
     `Card`, inside another frame it is a recessed well (`INSET`), inside a
     `StatRow` it is a bare cell. So a Table in a Card is never a second bordered
     card inside the first — the bargain `settings/primitives.tsx` makes with its
     own `INSET` — and no component picks its own ground;
   — **one type scale**: `TITLE` for a thing's name, `BODY` for its text,
     `META` for what qualifies it, `LABEL` for a column or a metric's
     name. Every inset is `PAD` or `PAD_ROW`. A component that wants a new size is
     a component that has stopped matching the rest;
   — the schemas stay flat and shallow, which is what the language asks of its
     libraries: every component is a container of strings or a small record, and
     composition is `z.array(Component.ref)`. A deeply nested prop burns tokens
     and is where generation goes wrong.

   **Each component is one file in `components/`**, named for what it exports.
   This file only lists them, so adding a component is a new file and one line
   here — the diff that adds it is readable, and the diff that restyles one is
   never a diff in a two-thousand-line module.

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
import { createLibrary } from "@openuidev/react-lang"
import { UI_GROUPS } from "@/lib/openui/groups"

import { Stack } from "@/lib/openui/components/Stack"
import { Card } from "@/lib/openui/components/Card"
import { Section } from "@/lib/openui/components/Section"
import { Divider } from "@/lib/openui/components/Divider"
import { Details } from "@/lib/openui/components/Details"
import { Tabs } from "@/lib/openui/components/Tabs"
import { Accordion } from "@/lib/openui/components/Accordion"
import { Grid, Row, Panel, Heading, Text, Icon, Spacer } from "@/lib/openui/components/primitives"

import { Markdown } from "@/lib/openui/components/Markdown"
import { Verdict } from "@/lib/openui/components/Verdict"
import { List } from "@/lib/openui/components/List"
import { Table } from "@/lib/openui/components/Table"
import { Matrix } from "@/lib/openui/components/Matrix"
import { Callout } from "@/lib/openui/components/Callout"
import { KeyValue } from "@/lib/openui/components/KeyValue"
import { Badges } from "@/lib/openui/components/Badges"
import { EmptyState } from "@/lib/openui/components/EmptyState"
import { Compare } from "@/lib/openui/components/Compare"
import { People } from "@/lib/openui/components/People"
import { Quote } from "@/lib/openui/components/Quote"
import { Link, Links } from "@/lib/openui/components/Links"
import { Rows } from "@/lib/openui/components/Rows"
import { FeatureGrid } from "@/lib/openui/components/FeatureGrid"
import { Glossary } from "@/lib/openui/components/Glossary"
import { Kanban } from "@/lib/openui/components/Kanban"
import { Stepper } from "@/lib/openui/components/Stepper"
import { Agenda } from "@/lib/openui/components/Agenda"
import { Gauge } from "@/lib/openui/components/Gauge"
import { Endpoints } from "@/lib/openui/components/Endpoints"
import { PricingTiers } from "@/lib/openui/components/PricingTiers"
import { Testimonial } from "@/lib/openui/components/Testimonial"
import { Faq } from "@/lib/openui/components/Faq"
import { AvatarGroup } from "@/lib/openui/components/AvatarGroup"
import { Calendar } from "@/lib/openui/components/Calendar"

import { Timeline } from "@/lib/openui/components/Timeline"
import { Plan } from "@/lib/openui/components/Plan"
import { Steps } from "@/lib/openui/components/Steps"
import { Checks } from "@/lib/openui/components/Checks"

import { Code } from "@/lib/openui/components/Code"
import { Diff } from "@/lib/openui/components/Diff"
import { Keys } from "@/lib/openui/components/Keys"
import { FileTree } from "@/lib/openui/components/FileTree"
import { Findings } from "@/lib/openui/components/Findings"
import { Terminal } from "@/lib/openui/components/Terminal"

import { Flowchart } from "@/lib/openui/components/Flowchart"
import { Sequence } from "@/lib/openui/components/Sequence"
import { Quadrant } from "@/lib/openui/components/Quadrant"

import { Stat, StatRow } from "@/lib/openui/components/Stat"
import { Sparkline } from "@/lib/openui/components/Sparkline"
import { Chart } from "@/lib/openui/components/Chart"
import { Bars } from "@/lib/openui/components/Bars"
import { Breakdown } from "@/lib/openui/components/Breakdown"
import { Heatmap } from "@/lib/openui/components/Heatmap"
import { Funnel } from "@/lib/openui/components/Funnel"
import { Waterfall } from "@/lib/openui/components/Waterfall"
import { Progress } from "@/lib/openui/components/Progress"

import { Image, Gallery } from "@/lib/openui/components/Image"

import { Map } from "@/lib/openui/components/Map"
import { CardGrid } from "@/lib/openui/components/CardGrid"

import { Button, Checkbox, Form, FormControl, Input, Select, SelectItem, Slider, Textarea } from "@/lib/openui/components/interactive"

/** What each group's section tells the model beyond its signatures. The names
    and membership are `groups.ts`'s; a note must only mention components of its
    own group, because a narrowed prompt drops every other section. */
const GROUP_NOTES: Record<string, string[]> = {
  layout: [
    "- A dashboard is a Heading, then a Grid of Panels holding metrics, then a Grid with `split` \"2:1\" (a wide Panel beside a narrow one), with a Panel `span` for a full-width row. Panel `tone` tints a tile for a status, `footer` is a source or timestamp. Give a Grid of small metric tiles `phone` 2 so they sit two across on a phone.",
    "- Icon is a symbol from a fixed set, put in a Row beside a Heading or Text; Spacer is vertical space between sections.",
    "- Grid, Row, Panel, Heading and Text are the generic pieces for a layout no other component names (a dashboard, a hero, a split). Prefer the specific component when one matches the content; they take only enums, never CSS or colours.",
    "- Grid(children, columns 1-4, gap) is equal columns that fall to one on a narrow panel: put Panels, Cards or Stats in it. Row(children, align, gap) is a wrapping line sized to content: buttons, badges.",
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
    "- Pick the specific component for the shape you have (Table for values, Rows for paragraphs, Verdict for a conclusion); a one-sentence answer is the only one that stays prose.",
    "- A table with a state in it takes `tones: true`, and a state cell then OPENS with its word: `[\"stage\", \"state\"], [[\"unit\", \"pass, 412 tests\"], [\"e2e\", \"fail, 3 flaky\"]]`. Without the flag a cell is drawn exactly as written, which is right for a table of values and wrong for a column of verdicts.",
    "- Compare for weighing options, Badges for short statuses, People for who is involved.",
    "- A link is the words and the address they open: `Link` for one, `Links` for several. Draw the link instead of pasting a URL into a sentence, and never write an address you were not given.",
    "- `Rows` is the triage list: one row per issue, ticket, pull request, follow-up or source, with a state chip (`status`, `tone`), a line of facts (`meta`), the detail (`text`) and a link out (`href`). It is what a table becomes when two of a row's cells are paragraphs.",
    "- In `Rows`, `tone` is colour and `status` is the word: always give the status a tone is drawn for, never a colour on its own.",
    "- Use for a pulled quotation or cited excerpt (a line from a document, a person, a spec) that should stand apart from your own prose; not for your own summaries or emphasis.",
    "- text and source are plain strings only: no markdown, no links or URLs as links. Put author, document and section together in source, e.g. \"Jane Doe, Annual Report, section 3\".",
    "- FeatureGrid is peer items as tiles (features, options, principles), each a title and a sentence, and a `tone` only when the tag is a state (a risk, a status), never for decoration; Glossary is terms over prose definitions; neither is a ranking.",
    "- PricingTiers compares plans (`highlight` marks the one you recommend; give only prices and features you were given); Testimonial is a speaker's own words with their name and role; Faq is questions with plain-string answers (an Accordion is for answers that hold components); AvatarGroup is a compact row of names, People is the list with roles.",
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
    "- Stepper shows where a process stands (`current` is the 1-based stage, stages before it draw as done); Kanban groups work cards by state in columns; Agenda is a schedule of `{time, title, text, place}`.",
    "- Calendar draws one month: `year`, `month` (1-12) and marked `{day, label}` entries; use it for dates inside a single month, an Agenda for a day's schedule.",
    "- Checks is the report after something ran or was verified (tests, a build, a lint, a health probe, a requirements list): each item a name, a state of pass, fail, warn, skip or running, and a detail only when it adds something. Plan is work still to do; Checks is what happened. Never mark a check pass that was not run.",
  ],
  dev: [
    "- Diff for a before/after of text, Keys for shortcuts, Code for a snippet.",
    "- Use FileTree to show a project layout or the set of files a change touches; give flat slash-separated paths (e.g. \"src/lib/a.ts\") and the component nests them, so never write folders as separate entries.",
    "- Give only files, one object per file; set change to added/modified/deleted only when the answer is about a change, and keep note to a few words about what the file is or what changed.",
    "- Use Terminal when the answer is a shell session (a command and what it printed); use Code for a plain snippet or log with no command.",
    "- Terminal command is the bare line without a leading \"$ \" (the prompt is drawn for you); output is the verbatim stdout/stderr, never summarised or invented.",
    "- Findings is a review's output, one item per problem: `{title, severity, location, text, fix}` with severity critical, high, medium, low or info, location as `path/to/file.ext:42`, the explanation in `text` and the correction in `fix`. Write them in any order, they draw worst first. Only report what you can point at; no findings is a sentence of prose, not an empty Findings.",
    "- Endpoints lists API routes as `{method, path, text}`.",
    "- Terminal exitCode is the number the command returned (0 = success, shown with a red badge otherwise); cwd is a path label. Omit both rather than guessing. Nothing is executed.",
  ],
  diagrams: [
    "- Flowchart is for branching logic. Give nodes and edges; every edge's `from` and `to` must match node ids.",
    "- Flowchart shapes: `diamond` for a decision (label its outgoing edges, e.g. yes/no), `round` for start and end, `box` for a step. Loops are fine: an edge back to an earlier node is drawn as a return arrow down the side.",
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
    "- Gauge is one reading on a half-dial against a range (`min`/`max`, default 0..100) with the tone you judge it deserves; a Stat takes an optional `delta` that opens with + or - for its direction.",
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
    Grid,
    Row,
    Panel,
    Heading,
    Text,
    Icon,
    Spacer,
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
    FeatureGrid,
    Glossary,
    Kanban,
    Stepper,
    Agenda,
    Gauge,
    Endpoints,
    PricingTiers,
    Testimonial,
    Faq,
    AvatarGroup,
    Calendar,
  ],
  componentGroups: UI_GROUPS.map((group) => ({ name: group.label, components: group.components, notes: GROUP_NOTES[group.id] ?? [] })),
})
