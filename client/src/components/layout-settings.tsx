/* ── Layout settings ──
   Display-only switches (lib/layout-options): they change how the transcript
   reads or how the sidebar lists, never what is in it and never anything the
   agent is told. Each group has a `scope` — `transcript` (Settings › Appearance
   › Transcript) or `sidebar` (› Interface) — and `LayoutSettings` draws one
   scope, with its own search and a Reset that only counts that scope's changes. That is why
   they live here and not in SessionConfigPopover, which respawns the agent
   process to change model/effort/mode. They are global to this device — one
   reading setup for every thread — and persisted, so it takes no
   session — and lives in **Settings › Appearance** and not in a thread's
   composer row or the header. Being global is the argument: the dock can mount
   several chat panels at once, and a device-wide control drawn in each of them
   was one control drawn many times.

   The list is declarative and **grouped**: add an entry to a group's `options`
   and the row appears; non-switch controls can live in the same group's picker.
   Grouping is the whole layout argument: choices that answer different
   questions should not compete in one long list. Seven sections, each answering
   one:

     Layout              — how much of the thread is on screen at once
     Conversation        — what the messages and answers show
     Agent activity      — how the work behind an answer is drawn
     Shell activity      — how reader-run commands are shown
     Sources and labels  — where source and tool markers appear
     Code                — how a diff or a code block is drawn
     Motion              — what moves on its own

   The sidebar adds three of its own (Thread list, Rows, Sections).

   The sections are stacked Groups under one search (no rail, no second tab
   level); a row that differs from its default carries a dot, and the Reset
   above counts all of them and is the one way back. */
import * as React from "react"
import {
  AlignLeft,
  AlignJustify,
  ArrowDownToLine,
  Bot,
  Braces,
  Brain,
  CalendarClock,
  Clock,
  Code,
  Coins,
  Columns2,
  Eye,
  Compass,
  FolderOpen,
  Globe,
  Gauge,
  ListFilter,
  Pin,
  ArrowUpDown,
  UserRound,
  ListTree,
  Maximize2,
  MessageSquareText,
  RotateCcw,
  Rows3,
  SeparatorHorizontal,
  Sparkles,
  Terminal as TerminalIcon,
  WrapText,
  Wrench,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Empty } from "@/components/empty"
import { STREAM_SPEEDS } from "@/lib/stream-pace"
import { Switch } from "@/components/ui/switch"
import { ChoiceTiles, Group, Row, Segmented, Toolbar } from "@/components/settings/primitives"
import { cn } from "@/lib/utils"
import {
  SUBAGENT_PEEKS,
  TOOL_LAYOUTS,
  isSidebarOption,
  resetLayoutOptions,
  setLayoutOption,
  useLayoutOptions,
  LAYOUT_DEFAULTS,
  type SubagentPeek,
  type ToolLayout,
  type ToolVariant,
  TOOL_VARIANTS,
  toolVariantOf,
  type LayoutOptions,
} from "@/lib/layout-options"

/** The switches, and only the switches. Non-boolean preferences render as
    their own picker controls, not as a boolean switch row. */
type BooleanOption = {
  [K in keyof LayoutOptions]: LayoutOptions[K] extends boolean ? K : never
}[keyof LayoutOptions]

type Option = {
  key: BooleanOption
  icon: typeof Clock
  title: string
  description: string
  /** Drawn indented under this switch, which must sit just above it in its
      group. Off, the row is dimmed and inert — its own value is kept, it just
      has nothing to act on. */
  parent?: BooleanOption
}

/** A choice of more than two, drawn as a Segmented under its Row. Plain string
    values (`CHOICES` in the store validates them); labels are short because a
    Segmented is for two to four words on a phone. */
type ChoiceSpec = {
  key: "sidebarSort" | "sidebarFilter" | "sidebarWithin"
  icon: typeof Clock
  title: string
  description: string
  options: { value: string; label: string }[]
}

type Category = {
  id: string
  scope: "transcript" | "sidebar"
  choices?: ChoiceSpec[]
  label: string
  hint: string
  options: Option[]
  /** Non-switch controls that belong to this group's question. */
  pickers?: ("streamSpeed" | "subagentPeek" | "toolLayout")[]
}

