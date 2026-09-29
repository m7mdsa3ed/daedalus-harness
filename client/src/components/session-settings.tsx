/* ── View settings ──
   Display-only switches (lib/view-options): they change how the transcript
   reads, never what is in it and never anything the agent is told. That is why
   they live here and not in SessionConfigPopover, which respawns the agent
   process to change model/effort/mode. They are global to this device — one
   reading setup for every thread — and persisted, so the dialog takes no
   session — so the button sits in the **app header** (app-shell.tsx), beside
   the panel menu, and not in a thread's composer row. Being global is the
   argument: the dock can mount several chat panels at once, and each of them
   drew its own copy of one device-wide dialog, while the header has exactly one
   of it however the dock is split.

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

   Each section is one card with hairline-separated rows; a row that differs from
   its default carries a dot, and the footer counts those changes and offers the
   one way back. */
import * as React from "react"
import {
  AlignJustify,
  ArrowDownToLine,
  Bot,
  Brain,
  Clock,
  Code,
  Coins,
  Columns2,
  Eye,
  Globe,
  LayoutList,
  ListTree,
  Maximize2,
  MessageSquareText,
  MousePointer2,
  RotateCcw,
  Rows3,
  Search,
  SeparatorHorizontal,
  Sparkles,
  Terminal as TerminalIcon,
  WrapText,
  Wrench,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { StreamSpeedPicker } from "@/components/stream-speed-picker"
import { STREAM_SPEEDS } from "@/lib/stream-pace"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import {
  ANSWERS_ONLY_SUPPRESSES,
  SUBAGENT_PEEKS,
  TOOL_LAYOUTS,
  resetViewOptions,
  setViewOption,
  useViewOptions,
  VIEW_DEFAULTS,
  type SubagentPeek,
  type ToolLayout,
  type ViewOptions,
} from "@/lib/view-options"

/** The switches, and only the switches. Non-boolean preferences render as
    their own picker controls, not as a boolean switch row. */
type BooleanOption = {
  [K in keyof ViewOptions]: ViewOptions[K] extends boolean ? K : never
}[keyof ViewOptions]

type Option = {
  key: BooleanOption
  icon: typeof Clock
  title: string
  description: string
}

type Group = {
  id: string
  label: string
  icon: typeof Clock
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

const GROUPS: Group[] = [
  {
    id: "layout",
    label: "Layout",
    icon: LayoutList,
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
    icon: MessageSquareText,
    hint: "Choose what stays visible around the answers.",
    options: [
      {
        key: "answersOnly",
        icon: MessageSquareText,
        title: "Answers only",
        description:
          "Keep the conversation and drop the work: your messages and the agent's replies, without thinking, tool steps, plans or subagents. Errors stay, and nothing is deleted — the steps come back when you turn it off.",
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
          "The rows marking a mode, model, effort, profile, persona or agent change, wherever in the thread it happened. Off, the change still takes effect — only the row is silent.",
      },
    ],
  },
  {
    id: "agent-activity",
    label: "Agent activity",
    icon: ListTree,
    hint: "Choose how much of the work behind an answer is shown.",
    pickers: ["subagentPeek", "toolLayout"],
    options: [
      {
        key: "showThinking",
        icon: Brain,
        title: "Show thinking",
        description: "Expand the agent's reasoning steps by default instead of folding them away.",
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
        key: "groupTools",
        icon: Wrench,
        title: "Group tool calls and thinking",
        description:
          "Fold consecutive tool calls and the thinking between them into one expandable group.",
      },
      {
        key: "openRunningGroup",
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
    icon: TerminalIcon,
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
    icon: Globe,
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
    icon: Code,
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
    icon: MousePointer2,
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

const ALL_OPTIONS = GROUPS.flatMap((group) => group.options)

function ToolLayoutPreview({ layout }: { layout: ToolLayout }) {
  const line = "h-1 rounded-full bg-muted-foreground/35"
  return (
    <span
      aria-hidden
      className={cn(
        "flex h-12 flex-col justify-center gap-1.5 overflow-hidden rounded-md p-1.5",
        layout === "cards" ? "bg-muted/40" : layout === "console" ? "border border-border/70 bg-muted/30" : layout === "spotlight" ? "bg-primary/5" : "bg-background/70",
        layout === "outlined" && "border border-border/60",
        layout === "minimal" && "bg-transparent"
      )}
    >
      {layout === "cards" ? (
        <>
          <span className="flex items-center gap-1 rounded-sm border border-border/60 bg-background/80 px-1 py-0.5">
            <span className="size-1 rounded-full bg-primary/60" /><span className={cn(line, "w-2/3")} />
          </span>
          <span className="flex items-center gap-1 rounded-sm border border-border/60 bg-background/80 px-1 py-0.5">
            <span className="size-1 rounded-full bg-primary/60" /><span className={cn(line, "w-1/2")} />
          </span>
        </>
      ) : layout === "compact" ? (
        <>
          <span className="flex items-center gap-1"><span className="size-1 rounded-full bg-muted-foreground/40" /><span className={cn(line, "w-3/4")} /></span>
          <span className="flex items-center gap-1"><span className="size-1 rounded-full bg-muted-foreground/40" /><span className={cn(line, "w-1/2")} /></span>
          <span className="flex items-center gap-1"><span className="size-1 rounded-full bg-muted-foreground/40" /><span className={cn(line, "w-2/3")} /></span>
        </>
      ) : layout === "rail" ? (
        <span className="flex flex-col gap-1 border-l-2 border-primary/40 pl-1.5">
          <span className={cn(line, "w-3/4")} /><span className={cn(line, "w-1/2")} />
        </span>
      ) : layout === "console" ? (
        <>
          <span className="flex items-center gap-1"><span className="size-1 rounded-full bg-primary/60" /><span className={cn(line, "w-2/3")} /></span>
          <span className="h-3 rounded-sm border border-border/60 bg-background/80" />
        </>
      ) : layout === "outlined" ? (
        <span className="flex flex-col gap-1 rounded-sm border border-primary/30 px-1 py-1">
          <span className={cn(line, "w-3/4")} /><span className={cn(line, "w-1/2")} />
        </span>
      ) : layout === "minimal" ? (
        <span className="flex flex-col gap-1">
          <span className={cn(line, "w-3/4")} /><span className={cn(line, "w-1/2 opacity-50")} />
        </span>
      ) : layout === "spotlight" ? (
        <span className="flex flex-col gap-1 rounded-sm bg-primary/10 px-1 py-1">
          <span className="flex items-center gap-1"><span className="size-1 rounded-full bg-primary" /><span className={cn(line, "w-3/4")} /></span>
          <span className="h-2 rounded-sm bg-background/80" />
        </span>
      ) : (
        <span className="flex flex-col gap-1 border-l border-border/70 pl-1.5">
          <span className="flex items-center gap-1"><span className="size-1 rounded-full bg-primary/60" /><span className={cn(line, "w-3/4")} /></span>
          <span className={cn(line, "ml-2 w-1/2")} />
        </span>
      )}
    </span>
  )
}

/** What a row says in place of its description while another option has
    already settled it. One sentence, and it names the option responsible —
    a greyed switch with no reason is a bug report. */
const MOOT_NOTE = "Nothing to apply it to while Answers only is on."

function OptionRow({
  option,
  value,
  changed,
  moot,
}: {
  option: Option
  value: boolean
  changed: boolean
  /** Another option has already decided this one — the row says so and is
      inert, rather than offering a switch that would change nothing on
      screen. Disabled, never rewritten: the value is still the reader's and
      comes back the moment the option above it goes off. */
  moot?: string
}) {
  const { icon: Icon, key, title, description } = option
  return (
    /* The whole row is the target — a switch is a small thing to hit on a
       phone. Not a <label>: the Switch is a button, which is not labelable, so
       the association would be decorative and the pointer cursor a lie. */
    <div
      role="presentation"
      aria-disabled={moot ? true : undefined}
      onClick={() => {
        if (moot) return
        setViewOption(key, !value)
      }}
      className={cn(
        "flex items-start gap-3 px-3 py-2.5 transition-colors",
        moot ? "opacity-55" : "cursor-pointer hover:bg-muted/40"
      )}
    >
      <span
        aria-hidden
        className={cn(
          "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border border-transparent transition-colors",
          value ? "bg-primary/10 text-primary" : "bg-muted/60 text-muted-foreground"
        )}
      >
        <Icon className="size-3.5" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5 text-xs leading-5 font-medium">
          {title}
          {/* Not the default. The one thing you cannot read off a switch is
              whether it is the switch *you* moved. */}
          {changed && (
            <span
              aria-label="changed from the default"
              className="size-1.5 shrink-0 rounded-full bg-primary"
            />
          )}
        </span>
        <span className="text-[11px] leading-4 text-balance text-muted-foreground">
          {moot ?? description}
        </span>
      </span>
      {/* Stopped, or the row's own handler would toggle it straight back. */}
      <span className="mt-0.5 shrink-0" onClick={(event) => event.stopPropagation()}>
        <Switch
          checked={value}
          disabled={moot !== undefined}
          onCheckedChange={(checked) => setViewOption(key, checked)}
          aria-label={title}
        />
      </span>
    </div>
  )
}

/**
 * How every thread is drawn on this device.
 *
 * The dialog only — what opens it is a row in the app header's one menu
 * (components/thread-menu). It used to carry its own eye button beside that
 * menu; three icon buttons in a 12px-tall header, two of which opened menus,
 * was a row you had to learn rather than read.
 */
export function SessionSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const options = useViewOptions()
  const [search, setSearch] = React.useState("")
  const normalizedSearch = search.trim().toLowerCase()
  const matches = (...values: string[]) =>
    !normalizedSearch || values.some((value) => value.toLowerCase().includes(normalizedSearch))
  const matchesPicker = (picker: NonNullable<Group["pickers"]>[number]) => {
    if (picker === "streamSpeed") {
      return matches("streaming speed", ...STREAM_SPEEDS.flatMap((speed) => [speed.label, speed.description]))
    }
    if (picker === "subagentPeek") {
      return matches("subagent activity", ...SUBAGENT_PEEKS.flatMap((peek) => [SUBAGENT_PEEK_COPY[peek].label, SUBAGENT_PEEK_COPY[peek].description]))
    }
    return matches(
      "tool call layout",
      ...TOOL_LAYOUTS.flatMap((layout) => [
        layout,
        layout === "rail" ? "accent rail" : "",
        layout === "console" ? "command-style" : "",
        layout === "cards" ? "separate panels" : "",
        layout === "compact" ? "tighter list" : "",
        layout === "minimal" ? "no framing" : "",
        layout === "spotlight" ? "live step focus" : "",
      ])
    )
  }
  const visibleGroups = GROUPS.flatMap((group) => {
    const headerMatches = matches(group.label, group.hint)
    const visibleOptions = headerMatches
      ? group.options
      : group.options.filter((option) => matches(option.title, option.description))
    const visiblePickers = (headerMatches
      ? group.pickers ?? []
      : (group.pickers ?? []).filter(matchesPicker)
    ).filter((picker) => !options.answersOnly || picker === "streamSpeed")
    return visibleOptions.length || visiblePickers.length
      ? [{ ...group, visibleOptions, visiblePickers }]
      : []
  })
  /* Every key the dialog can move, not just the switches: the count in the
     footer and the Reset beside it are about the whole surface, and a reveal
     changed from the default is exactly as much a change as a switch is. */
  const changedKeys = React.useMemo(
    () =>
      new Set(
        ([
          ...ALL_OPTIONS.map((o) => o.key),
          "subagentPeek",
          "toolLayout",
          "streamSpeed",
        ] as (keyof ViewOptions)[]).filter(
          (key) => options[key] !== VIEW_DEFAULTS[key]
        )
      ),
    [options]
  )
  /* "Answers only" takes the rows these describe off the screen, so the
     switches for them have nothing left to say. Which ones is stated in
     lib/view-options beside the option, not here: the dialog draws the
     consequence, it does not decide it. */
  const mootKeys = React.useMemo(
    () =>
      new Set([
        ...(options.answersOnly ? ANSWERS_ONLY_SUPPRESSES : []),
      ]),
    [options.answersOnly]
  )

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-xl">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>View settings</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Shape the transcript around how you like to read. These preferences stay on this device and never affect the agent.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <div className="flex flex-col gap-4">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search view options…"
              aria-label="Search view options"
              className="h-9 pl-9 text-sm"
            />
          </div>
          {visibleGroups.length === 0 && (
            <p className="rounded-lg border border-border/60 px-3 py-6 text-center text-xs text-muted-foreground">
              No view options match “{search.trim()}”.
            </p>
          )}
          {visibleGroups.map((group) => (
            <section key={group.id} className="flex flex-col gap-2">
              <header className="flex items-center gap-2 px-1">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/8 text-primary">
                  <group.icon className="size-3.5" aria-hidden />
                </span>
                <h3 className="text-[11px] font-semibold tracking-wide text-foreground uppercase">
                  {group.label}
                </h3>
                <p className="min-w-0 truncate text-[11px] text-muted-foreground/70">
                  {group.hint}
                </p>
              </header>
              <div className="divide-y divide-border/50 overflow-hidden rounded-xl border border-border/60 bg-card/40">
                {group.visibleOptions.map((option) => (
                  <OptionRow
                    key={option.key}
                    option={option}
                    value={options[option.key]}
                    changed={changedKeys.has(option.key)}
                    moot={mootKeys.has(option.key) ? MOOT_NOTE : undefined}
                  />
                ))}
                {group.visiblePickers.includes("streamSpeed") && (
                  <StreamSpeedPicker
                    speed={options.streamSpeed}
                    onSpeedChange={(speed) => setViewOption("streamSpeed", speed)}
                  />
                )}
                {!options.answersOnly && group.visiblePickers.includes("subagentPeek") && (
                  <div className="space-y-2.5 px-3 py-3">
                    <div className="flex items-center gap-3">
                      <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
                        <Bot className="size-3.5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5 text-xs leading-5 font-medium">
                          Subagent activity
                          {changedKeys.has("subagentPeek") && (
                            <span aria-label="changed from the default" className="size-1.5 shrink-0 rounded-full bg-primary" />
                          )}
                        </span>
                        <span className="block text-[11px] leading-4 text-muted-foreground">
                          {SUBAGENT_PEEK_COPY[options.subagentPeek].description}
                        </span>
                      </span>
                    </div>
                    {/* Segmented, full width: three short words fit a phone,
                        where a select beside two lines of text squeezed both. */}
                    <div role="radiogroup" aria-label="Subagent activity" className="flex gap-0.5 rounded-lg bg-muted/50 p-0.5">
                      {SUBAGENT_PEEKS.map((peek) => {
                        const selected = options.subagentPeek === peek
                        return (
                          <button
                            key={peek}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            onClick={() => setViewOption("subagentPeek", peek)}
                            className={cn(
                              "min-h-8 flex-1 rounded-[7px] px-2 py-1 text-[11px] font-medium transition-colors",
                              selected ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                            )}
                          >
                            {SUBAGENT_PEEK_COPY[peek].label}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
                {!options.answersOnly && group.visiblePickers.includes("toolLayout") && (
                  <div className="space-y-3 px-3 py-3">
                    <div className="flex items-center gap-3">
                      <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
                        <Wrench className="size-3.5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5 text-xs leading-5 font-medium">
                          Tool call layout
                          {changedKeys.has("toolLayout") && (
                            <span aria-label="changed from the default" className="size-1.5 shrink-0 rounded-full bg-primary" />
                          )}
                        </span>
                        <span className="block text-[11px] leading-4 text-muted-foreground">
                          Pick the visual style for tool steps.
                        </span>
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 @md:grid-cols-3">
                      {TOOL_LAYOUTS.map((layout) => {
                        const selected = options.toolLayout === layout
                        const title = layout === "timeline" ? "Timeline" : layout === "cards" ? "Cards" : layout === "compact" ? "Compact" : layout === "rail" ? "Accent rail" : layout === "console" ? "Console" : layout === "outlined" ? "Outlined" : layout === "minimal" ? "Minimal" : "Spotlight"
                        const description = layout === "timeline" ? "Flowing steps" : layout === "cards" ? "Separate panels" : layout === "compact" ? "Tighter list" : layout === "rail" ? "Indented sequence" : layout === "console" ? "Command-style" : layout === "outlined" ? "Fine borders" : layout === "minimal" ? "No framing" : "Live step focus"
                        return (
                          <button
                            key={layout}
                            type="button"
                            aria-pressed={selected}
                            onClick={() => setViewOption("toolLayout", layout)}
                            className={cn(
                              "min-w-0 rounded-lg border p-2 text-start transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                              selected ? "border-primary/60 bg-primary/5 shadow-sm" : "border-border/60 bg-background/40"
                            )}
                          >
                            <ToolLayoutPreview layout={layout} />
                            <span className="mt-2 block truncate text-[11px] font-medium">{title}</span>
                            <span className="block truncate text-[10px] text-muted-foreground">{description}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            </section>
          ))}
        </div>
        <ResponsiveDialogFooter className="items-center sm:justify-between">
          <p className="text-[11px] text-muted-foreground">
            {changedKeys.size === 0
              ? "Every option is at its default."
              : `${changedKeys.size} option${changedKeys.size === 1 ? "" : "s"} changed from the defaults.`}
          </p>
          <Button
            variant="ghost"
            size="sm"
            disabled={changedKeys.size === 0}
            onClick={() => resetViewOptions()}
          >
            <RotateCcw /> Reset
          </Button>
        </ResponsiveDialogFooter>
    </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
