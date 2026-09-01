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
   and the row appears. Grouping is the whole layout argument — thirteen equally
   weighted outlined cards read as a wall, and the questions they answer are not
   one question. Four sections, each answering one:

     Layout   — how much of the thread is on screen at once
     Detail   — how much of each step is spelled out
     Code     — how a diff or a code block is drawn
     Motion   — what moves on its own

   Each section is one card with hairline-separated rows, so the eye counts four
   things and not thirteen; a row that differs from its default carries a dot, so
   "what have I changed here" is answerable without reading every switch, and the
   footer says how many and offers the one way back. */
import * as React from "react"
import {
  AlignJustify,
  ArrowDownToLine,
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
import { StreamEffectPicker } from "@/components/stream-effect-picker"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import {
  ANSWERS_ONLY_SUPPRESSES,
  CALM_MOTION_SUPPRESSES,
  resetViewOptions,
  setViewOption,
  useViewOptions,
  VIEW_DEFAULTS,
  type ViewOptions,
} from "@/lib/view-options"

/** The switches, and only the switches. `ViewOptions` now holds one choice
    that is not one, and a row that renders a Switch has no business being
    typed wide enough to hold it. */
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
  /** A choice that is not a switch, drawn as the last row of the same card.
      Only Motion has one; it is a field on the group rather than a section of
      its own so the reveal reads as part of "what moves on its own" and not as
      a fifth thing to weigh. */
  picker?: "streamEffect"
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
          "Tick marks down the right edge, one per message you sent. Hover to preview, click to jump.",
      },
    ],
  },
  {
    id: "detail",
    label: "Detail",
    icon: ListTree,
    hint: "How much of each step is spelled out.",
    options: [
      {
        key: "answersOnly",
        icon: MessageSquareText,
        title: "Answers only",
        description:
          "Keep the conversation and drop the work: your messages and the agent's replies, without thinking, tool steps, plans or subagents. Errors stay, and nothing is deleted — the steps come back when you turn it off.",
      },
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
        title: "Group tool steps",
        description:
          "Fold a run of consecutive steps, and the thinking between them, into one line you can open — the prose stays the thing you scroll.",
      },
      {
        key: "showSources",
        icon: Globe,
        title: "Show sources",
        description:
          "Site favicons under a web step, and the pages an answer cited under the finished turn.",
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
    ],
  },
  {
    id: "code",
    label: "Code and diffs",
    icon: Code,
    hint: "How an edit is drawn.",
    options: [
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
    picker: "streamEffect",
  },
]

const ALL_OPTIONS = GROUPS.flatMap((group) => group.options)

/** What a row says in place of its description while another option has
    already settled it. One sentence, and it names the option responsible —
    a greyed switch with no reason is a bug report. */
const MOOT_NOTE = "Nothing to apply it to while Answers only is on."
const CALM_NOTE = "Calm motion is on, so a live answer arrives with nothing added."

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
  /* Every key the dialog can move, not just the switches: the count in the
     footer and the Reset beside it are about the whole surface, and a reveal
     changed from the default is exactly as much a change as a switch is. */
  const changedKeys = React.useMemo(
    () =>
      new Set(
        ([...ALL_OPTIONS.map((o) => o.key), "streamEffect"] as (keyof ViewOptions)[]).filter(
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
        ...(options.calmMotion ? CALM_MOTION_SUPPRESSES : []),
      ]),
    [options.answersOnly, options.calmMotion]
  )

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-lg">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>View settings</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            How every thread is displayed on this device. The agent is not told, and other
            clients are not affected.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <div className="flex flex-col gap-5">
          {GROUPS.map((group) => (
            <section key={group.id} className="flex flex-col gap-2">
              <header className="flex items-baseline gap-2 px-1">
                <h3 className="text-[11px] font-semibold tracking-wide text-foreground uppercase">
                  {group.label}
                </h3>
                <p className="min-w-0 truncate text-[11px] text-muted-foreground/70">
                  {group.hint}
                </p>
              </header>
              <div className="divide-y divide-border/50 overflow-hidden rounded-xl border border-border/60 bg-card/40">
                {group.options.map((option) => (
                  <OptionRow
                    key={option.key}
                    option={option}
                    value={options[option.key]}
                    changed={changedKeys.has(option.key)}
                    moot={mootKeys.has(option.key) ? MOOT_NOTE : undefined}
                  />
                ))}
                {group.picker === "streamEffect" && (
                  <StreamEffectPicker
                    value={options.streamEffect}
                    onChange={(effect) => setViewOption("streamEffect", effect)}
                    moot={mootKeys.has("streamEffect") ? CALM_NOTE : undefined}
                  />
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