const SUBAGENT_PEEK_COPY: Record<SubagentPeek, { label: string; description: string }> = {
  off: { label: "Off", description: "A subagent is one line until you open it." },
  live: { label: "While running", description: "A working subagent shows its latest steps under its line." },
  always: { label: "Always", description: "Every subagent shows its latest steps, finished or not." },
}

const TRANSCRIPT_GROUPS: Omit<Category, "scope">[] = [
  {
    id: "layout",
    label: "Layout",
    hint: "How much of the thread fits on screen.",
    options: [
      {
        key: "wideTranscript",
        icon: Maximize2,
        title: "Wide column",
        description: "Let the transcript run wider than the default reading measure.",
      },
      {
        key: "compactDensity",
        icon: AlignJustify,
        title: "Compact density",
        description: "Tighter line spacing and padding, so more of a long thread fits.",
      },
      {
        key: "stepDividers",
        icon: SeparatorHorizontal,
        title: "Turn dividers",
        description: "A hairline above each of your messages, separating one turn from the next.",
      },
      {
        key: "showTabDetails",
        icon: Rows3,
        title: "Second row on tabs",
        description: "The line under every tab's title: a thread's project and model, a page's section, a shell's directory. Off, tabs are a single, shorter line.",
      },
      {
        key: "tabAgentIcon",
        icon: Bot,
        title: "Agent mark on tabs",
        description:
          "The agent's own mark at the start of a thread's tab, the same one its sidebar row wears, so the strip says which runtime each thread runs on. Off, a tab starts at its title.",
      },
      {
        key: "turnRail",
        icon: Rows3,
        title: "Turn rail",
        description:
          "Tick marks along the composer's edge above Send, one per turn. Hover to preview, click to jump — or press and slide to scrub them.",
      },
    ],
  },
  {
    id: "conversation",
    label: "Conversation",
    hint: "Choose what stays visible around the answers.",
    options: [
      {
        key: "answersOnly",
        icon: MessageSquareText,
        title: "Answers only",
        description:
          "Fold the work into a line you can open: thinking, tool steps, plans and subagents are grouped away, leaving your messages and the agent's replies. Errors stay, and nothing is deleted — open the line and the whole transcript is there.",
      },
      {
        key: "showTokens",
        icon: Coins,
        title: "Show token usage",
        description:
          "What each finished turn cost, under it — and the same figure on every workflow step and subagent. Only what the agent reports: a runtime that does not meter tokens shows none.",
      },
      {
        key: "showTimestamps",
        icon: Clock,
        title: "Show timestamps",
        description:
          "Wall-clock time beside each message and step. Replayed history has no clock, so only what happened while this tab was open is stamped.",
      },
      {
        key: "showConfigNotices",
        icon: Eye,
        title: "Show setting changes",
        description:
          "The rows marking a mode, model, effort, profile or agent change, wherever in the thread it happened. Off, the change still takes effect — only the row is silent.",
      },
      {
        key: "showStatusDetail",
        icon: AlignLeft,
        title: "Status detail",
        description:
          "The sentence under the thread's status line — what a wait, a stop or a failure means. Off, a status is its title alone: its buttons stay, and Copy still takes the whole report.",
      },
    ],
  },
  {
    id: "agent-activity",
    label: "Agent activity",
    hint: "Choose how much of the work behind an answer is shown.",
    pickers: ["subagentPeek", "toolLayout"],
    options: [
      {
        key: "showThinking",
        icon: Brain,
        title: "Show thinking",
        description:
          "Open the agent's reasoning while it streams. It folds away the moment the step finishes — click a row to read a settled one.",
      },
      {
        key: "thoughtOneLine",
        icon: AlignLeft,
        title: "Thinking as one line",
        description:
          "Show a thought as just \"Thinking 12s\" while it streams and \"Thought for 12s\" after, with no excerpt of the reasoning. Click the line to read it.",
      },
      {
        key: "showToolDetails",
        icon: ListTree,
        title: "Expand tool output",
        description: "Open every tool call's input and output by default, not just edits and diffs.",
      },
      {
        key: "showToolCommand",
        icon: TerminalIcon,
        title: "Show the command",
        description:
          "The command, path or pattern a step ran, under the sentence describing it. Off, a row is the description alone — the command is still in the step's own body.",
      },
      {
        key: "showRawToolData",
        icon: Braces,
        title: "Show raw tool data",
        description:
          "The call exactly as the agent sent it — input, output, content and metadata — as JSON at the foot of every tool step.",
      },
      {
        key: "groupTools",
        icon: Wrench,
        title: "Group tool calls and thinking",
        description:
          "Fold consecutive tool calls and the thinking between them into one expandable group.",
      },
      {
        key: "openRunningGroup",
        parent: "groupTools",
        icon: Wrench,
        title: "Keep the running group open",
        description:
          "The group the agent is working in stays expanded until it moves on. Off, it folds like the rest and shows only its last few steps.",
      },
    ],
  },
  {
    id: "shell-activity",
    label: "Shell activity",
    hint: "Control the shell commands you run from the composer.",
    options: [
      {
        key: "showShellCommands",
        icon: TerminalIcon,
        title: "Show `!` commands",
        description:
          "The shell commands you ran in the box and what they printed. Off, the rows are hidden and the thread reads as the conversation alone — nothing is deleted, and they come back when you turn it on.",
      },
      {
        key: "groupShellCommands",
        parent: "showShellCommands",
        icon: Rows3,
        title: "Group `!` commands",
        description:
          "Fold a run of commands you ran back to back into one line you can open, the way tool steps fold. A single command stays its own block.",
      },
    ],
  },
  {
    id: "sources",
    label: "Sources and labels",
    hint: "Choose whether sources appear and where their markers sit.",
    options: [
      {
        key: "showSources",
        icon: Globe,
        title: "Show sources",
        description:
          "Site favicons under a web step, and the pages an answer cited under the finished turn. Their row placement is controlled below.",
      },
      {
        key: "showToolSourcesOnFirstRow",
        parent: "showSources",
        icon: Rows3,
        title: "Show tool sources on first row",
        description:
          "Place grouped-tool icons and web-search favicons beside the title instead of on a second row.",
      },
    ],
  },
  {
    id: "code",
    label: "Code and diffs",
    hint: "How an edit is drawn.",
    options: [
      {
        key: "expandEdits",
        icon: Code,
        title: "Expand edits by default",
        description: "Open file diffs automatically. Turn off to keep edits folded and let them join grouped tool calls.",
      },
      {
        key: "codeWrap",
        icon: WrapText,
        title: "Wrap code",
        description: "Soft-wrap long code blocks and diffs instead of scrolling them sideways.",
      },
      {
        key: "splitDiffs",
        icon: Columns2,
        title: "Split diffs",
        description: "Show file edits side by side (old | new) instead of as a unified list.",
      },
    ],
  },
  {
    id: "motion",
    label: "Motion",
    hint: "What moves without being asked.",
    options: [
      {
        key: "autoScroll",
        icon: ArrowDownToLine,
        title: "Follow the stream",
        description:
          "Keep the newest content in view while the agent is responding. Scroll up to read freely — following resumes when you come back to the bottom.",
      },
      {
        key: "calmMotion",
        icon: Sparkles,
        title: "Calm motion",
        description:
          "Drop the row entrance animation, the shimmer on a running turn and the streaming reveal. Colour still says what is live.",
      },
    ],
    pickers: ["streamSpeed"],
  },
]

