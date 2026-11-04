/* ── Layout settings ──
   Display-only switches (lib/layout-options): they change how the transcript
   reads or how the sidebar lists, never what is in it and never anything the
   agent is told. Each group has a `scope` — `transcript` (Settings › Appearance
   › Transcript) or `sidebar` (› Interface) — and `LayoutSettings` draws one
   scope, with its own search and a Reset that only counts that scope's changes.
   That is why they live here and not in SessionConfigPopover, which respawns
   the agent process to change model/effort/mode. They are global to this
   device — one reading setup for every thread — and persisted, so it takes no
   session — and lives in **Settings › Appearance** and not in a thread's
   composer row or the header. Being global is the argument: the dock can mount
   several chat panels at once, and a device-wide control drawn in each of them
   was one control drawn many times.

   The list is declarative and **a tree**: a group is an ordered list of items,
   a switch or a choice alike, and an item's `children` draw indented under it.
   Under a switch the children are dimmed and inert while it is off — they
   modify what it does, so they have nothing to act on; under a choice they
   simply follow it, and `when` hides one that has nothing to say (a variant
   picker for a layout with one variant). Switches and pickers used to be two
   lists drawn one after the other, which is why a layout's variant trailed a
   group of switches it had nothing to do with. Grouping is the whole layout
   argument: choices that answer different questions should not compete in
   one long list. Nine sections, each answering one:

     Layout          — how much of the thread is on screen at once
     History         — how much of a long thread is loaded at a time
     Messages        — what stands beside the answers
     Thinking        — how the agent's reasoning is drawn
     Tool steps      — what a step row shows, and how it is laid out
     Grouping        — how runs of steps, parallel calls and subagents fold
     Shell commands  — the `!` lines you ran
     Code and diffs  — how an edit is drawn
     Motion          — what moves on its own

   The Interface tab draws five: Tabs (the dock's), Thread list, Rows, Sub threads, Sections.

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
  Layers,
  Code,
  Coins,
  Columns2,
  Eye,
  EyeOff,
  Compass,
  FolderOpen,
  Globe,
  Gauge,
  History,
  ListFilter,
  Pin,
  ArrowUpDown,
  UserRound,
  ListTree,
  Maximize2,
  Minimize2,
  Palette,
  MessageSquareText,
  RotateCcw,
  Rows3,
  SeparatorHorizontal,
  Sparkles,
  Terminal as TerminalIcon,
  UnfoldVertical,
  WrapText,
  Wrench,
  type LucideIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Empty } from "@/components/empty"
import { STREAM_SPEEDS } from "@/lib/stream-pace"
import { BATCH_BURSTS, GAP_MINS } from "@/lib/tool-batches"
import { Switch } from "@/components/ui/switch"
import { ChoiceTiles, Group, Row, Segmented, Toolbar } from "@/components/settings/primitives"
import { cn } from "@/lib/utils"
import {
  EARLIER_PAGES,
  HISTORY_WINDOWS,
  GROUP_STYLES,
  SUBAGENT_PEEKS,
  TOOL_LAYOUTS,
  resetLayoutOptions,
  setLayoutOption,
  useLayoutOptions,
  LAYOUT_DEFAULTS,
  type GroupStyle,
  type SubagentPeek,
  type ToolLayout,
  type ToolVariant,
  TOOL_VARIANTS,
  toolVariantOf,
  type LayoutOptions,
} from "@/lib/layout-options"

type BooleanOption = {
  [K in keyof LayoutOptions]: LayoutOptions[K] extends boolean ? K : never
}[keyof LayoutOptions]

/** Every non-switch key but the sidebar's arrangement, which Appearance ›
    Interface draws itself as the page's first tiles. */
type ChoiceOption = Exclude<keyof LayoutOptions, BooleanOption | "sidebarVariant">

type Choice = {
  value: string
  label: string
  /** Tiles only: a line under the label, and a drawing above it. */
  hint?: string
  preview?: (options: LayoutOptions) => React.ReactNode
}

type SwitchItem = {
  key: BooleanOption
  icon: LucideIcon
  title: string
  description: string
  /** Drawn indented under this switch; dimmed and inert while it is off. */
  children?: Item[]
}

/** A choice of more than two: a Segmented, or `tiles` for one you must see.
    Plain string values (the store validates them); labels are short because a
    Segmented is for two to four words on a phone. The copy and the options may
    read the current picks — the chosen option's own line is the row's
    description, and a variant list is the chosen layout's. */
