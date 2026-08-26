/* ── Session view settings ──
   Display-only switches for one thread (lib/view-options): they change how the
   transcript reads, never what is in it and never anything the agent is told.
   That is why they live here and not in SessionConfigPopover, which respawns
   the agent process to change model/effort/mode.

   The list is declarative — add an entry to OPTIONS and the row appears. */
import * as React from "react"
import { Clock, Eye, RotateCcw, Wrench } from "lucide-react"
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