const SIDEBAR_GROUPS: Category[] = [
  {
    id: "sidebar-list",
    scope: "sidebar",
    label: "Thread list",
    hint: "What the list shows, and in what order.",
    choices: [
      {
        key: "sidebarSort",
        icon: ArrowUpDown,
        title: "Order",
        description: "Recent activity and newest created are flat lists; by project files every thread under its project's folder.",
        options: [
          { value: "recent", label: "Recent" },
          { value: "created", label: "Created" },
          { value: "title", label: "Title" },
          { value: "project", label: "Project" },
        ],
      },
      {
        key: "sidebarFilter",
        icon: ListFilter,
        title: "Show",
        description: "Narrow the list by what a thread is doing. Unread is a finished turn you have not looked at yet.",
        options: [
          { value: "all", label: "All" },
          { value: "running", label: "Running" },
          { value: "waiting", label: "Needs you" },
          { value: "unread", label: "Unread" },
        ],
      },
      {
        key: "sidebarWithin",
        icon: CalendarClock,
        title: "Active in",
        description: "Hide threads that have not had a turn inside this window.",
        options: [
          { value: "any", label: "Any time" },
          { value: "day", label: "24 hours" },
          { value: "week", label: "7 days" },
          { value: "month", label: "30 days" },
        ],
      },
    ],
    options: [
      {
        key: "sidebarPeriodHeadings",
        icon: Clock,
        title: "Period headings",
        description: "Today, Yesterday, Previous 7 days… between runs of rows. Not drawn when ordered by title.",
      },
      {
        key: "sidebarEmptyProjects",
        icon: FolderOpen,
        title: "Empty projects",
        description: "In the by-project view, keep a folder for a project with no thread yet, so its + is there to start one.",
      },
    ],
  },
  {
    id: "sidebar-rows",
    scope: "sidebar",
    label: "Rows",
    hint: "What each thread row says.",
    options: [
      {
        key: "sidebarCompact",
        icon: Rows3,
        title: "Compact rows",
        description: "Shorter thread rows, so more of a long list fits.",
      },
      {
        key: "sidebarAgentIcon",
        icon: UserRound,
        title: "Agent mark",
        description: "The agent's mark at the start of each row.",
      },
      {
        key: "sidebarShowAge",
        icon: Clock,
        title: "Time since last turn",
        description: "How long ago a thread last spoke, at the row's end.",
      },
      {
        key: "sidebarShowProject",
        icon: FolderOpen,
        title: "Project name",
        description: "Name the project on each row of a flat list. It is always in the row's tooltip.",
      },
    ],
  },
  {
    id: "sidebar-sections",
    scope: "sidebar",
    label: "Sections",
    hint: "What else the sidebar carries.",
    options: [
      {
        key: "sidebarShowPinned",
        icon: Pin,
        title: "Pinned group",
        description: "Pinned threads above the list. Off, a pinned thread is listed like any other.",
      },
      {
        key: "sidebarShowPlaces",
        icon: Compass,
        title: "Tasks and Automations",
        description: "The page rows under New tab. They stay one search away in the command palette.",
      },
    ],
  },
]