type ChoiceItem = {
  key: ChoiceOption
  icon: LucideIcon
  title: string
  description: string | ((options: LayoutOptions) => string)
  options: Choice[] | ((options: LayoutOptions) => Choice[])
  tiles?: boolean
  /** The pick to draw when it is not the stored value as it stands. */
  value?: (options: LayoutOptions) => string
  /** Drawn only while this holds. */
  when?: (options: LayoutOptions) => boolean
  children?: Item[]
}

type Item = SwitchItem | ChoiceItem

/** The default is what says which shape a key is — the same test the store's
    `pick` makes, so the page and the store cannot disagree about a switch. */
const isSwitch = (item: Item): item is SwitchItem => typeof LAYOUT_DEFAULTS[item.key] === "boolean"

type Category = {
  id: string
  scope: "transcript" | "interface"
  label: string
  hint: string
  items: Item[]
}

const SUBAGENT_PEEK_COPY: Record<SubagentPeek, { label: string; description: string }> = {
  off: { label: "Off", description: "A subagent is one line until you open it." },
  live: { label: "While running", description: "A working subagent shows its latest steps under its line." },
  always: { label: "Always", description: "Every subagent shows its latest steps, finished or not." },
}

const TOOL_LAYOUT_COPY: Record<ToolLayout, { label: string; description: string }> = {
  timeline: { label: "Timeline", description: "Flowing steps" },
  rail: { label: "Accent rail", description: "Indented sequence" },
  branch: { label: "Branch", description: "Git graph, parallel calls fork" },
}

const GROUP_STYLE_COPY: Record<GroupStyle, { label: string; hint: string }> = {
  wash: { label: "Wash", hint: "A marked stretch" },
  card: { label: "Card", hint: "A boxed set" },
  columns: { label: "Columns", hint: "Side by side" },
  bracket: { label: "Bracket", hint: "A rule down the side" },
  ledger: { label: "Ledger", hint: "Ruled lines, no tint" },
  tiles: { label: "Tiles", hint: "A card per call" },
}

const TOOL_VARIANT_COPY: Record<ToolVariant, string> = {
  default: "Default",
  compact: "Compact",
  minimal: "Minimal",
  commits: "Commits",
  fork: "Fork (connected)",
  hollow: "Hollow",
}

