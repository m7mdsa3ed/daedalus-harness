/* ── The openui language's component library ──
   A model that answers in `openui` writes `identifier = Component(...)` lines,
   and this is the table those names resolve against. Three rules decided it:

   — **one surface rule, held in context.** Anything framed goes through `Box`
     (`kit.tsx`), and `Box` asks where it is: on the page it is the registry
     `Card`, inside another frame it is a recessed well (`INSET`). So a Table in
     a Card is never a second bordered card inside the first — the bargain
     `settings/primitives.tsx` makes with its own `INSET` — and no component
     picks its own ground;
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
import { Divider } from "@/lib/openui/components/Divider"
import { Tabs } from "@/lib/openui/components/Tabs"
import { Accordion } from "@/lib/openui/components/Accordion"
import { Grid, Heading, Text } from "@/lib/openui/components/primitives"

import { Markdown } from "@/lib/openui/components/Markdown"
import { Table } from "@/lib/openui/components/Table"
import { List } from "@/lib/openui/components/List"
import { Badges } from "@/lib/openui/components/Badges"
import { Callout } from "@/lib/openui/components/Callout"

import { Code } from "@/lib/openui/components/Code"

import { Flowchart } from "@/lib/openui/components/Flowchart"
import { Sequence } from "@/lib/openui/components/Sequence"

import { Stat } from "@/lib/openui/components/Stat"
import { Chart } from "@/lib/openui/components/Chart"
import { Progress } from "@/lib/openui/components/Progress"

import { Image } from "@/lib/openui/components/Image"

import { Button, Checkbox, DatePicker, Form, FormControl, Input, RadioGroup, Select, SelectItem, Slider, Switch, Textarea } from "@/lib/openui/components/interactive"
import { Rank } from "@/lib/openui/components/Rank"
import { EditableTable } from "@/lib/openui/components/EditableTable"
import { LEGACY_COMPONENTS } from "@/lib/openui/components/legacy"

/** What each group's section tells the model beyond its signatures. The names
    and membership are `groups.ts`'s; a note must only mention components of its
    own group, because a narrowed prompt drops every other section. The library
    is a handful of generic pieces composed, shadcn-style, so the notes are
    mostly recipes: which pieces make a shape. */