const GROUPS: Category[] = [
  ...TRANSCRIPT_GROUPS.map((group) => ({ ...group, scope: "transcript" as const })),
  ...SIDEBAR_GROUPS,
]

const ALL_OPTIONS = GROUPS.flatMap((group) => group.options)

function ToolLayoutPreview({ layout, variant }: { layout: ToolLayout; variant: ToolVariant }) {
  const line = "h-1 rounded-full bg-muted-foreground/35"
  const node = "size-1.5 shrink-0 rounded-full"
  const rows = [["w-3/4"], ["w-1/2"], ["w-2/3"]]
  return (
    <span aria-hidden className="flex h-12 flex-col justify-center gap-1.5 overflow-hidden rounded-md bg-background p-1.5">
      {layout === "rail" ? (
        <span className="flex flex-col gap-1 border-l-2 border-primary/40 pl-1.5">
          <span className={cn(line, "w-3/4")} /><span className={cn(line, "w-1/2")} />
        </span>
      ) : layout === "branch" ? (
        <svg viewBox="0 0 60 36" className="h-full w-full" fill="none" strokeWidth={1.5}>
          {variant === "fork" ? (
            <>
              <path d="M5 0V36" className="stroke-primary/70" />
              <path d="M5 4V6Q5 10 9 10H12M5 22V24Q5 28 9 28H12" className="stroke-primary/70" />
              <circle cx="14" cy="10" r="2.5" className="fill-primary stroke-none" />
              <circle cx="14" cy="28" r="2.5" className="fill-primary stroke-none" />
              <path d="M20 10H44M20 28H36" className="stroke-muted-foreground/35" />
            </>
          ) : (
            <>
              <path d="M5 2V34" className="stroke-primary/70" />
              <path d="M5 14C5 18 13 16 13 22V34" className="stroke-success/70" />
              <path d="M13 26C13 30 5 28 5 34" className="stroke-success/70" />
              <circle cx="5" cy="6" r="2.5" className="fill-primary stroke-none" />
              <circle cx="13" cy="22" r="2.5" className={variant === "hollow" ? "fill-background stroke-success" : "fill-success stroke-none"} />
              <circle cx="5" cy="32" r="2.5" className="fill-primary stroke-none" />
              <path d="M22 6H44M22 22H36M22 32H40" className="stroke-muted-foreground/35" />
            </>
          )}
        </svg>
      ) : (
        <span className={cn("flex flex-col border-l pl-1.5", variant === "default" ? "gap-1" : variant === "compact" ? "gap-0.5" : "gap-1")}>
          {rows.slice(0, variant === "default" ? 2 : 3).map(([w], i) => (
            <span key={i} className="flex items-center gap-1">
              {variant !== "minimal" && <span className={cn(node, "bg-primary/60")} />}
              <span className={cn(line, w)} />
            </span>
          ))}
        </span>
      )}
    </span>
  )
}