const TRANSCRIPT_GROUPS: Omit<Category, "scope">[] = [
  {
    id: "layout",
    label: "Layout",
    hint: "How much of the thread fits on screen.",
    items: [
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
        key: "miniComposer",
        icon: Minimize2,
        title: "Mini composer",
        description:
          "After the first message, fold the box to a single line — the editor, a toggle and Send — and bring the scope row, the add menu and the pickers back from the toggle, which folds again when you scroll away from the tail. Off, a started thread keeps the full box. A draft and the landing console are never folded.",
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
    id: "history",
    label: "History",
    hint: "How much of a long thread is loaded at a time.",
    items: [
      {
        key: "historyWindow",
        icon: History,
        title: "Open with",
        description: (options) =>
          options.historyWindow === "all"
            ? "The whole thread is read when it opens. A long archive takes as long as it takes — nothing stays behind a button."
            : `The newest ${options.historyWindow} turns arrive when a thread opens, and anything older waits behind "Load earlier steps". A thread shorter than that arrives whole. Takes effect the next time a thread opens.`,
        options: HISTORY_WINDOWS.map((value) => ({ value, label: value === "all" ? "All" : value })),
      },
      {
        key: "earlierPage",
        icon: Layers,
        title: "Load earlier steps",
        description: (options) =>
          `${options.earlierPage} turns come back per click. Smaller pages land sooner; larger ones need fewer clicks, and cost more to fold in.`,
        options: EARLIER_PAGES.map((value) => ({ value, label: value })),
      },
    ],
  },
  {
    id: "messages",
    label: "Messages",
    hint: "What stands beside the answers.",
    items: [
      {
        key: "answersOnly",
        icon: MessageSquareText,
        title: "Answers only",
        description:
          "Fold the work into a line you can open: thinking, tool steps, plans and subagents are grouped away, leaving your messages and the agent's replies. Errors stay, and nothing is deleted — open the line and the whole transcript is there.",
      },
      {
        key: "showTimestamps",
        icon: Clock,
        title: "Timestamps",
        description:
          "Wall-clock time beside each message and step. Replayed history has no clock, so only what happened while this tab was open is stamped.",
      },
      {
        key: "showTokens",
        icon: Coins,
        title: "Token usage",
        description:
          "What each finished turn cost, under it — and the same figure on every workflow step and subagent. Only what the agent reports: a runtime that does not meter tokens shows none.",
      },
      {
        key: "showConfigNotices",
        icon: Eye,
        title: "Setting changes",
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
    id: "thinking",
    label: "Thinking",
    hint: "How the agent's reasoning is drawn.",
    items: [
      {
        key: "thoughtStep",
        icon: Brain,
        title: "Thinking as a step",
        description:
          "Draw a thought the way a tool call is drawn — its own mark, the clock as the title, the reasoning one click behind it. Off, thinking keeps its block: the duration over three lines of excerpt.",
      },
      {
        key: "showThinking",
        icon: Eye,
        title: "Open while streaming",
        description:
          "Show the reasoning as it is written. It folds away the moment the step finishes — click a row to read a settled one.",
      },
      {
        key: "thoughtFullHeight",
        icon: UnfoldVertical,
        title: "Full height thinking",
        description:
          "Let an open thought run as tall as it is, with the transcript scrolling instead of the box. Off, the reading stops at a fraction of the panel and scrolls inside itself, so the steps after it stay in reach.",
      },
    ],
  },
  {
    id: "tool-steps",
    label: "Tool steps",
    hint: "What a step row shows, and how the steps are laid out.",
    items: [
      {
        key: "toolLayout",
        icon: Wrench,
        title: "Tool call layout",
        description: "Pick the visual style for tool steps.",
        tiles: true,
        options: (options) =>
          TOOL_LAYOUTS.map((layout) => ({
            value: layout,
            label: TOOL_LAYOUT_COPY[layout].label,
            hint: TOOL_LAYOUT_COPY[layout].description,
            preview: () => <ToolLayoutPreview layout={layout} variant={toolVariantOf(layout, options.toolVariant)} />,
          })),
        children: [
          {
            key: "toolVariant",
            icon: Wrench,
            title: "Variant",
            description: (options) => `Ways to draw the ${TOOL_LAYOUT_COPY[options.toolLayout].label.toLowerCase()} layout.`,
            when: (options) => TOOL_VARIANTS[options.toolLayout].length > 1,
            value: (options) => toolVariantOf(options.toolLayout, options.toolVariant),
            options: (options) =>
              TOOL_VARIANTS[options.toolLayout].map((variant) => ({ value: variant, label: TOOL_VARIANT_COPY[variant] })),
          },
        ],
      },
      {
        key: "showToolCommand",
        icon: TerminalIcon,
        title: "Show the command",
        description:
          "The command, path or pattern a step ran, under the sentence describing it. Off, a row is the description alone — the command is still in the step's own body.",
      },
      {
        key: "showToolDetails",
        icon: ListTree,
        title: "Expand tool output",
        description: "Open every tool call's input and output by default, not just edits and diffs.",
      },
      {
        key: "showRawToolData",
        icon: Braces,
        title: "Raw tool data",
        description:
          "The call exactly as the agent sent it — input, output, content and metadata — as JSON at the foot of every tool step.",
      },
      {
        key: "showSources",
        icon: Globe,
        title: "Sources",
        description: "Site favicons under a web step, and the pages an answer cited under the finished turn.",
        children: [
          {
            key: "showToolSourcesOnFirstRow",
            icon: Rows3,
            title: "On the first row",
            description: "Place grouped-tool icons and web-search favicons beside the title instead of on a second row.",
          },
        ],
      },
    ],
  },
  {
    id: "grouping",
    label: "Grouping",
    hint: "How runs of steps, parallel calls and subagents fold.",
    items: [
      {
        key: "groupTools",
        icon: Wrench,
        title: "Group the agent's steps",
        description:
          "Fold consecutive tool calls into one expandable group, so a run of calls reads as one line you can open. Prose and thinking end a group: a row that says something, or reasons something out, stands where it arrived.",
        children: [
          {
            key: "openRunningGroup",
            icon: Wrench,
            title: "Keep the running group open",
            description:
              "The group the agent is working in stays expanded until it moves on. Off, it folds like the rest and shows only its last few steps.",
          },
          {
            key: "parallelGroups",
            icon: Layers,
            title: "Group parallel calls",
            description:
              "The calls the agent made in one response, run side by side, fold into a marked group of their own inside the run — mixed kinds grouped by kind inside it. Off, they are plain steps of the run and nothing marks them.",
            children: [
              {
                key: "groupStyle",
                icon: Columns2,
                title: "Style",
                description: (options) => GROUP_STYLE_COPY[options.groupStyle].hint + ".",
                tiles: true,
                options: () =>
                  GROUP_STYLES.map((style) => ({
                    value: style,
                    label: GROUP_STYLE_COPY[style].label,
                    hint: GROUP_STYLE_COPY[style].hint,
                    preview: () => <GroupStylePreview style={style} />,
                  })),
              },
            ],
          },
        ],
      },
      {
        key: "subagentPeek",
        icon: Bot,
        title: "Subagent activity",
        description: (options) => SUBAGENT_PEEK_COPY[options.subagentPeek].description,
        options: SUBAGENT_PEEKS.map((peek) => ({ value: peek, label: SUBAGENT_PEEK_COPY[peek].label })),
      },
      {
        key: "batchBurst",
        icon: Rows3,
        title: "Parallel call window",
        description:
          "Calls from an agent that does not name the request they came from count as parallel when they start this close together. Our own agent names it, so this never applies to it.",
        options: BATCH_BURSTS.map((entry) => ({ value: entry.id, label: entry.label })),
      },
      {
        key: "gapMin",
        icon: Clock,
        title: "Show waits between steps",
        description: (options) =>
          `How long the agent sat between one step settling and the next starting — mostly the model answering. ${
            (GAP_MINS.find((entry) => entry.id === options.gapMin) ?? GAP_MINS[0]).description
          }`,
        options: GAP_MINS.map((entry) => ({ value: entry.id, label: entry.label })),
      },
    ],
  },
  {
    id: "shell",
    label: "Shell commands",
    hint: "The `!` lines you run from the composer.",
    items: [
      {
        key: "showShellCommands",
        icon: TerminalIcon,
        title: "Show `!` commands",
        description:
          "The shell commands you ran in the box and what they printed. Off, the rows are hidden and the thread reads as the conversation alone — nothing is deleted, and they come back when you turn it on.",
        children: [
          {
            key: "groupShellCommands",
            icon: Rows3,
            title: "Group `!` commands",
            description:
              "Fold a run of commands you ran back to back into one line you can open, the way tool steps fold. A single command stays its own block.",
          },
          {
            key: "expandShellCommands",
            icon: ListTree,
            title: "Expand `!` command output",
            description:
              "Open every command's output by default. Off, a command folds to its line like a tool step and a click opens it.",
          },
        ],
      },
    ],
  },
  {
    id: "code",
    label: "Code and diffs",
    hint: "How an edit is drawn.",
    items: [
      {
        key: "expandEdits",
        icon: Code,
        title: "Expand edits by default",
        description: "Open file diffs automatically. Turn off to keep edits folded and let them join grouped tool calls.",
      },
      {
        key: "splitDiffs",
        icon: Columns2,
        title: "Split diffs",
        description: "Show file edits side by side (old | new) instead of as a unified list.",
      },
      {
        key: "codeWrap",
        icon: WrapText,
        title: "Wrap code",
        description: "Soft-wrap long code blocks and diffs instead of scrolling them sideways.",
      },
    ],
  },
  {
    id: "motion",
    label: "Motion",
    hint: "What moves without being asked.",
    items: [
      {
        key: "autoScroll",
        icon: ArrowDownToLine,
        title: "Follow the stream",
        description:
          "Keep the newest content in view while the agent is responding. Scroll up to read freely — following resumes when you come back to the bottom.",
      },
      {
        key: "streamSpeed",
        icon: Gauge,
        title: "Streaming speed",
        description: (options) =>
          STREAM_SPEEDS.find((entry) => entry.id === options.streamSpeed)?.description ??
          "How fast a live answer is written out.",
        options: STREAM_SPEEDS.map((entry) => ({ value: entry.id, label: entry.label })),
      },
      {
        key: "calmMotion",
        icon: Sparkles,
        title: "Calm motion",
        description:
          "Drop the row entrance animation, the shimmer on a running turn and the streaming reveal. Colour still says what is live.",
      },
      {
        key: "steerRingGradient",
        icon: Palette,
        title: "Gradient steering ring",
        description:
          "The ring that travels around a steering message while it waits to reach the agent, in the chart colours instead of the primary one. Queued messages keep the plain ring.",
      },
    ],
  },
]

const INTERFACE_GROUPS: Category[] = [
  {
    id: "tabs",
    scope: "interface",
    label: "Tabs",
    hint: "Show workspace tabs or navigate from the sidebar.",
    items: [
      {
        key: "hideWorkspaceTabs",
        icon: Rows3,
        title: "Hide tab strips",
        description:
          "Hide the workspace tab bars and use the sidebar to navigate. Open panels remain in your saved layout; turn this off to restore the tabs. Tabs inside thread panels are unchanged.",
      },
      {
        key: "showTabDetails",
        icon: Rows3,
        title: "Second row on tabs",
        description:
          "The line under every tab's title: a thread's project and model, a page's section, a shell's directory. Off, tabs are a single, shorter line.",
      },
      {
        key: "tabAgentIcon",
        icon: Bot,
        title: "Marks on tabs",
        description:
          "Each tab's own mark at its start: a thread's agent (the same one its sidebar row wears), a page's section, a terminal's kind. Off, a tab starts at its title.",
      },
    ],
  },
  {
    id: "sidebar-list",
    scope: "interface",
    label: "Thread list",
    hint: "What the list shows, and in what order.",
    items: [
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
        children: [
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
        key: "sidebarFilter",
        icon: ListFilter,
        title: "Show",
        description: "Filter the list by status or Trash. Unread is a finished turn you have not looked at yet.",
        options: [
          { value: "all", label: "All" },
          { value: "running", label: "Running" },
          { value: "waiting", label: "Needs you" },
          { value: "unread", label: "Unread" },
          { value: "trash", label: "Trash" },
        ],
        children: [
          {
            /* A switch, not a sixth position: hiding is something the list
               stops doing, and reading what it hid used to cost you the list
               itself. On, the hidden threads come back as a group of their
               own under the list, each still carrying its own Unhide. */
            key: "sidebarShowHidden",
            icon: EyeOff,
            title: "Hidden threads",
            description:
              "A Hidden group under the list holding the threads you hid. Off, they are out of every list, as hiding means.",
          },
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
  },
  {
    id: "sidebar-rows",
    scope: "interface",
    label: "Rows",
    hint: "What each thread row says.",
    items: [
      {
        key: "sidebarCompact",
        icon: Rows3,
        title: "Compact rows",
        description: "Shorter thread and settings-navigation rows, and tighter sub thread rails, so more of a long list fits.",
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
    id: "sidebar-subs",
    scope: "interface",
    label: "Sub threads",
    hint: "The asks and workflow steps listed under the thread that started them. They follow Compact rows.",
    items: [
      {
        key: "sidebarSubThreads",
        icon: ListTree,
        title: "Show",
        description:
          "All lists every sub thread. Active only keeps the ones running, waiting on you or failed, and the one open; Hidden lists none.",
        options: [
          { value: "all", label: "All" },
          { value: "active", label: "Active" },
          { value: "off", label: "Hidden" },
        ],
        children: [
          {
            key: "sidebarSubAgentIcon",
            icon: UserRound,
            title: "Agent mark",
            description: "The agent's mark at the start of a sub thread's row.",
          },
          {
            key: "sidebarSubAge",
            icon: Clock,
            title: "Time since last turn",
            description: "How long ago a sub thread last spoke, at its row's end.",
          },
        ],
      },
    ],
  },
  {
    id: "sidebar-sections",
    scope: "interface",
    label: "Sections",
    hint: "What else the sidebar carries.",
    items: [
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
  ...INTERFACE_GROUPS,
]

const describe = (item: Item, options: LayoutOptions): string =>
  typeof item.description === "function" ? item.description(options) : item.description

const choicesOf = (item: ChoiceItem, options: LayoutOptions): Choice[] =>
  typeof item.options === "function" ? item.options(options) : item.options

/** Every key under these items, children included — what Reset counts. */
function keysOf(items: Item[]): (keyof LayoutOptions)[] {
  return items.flatMap((item) => [item.key, ...keysOf(item.children ?? [])])
}

/** The items a search leaves: one that matches keeps all its children (they
    are its context); one that does not keeps only the children that do, and
    is kept for them — a child's row makes no sense without its parent's. */
function filterItems(items: Item[], options: LayoutOptions, matches: (...values: string[]) => boolean): Item[] {
  return items.flatMap((item) => {
    const labels = isSwitch(item) ? [] : choicesOf(item, options).map((choice) => choice.label)
    if (matches(item.title, describe(item, options), ...labels)) return [item]
    const children = filterItems(item.children ?? [], options, matches)
    return children.length ? [{ ...item, children }] : []
  })
}

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

/** What a style does to a group of calls, drawn in the same 12-high tile as the
    tool layouts so the two pickers read alike. Not a diagram of the chrome at
    full size — the question it answers is *how are these three calls arranged*,
    which is the one thing the three styles disagree about. */
function GroupStylePreview({ style }: { style: GroupStyle }) {
  const call = "h-1 rounded-full bg-muted-foreground/45"
  const head = "h-1 w-2/3 rounded-full bg-muted-foreground/25"
  const box: Record<GroupStyle, string> = {
    wash: "bg-primary/[0.06] p-1 ring-1 ring-foreground/10",
    columns: "bg-primary/[0.06] p-1 ring-1 ring-foreground/10",
    card: "border bg-muted/50 p-1",
    bracket: "relative p-1 pl-2 before:absolute before:inset-y-1 before:left-0.5 before:w-0.5 before:rounded-full before:bg-foreground/20",
    ledger: "rounded-none border-y border-foreground/15 p-1",
    tiles: "p-1",
  }
  const stacked = (
    <span className={cn("flex flex-col gap-0.5", style === "wash" && "border-l border-foreground/15 pl-1")}>
      <span className={head} />
      <span className={cn(head, "w-1/2")} />
    </span>
  )
  const cell = (
    <span className="flex flex-col gap-0.5">
      <span className={call} />
      <span className={cn(call, "w-2/3")} />
    </span>
  )
  return (
    <span aria-hidden className={cn("flex h-12 flex-col justify-center overflow-hidden rounded-md", box[style])}>
      <span className="flex flex-col gap-1">
        <span className={cn("h-1 rounded-full bg-muted-foreground/25", style === "card" ? "w-1/2" : "w-2/3")} />
        {style === "columns" ? (
          <span className="grid grid-cols-2 gap-1">
            {cell}
            {cell}
          </span>
        ) : style === "tiles" ? (
          <span className="flex flex-col gap-0.5">
            <span className="rounded-sm border bg-muted/40 px-0.5 py-px"><span className={cn(call, "block")} /></span>
            <span className="rounded-sm border bg-muted/40 px-0.5 py-px"><span className={cn(call, "block w-2/3")} /></span>
          </span>
        ) : style === "ledger" ? (
          <span className="flex flex-col divide-y divide-foreground/15">
            <span className="pb-0.5"><span className={cn(call, "block")} /></span>
            <span className="pt-0.5"><span className={cn(call, "block w-2/3")} /></span>
          </span>
        ) : (
          stacked
        )}
      </span>
    </span>
  )
}

/** A row reaches to the card's edges so its hover ground does too — the
    card's rows sit in `px-3 @panel-sm:px-4`. */
const BLEED = "-mx-3 px-3 @panel-sm:-mx-4 @panel-sm:px-4"

/** A nested item steps in one level per depth, with a rail: the indent is
    inside the bleed, so a child's hover ground still spans the card. */
function Indent({ depth, children }: { depth: number; children: React.ReactNode }) {
  return (
    <div className={cn(depth > 0 && "border-l pl-3")} style={depth > 0 ? { marginLeft: depth * 16 } : undefined}>
      {children}
    </div>
  )
}

/** The mark, tinted while the option is on (a column of marks says what is on
    before a switch is read), and the title with a dot when it is not the
    default — the one thing you cannot read off a switch is whether it is the
    switch *you* moved. */
function rowHead(Icon: LucideIcon, title: string, on: boolean, changed: boolean) {
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

function SwitchRow({
  item,
  value,
  changed,
  disabled,
  depth,
}: {
  item: SwitchItem
  value: boolean
  changed: boolean
  disabled: boolean
  depth: number
}) {
  const { icon, key, title, description } = item
  return (
    /* The whole row is the target — a switch is a small thing to hit on a
       phone. Not a <label>: the Switch is a button, which is not labelable, so
       the association would be decorative and the pointer cursor a lie. */
    <div
      role="presentation"
      onClick={disabled ? undefined : () => setLayoutOption(key, !value)}
      className={cn(BLEED, "transition-colors", disabled ? "opacity-50" : "cursor-pointer hover:bg-muted")}
    >
      <Indent depth={depth}>
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
      </Indent>
    </div>
  )
}

/** A choice: a Row's head over a full-width control. Full width because three
    short words fit a phone, where a select beside two lines of text squeezed
    both. The control labels itself (`Segmented`, `ChoiceTiles`); tiles bring
    their own vertical padding. */
function ChoiceRow({
  item,
  options,
  changed,
  disabled,
  depth,
}: {
  item: ChoiceItem
  options: LayoutOptions
  changed: boolean
  disabled: boolean
  depth: number
}) {
  const choices = choicesOf(item, options)
  const value = item.value?.(options) ?? (options[item.key] as string)
  const set = (next: string) => setLayoutOption(item.key, next as never)
  return (
    <Indent depth={depth}>
      <div className={cn(disabled && "pointer-events-none opacity-50")}>
        <Row {...rowHead(item.icon, item.title, false, changed)} subtitle={describe(item, options)} />
        <div className={item.tiles ? "-mt-4" : "-mt-1 pb-3"}>
          {item.tiles ? (
            <ChoiceTiles
              label={item.title}
              value={value}
              onChange={set}
              choices={choices.map((choice) => ({
                value: choice.value,
                label: choice.label,
                hint: choice.hint,
                preview: choice.preview?.(options),
              }))}
            />
          ) : (
            <Segmented label={item.title} value={value} onChange={set} options={choices} disabled={disabled} />
          )}
        </div>
      </div>
    </Indent>
  )
}

/** One level of the tree, then each item's children one level deeper — dimmed
    under a switch that is off, hidden by their own `when`. */
function Items({
  items,
  options,
  changed,
  depth = 0,
  disabled = false,
}: {
  items: Item[]
  options: LayoutOptions
  changed: Set<keyof LayoutOptions>
  depth?: number
  disabled?: boolean
}) {
  return items.map((item) => {
    if (!isSwitch(item) && item.when && !item.when(options)) return null
    const on = isSwitch(item) ? options[item.key] : true
    return (
      <React.Fragment key={item.key}>
        {isSwitch(item) ? (
          <SwitchRow item={item} value={on} changed={changed.has(item.key)} disabled={disabled} depth={depth} />
        ) : (
          <ChoiceRow item={item} options={options} changed={changed.has(item.key)} disabled={disabled} depth={depth} />
        )}
        {item.children && (
          <Items items={item.children} options={options} changed={changed} depth={depth + 1} disabled={disabled || !on} />
        )}
      </React.Fragment>
    )
  })
}

/**
 * How every thread is drawn, or how the sidebar lists, on this device —
 * Settings › Appearance › Transcript / Interface (`scope`).
 *
 * It was a dialog opened from the app header; it is a part of the page now,
 * and ⌥V and the palette's row go to that page. Every category of the scope in
 * `GROUPS` is a Group, stacked. Search filters the rows within them and hides a
 * Group with nothing left.
 */
export function LayoutSettings({ scope = "transcript" }: { scope?: "transcript" | "interface" }) {
  const options = useLayoutOptions()
  const [search, setSearch] = React.useState("")
  const normalizedSearch = search.trim().toLowerCase()
  const matches = (...values: string[]) =>
    !normalizedSearch || values.some((value) => value.toLowerCase().includes(normalizedSearch))
  const groups = React.useMemo(() => GROUPS.filter((group) => group.scope === scope), [scope])
  const visibleGroups = groups.flatMap((group) => {
    const items = matches(group.label, group.hint) ? group.items : filterItems(group.items, options, matches)
    return items.length ? [{ ...group, items }] : []
  })
  /* Every key the page can move, not just the switches: the count on Reset is
     about the whole surface, and a picker changed from the default is exactly
     as much a change as a switch is. */
  const keys = React.useMemo(() => keysOf(groups.flatMap((group) => group.items)), [groups])
  const changedKeys = React.useMemo(
    () => new Set(keys.filter((key) => options[key] !== LAYOUT_DEFAULTS[key])),
    [keys, options]
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
          onClick={() => resetLayoutOptions(keys)}
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
        visibleGroups.map((group) => (
          <Group key={group.id} label={group.label} hint={`${group.hint} ${NOTE}`}>
            <Items items={group.items} options={options} changed={changedKeys} />
          </Group>
        ))
      )}
    </div>
  )
}
