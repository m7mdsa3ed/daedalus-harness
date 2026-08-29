/* ── Session view settings ──
   Display-only switches for one thread (lib/view-options): they change how the
   transcript reads, never what is in it and never anything the agent is told.
   That is why they live here and not in SessionConfigPopover, which respawns
   the agent process to change model/effort/mode.

   The list is declarative — add an entry to OPTIONS and the row appears. */
import * as React from "react"
import {
  AlignHorizontalSpaceBetween,
  AlignJustify,
  Clock,
  Columns2,
  Eye,
  ListTree,
  RotateCcw,
  Rows3,
  ScrollText,
  Text,
  WrapText,
  Wrench,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { Switch } from "@/components/ui/switch"
import {
  resetViewOptions,
  setViewOption,
  useViewOptions,
  VIEW_DEFAULTS,
  type ViewOptions,
} from "@/lib/view-options"

const OPTIONS: {
  key: keyof ViewOptions
  icon: typeof Clock
  title: string
  description: string
}[] = [
  {
    key: "showTimestamps",
    icon: Clock,
    title: "Show timestamps",
    description:
      "Wall-clock time beside each message and step. Replayed history has no clock to show, so only what happened while this tab was open is stamped.",
  },
  {
    key: "groupTools",
    icon: Wrench,
    title: "Group tool steps",
    description:
      "Fold a run of consecutive steps into one line you can open — the prose stays the thing you scroll.",
  },
  {
    key: "compactDensity",
    icon: AlignJustify,
    title: "Compact density",
    description: "Tighter line spacing and padding, so more of a long thread fits on screen.",
  },
  {
    key: "autoScroll",
    icon: ScrollText,
    title: "Follow the stream",
    description:
      "Keep the newest content in view while the agent is responding. Turn off to read freely without being yanked to the bottom.",
  },
  {
    key: "showThinking",
    icon: Text,
    title: "Show thinking",
    description: "Expand the agent's reasoning steps by default instead of folding them away.",
  },
  {
    key: "codeWrap",
    icon: WrapText,
    title: "Wrap code",
    description: "Soft-wrap long code blocks and diffs instead of scrolling them sideways.",
  },
  {
    key: "wideTranscript",
    icon: AlignHorizontalSpaceBetween,
    title: "Wide column",
    description: "Let the transcript run wider than the default reading measure.",
  },
  {
    key: "showToolDetails",
    icon: ListTree,
    title: "Expand tool output",
    description: "Open every tool call's input and output by default, not just edits and diffs.",
  },
  {
    key: "splitDiffs",
    icon: Columns2,
    title: "Split diffs",
    description: "Show file edits side by side (old | new) instead of as a unified list.",
  },
  {
    key: "stepDividers",
    icon: AlignHorizontalSpaceBetween,
    title: "Turn dividers",
    description: "Draw a hairline above each of your messages to separate one turn from the next.",
  },
  {
    key: "turnRail",
    icon: Rows3,
    title: "Turn rail",
    description:
      "Tick marks down the right edge, one per message you sent. Hover one to preview that turn, click it to jump there.",
  },
]

export function SessionSettingsButton({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = React.useState(false)
  const options = useViewOptions(sessionId)
  const changed = OPTIONS.some(({ key }) => options[key] !== VIEW_DEFAULTS[key])

  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        className="shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(true)}
        title="View settings for this thread"
      >
        <Eye />
        <span className="sr-only">View settings</span>
      </Button>
      <ResponsiveDialog open={open} onOpenChange={setOpen}>
        <ResponsiveDialogContent className="sm:max-w-lg">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>View settings</ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              How this thread is displayed on this device. The agent is not told, and other
              clients are not affected.
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <ItemGroup className="gap-1">
            {OPTIONS.map(({ key, icon: Icon, title, description }) => (
              <Item key={key} variant="outline" size="sm" className="items-start rounded-xl">
                <ItemMedia variant="icon">
                  <Icon />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle className="text-xs">{title}</ItemTitle>
                  <ItemDescription className="line-clamp-none text-[11px]">
                    {description}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Switch
                    checked={options[key]}
                    onCheckedChange={(checked) => setViewOption(sessionId, key, checked)}
                    aria-label={title}
                  />
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              disabled={!changed}
              onClick={() => resetViewOptions(sessionId)}
            >
              <RotateCcw /> Reset to defaults
            </Button>
          </div>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </>
  )
}