const TOOL_LAYOUT_COPY: Record<ToolLayout, { label: string; description: string }> = {
  timeline: { label: "Timeline", description: "Flowing steps" },
  rail: { label: "Accent rail", description: "Indented sequence" },
  branch: { label: "Branch", description: "Git graph, parallel calls fork" },
}

const TOOL_VARIANT_COPY: Record<ToolVariant, string> = {
  default: "Default",
  compact: "Compact",
  minimal: "Minimal",
  commits: "Commits",
  fork: "Fork (connected)",
  hollow: "Hollow",
}

/** A row reaches to the card's edges so its hover ground does too — the
    card's rows sit in `px-3 @panel-sm:px-4`. */
const BLEED = "-mx-3 px-3 @panel-sm:-mx-4 @panel-sm:px-4"

/** The mark, tinted while the option is on (a column of marks says what is on
    before a switch is read), and the title with a dot when it is not the
    default — the one thing you cannot read off a switch is whether it is the
    switch *you* moved. */
function rowHead(icon: typeof Clock, title: string, on: boolean, changed: boolean) {
  const Icon = icon
  return {
    icon: <Icon className={cn("size-4", on ? "text-primary" : "text-muted-foreground")} />,
    title: (
      <span className="inline-flex items-center gap-1.5">
        {title}
        {changed && <span aria-label="changed from the default" className="size-1.5 shrink-0 rounded-full bg-primary" />}
      </span>
    ),
  }
}

function OptionRow({
  option,
  value,
  changed,
  disabled,
}: {
  option: Option
  value: boolean
  changed: boolean
  disabled: boolean
}) {
  const { icon, key, title, description, parent } = option
  return (
    /* The whole row is the target — a switch is a small thing to hit on a
       phone. Not a <label>: the Switch is a button, which is not labelable, so
       the association would be decorative and the pointer cursor a lie. */
    <div
      role="presentation"
      onClick={disabled ? undefined : () => setLayoutOption(key, !value)}
      className={cn(BLEED, "transition-colors", disabled ? "opacity-50" : "cursor-pointer hover:bg-muted")}
    >
      <div className={cn(parent && "ml-4 border-l pl-3")}>
        <Row {...rowHead(icon, title, value && !disabled, changed)} subtitle={description}>
          {/* Stopped, or the row's own handler would toggle it straight back. */}
          <span onClick={(event) => event.stopPropagation()}>
            <Switch
              checked={value}
              disabled={disabled}
              onCheckedChange={(checked) => setLayoutOption(key, checked)}
              aria-label={title}
            />
          </span>
        </Row>
      </div>
    </div>
  )
}

/** A choice of more than two: a Row's head over a full-width control. Full
    width because three short words fit a phone, where a select beside two
    lines of text squeezed both. The control labels itself (`Segmented`,
    `ChoiceTiles`); tiles bring their own vertical padding. */