const GROUP_NOTES: Record<string, string[]> = {
  layout: [
    "- `root = Stack([...])` is the entry point: every program must define it. Children stack in a column; `Stack([...], \"row\")` is a wrapping line of small things (buttons, badges), and `align` places them.",
    "- Grid(children, columns 1-4) is equal columns that fall to one on a narrow panel; `split` (2:1, 1:2, 3:1, 1:3) is two unequal columns; give small metric tiles `phone` 2. A Card with `span` 2 crosses every column.",
    "- Card is the one frame: a title, an optional subtitle, its children. An empty title (\"\") draws no header. Give it a `tone` for a status tile and a `footer` for a source or timestamp. A Card inside a Card draws as a recessed well, so nest freely.",
    "- A dashboard is a Heading, a Grid of Cards or metrics, then a Grid with `split` \"2:1\" for a wide block beside a narrow one.",
    "- A titled section is `Heading(\"Title\", 2)` followed by `Text(\"...\")`; `Heading` level 1 is the view's subject, 3 a small label over a group.",
    "- A paragraph is `Text(\"...\")` at the body size. `\"small\"` and `\"muted\"` are only for a line that qualifies something else (a caption, a source, a footnote), never for the paragraph a reader is meant to read.",
    "- Every sentence or paragraph of prose is a `Text`, one per paragraph — in a Card, a tab, beside a Heading. Never put a paragraph in a Heading, a Card subtitle or a Callout you only want for its frame.",
    "- Any string a component draws (a Text, a title, a List row, a Table cell, a Callout) takes inline chips: `[[done]]` is a status chip and colours itself from the word (pass, fail, done, running, pending, blocked, yes, no, partial, skip); `[[Beta|info]]` is a tag in a named tone (neutral, info, success, warn, error). `Text(\"Deploy is [[running]], migrations [[pass]], docs [[stale|warn]].\")` puts the states in the sentence instead of a row of Badges.",
    "- Tabs for alternatives the reader picks between (per OS, before/after). Accordion for folds: one item is a single optional detail, several are an FAQ; `open: true` starts an item unfolded.",
    "- Never nest a Stack in a Stack for spacing alone; Divider is a rule between two runs of content.",
  ],
  text: [
    "- `Markdown(text)` is only for a document-shaped passage that needs headings, lists, blockquotes or fenced code — a plain paragraph is a `Text`; its links open only http(s) addresses, and never include a URL you were not given.",
    "- `Callout` is an aside in a tone; with `lead` it is the conclusion: `Callout(\"Safe to merge\", \"success\", \"One sentence of why.\", true)` puts the answer first. Use `lead` at most once, as the first thing in the view. A neutral Callout also says there is nothing to show.",
    "- `Table` is values in columns. Write each row as its own array of strings, in the SAME order as `columns`. `tones: true` chips a cell that opens with a state word (yes, no, partial, n/a, pass, fail, warn, blocked, done, running, skip, pending); `verdicts: true` leads yes/no/partial/n/a cells with a glyph. Never fill a verdict table with free prose.",
    "- `List` is every list of records, one per line: `{text, meta, state, tone, href, code, language}`. A `state` is a short word drawn as a chip in its `tone`; never a tone without a state.",
    "- List recipes: a plan or a run's results is items with a `state` (done/active/pending, pass/fail/warn/skip) and its tone; review findings are items with the severity as `state` (critical/high in error, medium in warn, low in info), the location and the fix in `meta`, worst first; how-to steps are a `numbered` List with each command in `code`; links are items with an `href`; a glossary or key/value is the term in `text`, the definition in `meta`.",
    "- `Badges` is a row of short tags or statuses; with `avatars` the items are people's initials.",
    "- Never mark a result `pass` that was not run, and never write an address you were not given.",
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
    "- `RadioGroup(\"plan\", [SelectItem(\"pro\", \"Pro\"), SelectItem(\"team\", \"Team\")], null, $plan)` shows every option at once; use it over a Select for two to five options the reader should compare. `Switch(\"notify\", \"Email me when it ships\", $notify)` is an on/off setting; Checkbox is for including a thing.",
    "- `Rank(\"priorities\", [\"Speed\", \"Cost\", \"Design\"], $priorities)` is a list the reader reorders, most important first; it reads back as `Speed > Cost > Design`. Use it when the order is the answer.",
    "- `DatePicker(\"when\", \"range\", \"Trip dates\", null, $when)` is a calendar: a day reads back as `YYYY-MM-DD`, a range as `YYYY-MM-DD/YYYY-MM-DD`. Use it for a date the reader picks; a date you already know is text.",
    "- `EditableTable(\"budget\", columns, rows, {Status: [\"open\", \"closed\"]})` is a Table the reader corrects: the same `columns` and `rows`, the first column is each row's name and stays fixed, `options` makes a column a select, and figures and `YYYY-MM-DD` columns edit as numbers and dates. It sends its own changes, one line per cell, so never put it in a Form.",
    "- `@OpenUrl(\"https://...\")` opens a browser tab; use it only for a URL you were given, never one you guessed.",
    "- Draw an interactive view only when the answer is a decision the reader makes before the next message — a range to look at, an item to act on, a command to confirm. Never draw a field whose value nothing reads.",
  ],
  dev: [
    "- `Code(text, language, title)` is every run of characters to copy. A snippet names its language; a before/after is a unified diff with language \"diff\" and the path as `title`; a shell session is language \"bash\" with the command on a `$ ` line and its verbatim output under it, the cwd as `title`. Never summarise or invent output.",
  ],
  diagrams: [
    "- Flowchart is for branching logic. Give nodes and edges; every edge's `from` and `to` must match node ids.",
    "- Flowchart shapes: `diamond` for a decision (label its outgoing edges, e.g. yes/no), `round` for start and end, `box` for a step. Loops are fine: an edge back to an earlier node is drawn as a return arrow down the side.",
    "- A decision tree reads best as cards: give a question node an `icon` (box, flask, users, ...) and a `text` line such as an example, and each outcome an `icon` (check, ban, minus), a `text` sentence, up to three short `items` and a `tone` (success, error, neutral). Label each answer edge (Yes/No) and give it the `tone` of where it leads.",
    "- Flowcharts are locally interactive: readers can move nodes, connect handles, select elements and delete them. Edits are temporary and do not change the generated answer or run tools.",
    "- Keep a flowchart under ~12 nodes. Its layout responds to the available panel width: rightward pipelines automatically become vertical in narrow panels, and wide sibling layers wrap to fit.",
    "- Use Sequence for who-calls-whom over time (request flows, auth handshakes, protocol exchanges); use a Flowchart for branching logic.",
    "- Sequence: list every actor once in actors, in left-to-right order; each message's from and to must match an actor name exactly (a message naming an unlisted actor is dropped). Messages are listed top to bottom in time order.",
    "- Sequence kind defaults to \"call\" (solid arrow from to); \"reply\" is a dashed return arrow; \"note\" is a boxed remark over from (and to, if different). Keep text short, a few words, and keep to about 6 actors or fewer.",
  ],
  numbers: [
    "- Stat is one figure: label, value, hint, a `delta` that opens with + or - for its direction, and `values` for a small trend line. A row of figures is several Stats in one container.",
    "- Chart over shared `labels`; each series' `values` must be the same length as `labels`. line/area for trends, bar for comparisons and rankings (sort them yourself; `stacked` for parts of a total), pie/donut for shares of one whole (few slices), radar for scoring options on several axes, `scatter` for two measures of the same things (each label a point; the first series is x, the second y, and their names title the axes), `heatmap` (labels are rows, each series a column), `funnel` (one series of stage volumes) and `waterfall` (one series of positive and negative changes).",
    "- `Progress` is one reading on a meter; with `dial` it is a half-dial against `min`..`max` (default 0..100) with an optional `unit`. Give it the tone you judge the reading deserves; never invent a threshold.",
  ],
  media: [
    "- Image only with a URL you were actually given; never invent one. Remote images are loaded only when the reader clicks.",
    "- `Image` with `images` is a carousel of several, each with src, alt and optional caption.",
  ],
}

export const openuiLibrary = createLibrary({
  root: "Stack",
  components: [
    Stack,
    Grid,
    Card,
    Divider,
    Tabs,
    Accordion,
    Heading,
    Text,
    Markdown,
    Table,
    List,
    Badges,
    Callout,
    Code,
    Flowchart,
    Sequence,
    Stat,
    Chart,
    Progress,
    Image,
    Button,
    Form,
    FormControl,
    Input,
    Textarea,
    Select,
    SelectItem,
    Checkbox,
    Slider,
    DatePicker,
    EditableTable,
    RadioGroup,
    Switch,
    Rank,
  ],
  componentGroups: UI_GROUPS.map((group) => ({ name: group.label, components: group.components, notes: GROUP_NOTES[group.id] ?? [] })),
})

/** What a fence is drawn with: the table above plus the retired names a stored
    answer still uses (`components/legacy.tsx`). Never used for the prompt — an
    ungrouped component is printed under "### Other" and would be taught again. */
export const openuiRenderLibrary = createLibrary({
  root: "Stack",
  components: [...Object.values(openuiLibrary.components), ...LEGACY_COMPONENTS],
})