function PickerRow({
  head,
  tiles,
  children,
}: {
  head: { icon: typeof Clock; title: string; description: string; changed: boolean }
  tiles?: boolean
  children: React.ReactNode
}) {
  return (
    <div>
      <Row {...rowHead(head.icon, head.title, false, head.changed)} subtitle={head.description} />
      <div className={tiles ? "-mt-4" : "-mt-1 pb-3"}>{children}</div>
    </div>
  )
}

/**
 * How every thread is drawn, or how the sidebar lists, on this device —
 * Settings › Appearance › Transcript / Interface (`scope`).
 *
 * It was a dialog opened from the app header; it is a part of the page now,
 * and ⌥V and the palette's row go to that page. Every category of the scope in
 * `GROUPS` is a Group, stacked. Search filters the rows within them and hides a Group
 * with nothing left.
 */
export function LayoutSettings({ scope = "transcript" }: { scope?: "transcript" | "sidebar" }) {
  const options = useLayoutOptions()
  const [search, setSearch] = React.useState("")
  const normalizedSearch = search.trim().toLowerCase()
  const matches = (...values: string[]) =>
    !normalizedSearch || values.some((value) => value.toLowerCase().includes(normalizedSearch))
  const matchesPicker = (picker: NonNullable<Category["pickers"]>[number]) => {
    if (picker === "streamSpeed") {
      return matches("streaming speed", ...STREAM_SPEEDS.flatMap((speed) => [speed.label, speed.description]))
    }
    if (picker === "subagentPeek") {
      return matches("subagent activity", ...SUBAGENT_PEEKS.flatMap((peek) => [SUBAGENT_PEEK_COPY[peek].label, SUBAGENT_PEEK_COPY[peek].description]))
    }
    return matches(
      "tool call layout",
      ...TOOL_LAYOUTS.flatMap((layout) => [layout, TOOL_LAYOUT_COPY[layout].label, TOOL_LAYOUT_COPY[layout].description])
    )
  }
  const visibleGroups = GROUPS.filter((group) => group.scope === scope).flatMap((group) => {
    const headerMatches = matches(group.label, group.hint)
    const visibleOptions = headerMatches
      ? group.options
      : group.options.filter((option) => matches(option.title, option.description))
    const visiblePickers = headerMatches
      ? group.pickers ?? []
      : (group.pickers ?? []).filter(matchesPicker)
    const visibleChoices = headerMatches
      ? group.choices ?? []
      : (group.choices ?? []).filter((choice) =>
          matches(choice.title, choice.description, ...choice.options.map((option) => option.label))
        )
    return visibleOptions.length || visiblePickers.length || visibleChoices.length
      ? [{ ...group, visibleOptions, visiblePickers, visibleChoices }]
      : []
  })
  /* Every key the page can move, not just the switches: the count on Reset is
     about the whole surface, and a picker changed from the default is exactly
     as much a change as a switch is. */
  const changedKeys = React.useMemo(
    () =>
      new Set(
        ([
          ...ALL_OPTIONS.map((o) => o.key),
          "subagentPeek",
          "toolLayout",
          "toolVariant",
          "streamSpeed",
          "sidebarSort",
          "sidebarFilter",
          "sidebarWithin",
        ] as (keyof LayoutOptions)[]).filter(
          (key) => isSidebarOption(key) === (scope === "sidebar") && options[key] !== LAYOUT_DEFAULTS[key]
        )
      ),
    [options, scope]
  )
  const speed = STREAM_SPEEDS.find((entry) => entry.id === options.streamSpeed)

  const rows = (entry: (typeof visibleGroups)[number]) => (
    <React.Fragment>
      {entry.visibleChoices.map((choice) => (
        <PickerRow
          key={choice.key}
          head={{
            icon: choice.icon,
            title: choice.title,
            description: choice.description,
            changed: changedKeys.has(choice.key),
          }}
        >
          <Segmented
            label={choice.title}
            options={choice.options}
            value={options[choice.key]}
            onChange={(value) => setLayoutOption(choice.key, value as never)}
          />
        </PickerRow>
      ))}
      {entry.visibleOptions.map((option) => (
        <OptionRow
          key={option.key}
          option={option}
          value={options[option.key]}
          changed={changedKeys.has(option.key)}
          disabled={!!option.parent && !options[option.parent]}
        />
      ))}
      {entry.visiblePickers.includes("subagentPeek") && (
        <PickerRow
          head={{
            icon: Bot,
            title: "Subagent activity",
            description: SUBAGENT_PEEK_COPY[options.subagentPeek].description,
            changed: changedKeys.has("subagentPeek"),
          }}
        >
          <Segmented
            label="Subagent activity"
            options={SUBAGENT_PEEKS.map((peek) => ({ value: peek, label: SUBAGENT_PEEK_COPY[peek].label }))}
            value={options.subagentPeek}
            onChange={(peek) => setLayoutOption("subagentPeek", peek)}
          />
        </PickerRow>
      )}
      {entry.visiblePickers.includes("toolLayout") && (
        <PickerRow
          tiles
          head={{
            icon: Wrench,
            title: "Tool call layout",
            description: "Pick the visual style for tool steps.",
            changed: changedKeys.has("toolLayout"),
          }}
        >
          <ChoiceTiles
            label="Tool call layout"
            value={options.toolLayout}
            onChange={(layout) => setLayoutOption("toolLayout", layout)}
            choices={TOOL_LAYOUTS.map((layout) => ({
              value: layout,
              label: TOOL_LAYOUT_COPY[layout].label,
              hint: TOOL_LAYOUT_COPY[layout].description,
              preview: <ToolLayoutPreview layout={layout} variant={toolVariantOf(layout, options.toolVariant)} />,
            }))}
          />
        </PickerRow>
      )}
      {entry.visiblePickers.includes("toolLayout") && TOOL_VARIANTS[options.toolLayout].length > 1 && (
        <PickerRow
          head={{
            icon: Wrench,
            title: "Layout variant",
            description: `Ways to draw the ${TOOL_LAYOUT_COPY[options.toolLayout].label.toLowerCase()} layout.`,
            changed: changedKeys.has("toolVariant"),
          }}
        >
          <Segmented
            label="Layout variant"
            options={TOOL_VARIANTS[options.toolLayout].map((variant) => ({ value: variant, label: TOOL_VARIANT_COPY[variant] }))}
            value={toolVariantOf(options.toolLayout, options.toolVariant)}
            onChange={(variant) => setLayoutOption("toolVariant", variant)}
          />
        </PickerRow>
      )}
      {entry.visiblePickers.includes("streamSpeed") && (
        <PickerRow
          head={{
            icon: Gauge,
            title: "Streaming speed",
            description: speed?.description ?? "How fast a live answer is written out.",
            changed: changedKeys.has("streamSpeed"),
          }}
        >
          <Segmented
            label="Streaming speed"
            options={STREAM_SPEEDS.map((entry) => ({ value: entry.id, label: entry.label }))}
            value={options.streamSpeed}
            onChange={(id) => setLayoutOption("streamSpeed", id)}
          />
        </PickerRow>
      )}
    </React.Fragment>
  )

  const NOTE = "Display only — nothing here changes what the agent sees."
  return (
    <div className="min-w-0">
      <Toolbar search={search} onSearch={setSearch} placeholder={`Search ${scope} options…`}>
        <Button
          variant="outline"
          size="sm"
          className="pointer-coarse:h-11"
          disabled={changedKeys.size === 0}
          onClick={() => resetLayoutOptions(scope)}
        >
          <RotateCcw data-icon="inline-start" />
          {changedKeys.size === 0
            ? "All at defaults"
            : `Reset ${changedKeys.size} change${changedKeys.size === 1 ? "" : "s"}`}
        </Button>
      </Toolbar>
      {visibleGroups.length === 0 ? (
        <Empty size="lg">No {scope} options match “{search.trim()}”.</Empty>
      ) : (
        visibleGroups.map((entry) => (
          <Group key={entry.id} label={entry.label} hint={`${entry.hint} ${NOTE}`}>
            {rows(entry)}
          </Group>
        ))
      )}
    </div>
  )
}
