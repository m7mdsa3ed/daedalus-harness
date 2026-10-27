/* The right-hand end of a tab strip: the + and the group's tab list.

   The + is back, and it is the browser's affordance — the one control every tab
   strip has ever had, at the end of the tabs, where a reader who wants another
   one looks first. It went to the app header once because a split dock has one
   per group with no obvious answer to which you press; the answer it has now is
   that there is no ambiguity to resolve — a + on *this* strip opens into *this*
   group, which is the same thing every tab beside it is about. It opens a new
   tab and nothing else — no menu, because a + that asks "open what?" is the
   header menu wearing a second face. The opener comes down through the dock
   (`useDockOpeners`) because which project a panel belongs to is `app-shell`'s
   answer, not a strip's.

   The layout button is the + for arrangement: it deals the dock's tabs into a
   preset (`LAYOUT_PRESETS`, the Layouts menu's own list). Not on a phone,
   which folds every split back into one strip.

   The tab list is the opposite case, and belongs here for the same reason the +
   does not: it is *about this group*. Once tabs stop fitting, the strip scrolls
   and the tab you want is off the end of a row with no scrollbar to speak of —
   so the list is the way back to a panel you cannot see, and it says what each
   one is doing (`panel-status`) rather than only what it is called. It also
   carries the group's own **Close all** at its foot, so tidying a strip is not a
   hunt through one tab's ⋮ menu — and the phone's grid carries the same row. */
import * as React from "react"
import type { IDockviewHeaderActionsProps, IDockviewPanel } from "dockview-react"
import { ChevronDownIcon, HistoryIcon, LayoutGrid, PinIcon, PlusIcon, XIcon } from "lucide-react"

import { Count } from "@/components/settings/primitives"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { useStoreSelect } from "@/lib/store"
import { useChord } from "@/lib/keybindings"
import { formatChord } from "@/lib/shortcuts"
import { useIsMobile } from "@/hooks/use-device"
import { HEADER_CHIP } from "@/lib/header-chrome"
import { MENU_ROW, MENU_WIDTH, MenuRow } from "@/components/menu-row"
import { PANEL_ICONS, PanelIcon } from "@/components/workspace/panel-kinds"
import { AgentIcon } from "@/components/entity-icon"
import { PanelStatusDot } from "@/components/workspace/panel-status-dot"
import type { PresetId } from "@/components/workspace/dock-context"
import { LAYOUT_PRESETS } from "@/components/workspace/panel-items"
import { descriptorOf, useDock, useDockOpeners } from "@/components/workspace/dock-context"
import { useOpenThreads } from "@/lib/workspace/open-threads"
import { activityAt, isListed, relativeAge } from "@/lib/settings"
import { usePanelPinned } from "@/lib/workspace/panel-pins"
import { usePanelStatus } from "@/lib/workspace/panel-status"
import { PANEL_SPECS, isPanelKind } from "@/lib/workspace/panels"
import { cn } from "@/lib/utils"

/** Below this many tabs the strip shows them all, and a list of what you can
    already see is a button that does nothing for you. A phone's bar is two: its
    strip is the one tab you are on, so with a second tab open the list is the
    only place that one is by name — which is what makes it the switcher. */
const LIST_FROM = 3

/** Fired by a downward drag on the phone strip (`dock-surface.tsx`). */
export const TAB_GRID_EVENT = "daedalus:tab-grid"

/* The strip's own two controls are the sidebar toggle, exactly: the same
   ghost `Button` at `icon-sm`, the same `HEADER_CHIP` (round, `ring-edge` +
   `shadow-glass`, the composer's ground on a phone), the same foreground glyph
   at 16px. One recipe, so the toggle, the + and the switcher cannot drift. */
const STRIP_CONTROL = HEADER_CHIP

/* The switcher, on every width: a `ResponsiveDialog`, so it is a bottom sheet on
   a phone (Chrome Android's: the strip's button is the tab count) and a centred
   dialog beside the chevron on a desktop. One list of rows for both - the
   dropdown this replaced drew its own copy of them. */
function TabGrid({
  panels,
  onClose,
  onCloseAll,
  onNew,
  onOpenThread,
}: {
  panels: IDockviewPanel[]
  onClose: (id: string) => void
  onCloseAll: () => void
  onNew?: () => void
  onOpenThread: (id: string) => void
}) {
  const [open, setOpen] = React.useState(false)
  /* Recents, as the sidebar draws them: listed threads with no tab open, newest
     activity first. Only read while the grid is open. */
  const sessions = useStoreSelect((state) => state.sessions)
  const openIds = useOpenThreads()
  const recent = React.useMemo(() => {
    if (!open) return []
    const taken = new Set(openIds)
    return sessions
      .filter((s) => isListed(s) && !s.deletedAt && !taken.has(s.id))
      .sort((a, b) => activityAt(b) - activityAt(a))
      .slice(0, 6)
  }, [open, sessions, openIds])
  /* The strip's drag-down (`dock-surface.tsx`) opens the same grid. */
  React.useEffect(() => {
    const show = () => setOpen(true)
    window.addEventListener(TAB_GRID_EVENT, show)
    return () => window.removeEventListener(TAB_GRID_EVENT, show)
  }, [])
  const isMobile = useIsMobile()
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        title={`Switch tabs (${panels.length})`}
        aria-label={`Switch tabs, ${panels.length} open`}
        className={STRIP_CONTROL}
        onClick={() => setOpen(true)}
      >
        {/* On a phone the count is the glyph: bare, like the toggle's icon. */}
        {isMobile ? (
          <span className="text-sm font-medium tabular-nums">{panels.length}</span>
        ) : (
          <ChevronDownIcon className="size-4" />
        )}
      </Button>
      <ResponsiveDialog open={open} onOpenChange={setOpen}>
        <ResponsiveDialogContent bodyClassName="gap-1 p-2" className="sm:max-w-md">
          <ResponsiveDialogHeader className="flex-row items-center gap-2">
            <ResponsiveDialogTitle>Tabs</ResponsiveDialogTitle>
            <Count>{panels.length}</Count>
            {/* The group's own tidy-up. Closing the panel first keeps it from
                standing over a dock that is now empty. */}
            {panels.length > 1 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setOpen(false)
                  onCloseAll()
                }}
                className="ml-auto text-muted-foreground"
              >
                Close all
              </Button>
            )}
          </ResponsiveDialogHeader>
          {panels.map((panel) => (
            <TabCard key={panel.id} panel={panel} onPick={() => setOpen(false)} onClose={() => onClose(panel.id)} />
          ))}
          {recent.length > 0 && (
            <>
              <div className="mt-3 flex h-8 items-center gap-2.5 px-3 text-xs font-medium text-muted-foreground">
                <HistoryIcon className="size-4" />
                Recent
              </div>
              {recent.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    setOpen(false)
                    onOpenThread(s.id)
                  }}
                  className="flex min-h-12 items-center gap-2.5 rounded-3xl px-3 text-left hover:bg-muted"
                >
                  {/* The tab rows' leading column: the thread's own mark. */}
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    <AgentIcon agentId={s.agentId} className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm">{s.title || "Untitled thread"}</span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {relativeAge(activityAt(s))}
                  </span>
                </button>
              ))}
            </>
          )}
          {onNew && (
            <ResponsiveDialogFooter className="flex-col justify-stretch px-2 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
              <Button
                variant="secondary"
                size="lg"
                onClick={() => {
                  setOpen(false)
                  onNew()
                }}
                className="w-full"
              >
                <PlusIcon />
                New tab
              </Button>
            </ResponsiveDialogFooter>
          )}
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </>
  )
}

function TabCard({ panel, onPick, onClose }: { panel: IDockviewPanel; onPick: () => void; onClose: () => void }) {
  const kind = panel.api.component
  const Icon = isPanelKind(kind) ? PANEL_ICONS[kind] : null
  /* The *open* panel's mark, not the kind's: a chat wears its agent and its
     project, a page the mark its sidebar row wears — the same `PanelIcon` the
     tab in the strip carries, so a row and the tab it stands for agree. The kind
     glyph is the fallback for a panel whose params did not parse. */
  const descriptor = descriptorOf(panel)
  const title = panel.title ?? (isPanelKind(kind) ? PANEL_SPECS[kind].defaultTitle : "Panel")
  const status = usePanelStatus(panel.id)
  const pinned = usePanelPinned(panel.id)
  const active = panel.api.isActive
  return (
    <div
      className={cn(
        // 48px row, 36px trailing control at 6px all round: 18 + 6 ≈ rounded-3xl.
        "flex min-h-12 items-center rounded-3xl transition-colors",
        active ? "bg-muted" : "hover:bg-muted"
      )}
    >
      <button
        type="button"
        aria-current={active ? "true" : undefined}
        onClick={() => {
          panel.api.setActive()
          onPick()
        }}
        className="flex min-h-12 min-w-0 flex-1 items-center gap-2.5 pr-1 pl-3 text-left"
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          {descriptor ? <PanelIcon panel={descriptor} className="size-4" /> : Icon && <Icon className="size-4 text-muted-foreground" />}
        </span>
        <span className={cn("min-w-0 flex-1 truncate text-sm", status?.tone === "running" && "harness-shimmer")}>
          {title}
        </span>
        <PanelStatusDot status={status} />
      </button>
      {/* Pinned rows keep the pin instead of a ✕ — the trade the strip's own list
          makes too. The ✕ stands *beside* the switch button rather than inside
          it, so closing a tab never switches to it on the way out. */}
      {pinned ? (
        <span className="mr-1.5 flex size-9 shrink-0 items-center justify-center">
          <PinIcon aria-label="Pinned" className="size-3.5 text-muted-foreground" />
        </span>
      ) : (
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Close ${title}`}
          onClick={onClose}
          /* 36px, not 32: this list is a drawer on a phone, and the ✕ is a
             touch target. `mr-1.5` is the row's 6px vertical inset. */
          className="mr-1.5 shrink-0 text-muted-foreground"
        >
          <XIcon />
        </Button>
      )}
    </div>
  )
}

/** The layout menu: it arranges the whole dock, so it stands once in the app
    header beside the sidebar toggle rather than in every strip. */
export function LayoutMenu({ onPick, className }: { onPick: (preset: PresetId) => void; className?: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        title="Layout"
        render={
          <Button size="icon-xs" variant="ghost" aria-label="Arrange this dock" className={className}>
            <LayoutGrid className="size-3.5" />
          </Button>
        }
      />
      <DropdownMenuContent align="start" className={MENU_WIDTH}>
        {LAYOUT_PRESETS.map(({ id, label, Icon }) => (
          <DropdownMenuItem key={id} onClick={() => onPick(id)} className={MENU_ROW}>
            <MenuRow icon={<Icon />} label={label} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function TabActions({ panels, group }: IDockviewHeaderActionsProps) {
  const dock = useDock()
  const { onNewTab } = useDockOpeners()
  const isMobile = useIsMobile()
  const newTabChord = useChord("newThread")

  /* ── One gutter in the row ──
     Everything standing in a strip keeps the same 4px between it and its
     neighbour: two tabs are their own `mx-0.5` twice over, so these pay the
     other half of it against the last tab (`pl-0.5`) and a full one between
     themselves (`gap-1`). They used to be flush — two 28px targets with no
     seam, reading as one wide control — while the tabs beside them were
     spaced, which is the inconsistency this is. */
  return (
    <div className="flex h-full items-center gap-1 pl-0.5">
      {onNewTab && (
        /* One gesture, no menu: a + is the browser's "another one of these",
           and a reader who wanted a terminal has a tab's own menu for it. It
           lands on *this* strip, which is the whole meaning of the control
           standing at the end of these tabs. */
        <Button
          size="icon-sm"
          variant="ghost"
          title={newTabChord ? `New tab (${formatChord(newTabChord)})` : "New tab"}
          aria-label="New tab"
          onClick={() => onNewTab({ group: group.id })}
          className={STRIP_CONTROL}
        >
          <PlusIcon className="size-4" />
        </Button>
      )}
      {/* Below `LIST_FROM` the list is a button that does nothing for you — the
          tabs are all on screen. On a phone the strip is the one tab you are on
          and nothing else, so the list is the switcher from two tabs up: it is
          the only place the other one is, by name. The + stays either way, which
          is the whole reason this row no longer returns null. */}
      {(isMobile || panels.length >= LIST_FROM) && (
        <TabGrid
          panels={panels}
          onClose={(id) => void dock.closePanel(id)}
          onCloseAll={() => panels[0] && void dock.closeGroup(panels[0].id)}
          onOpenThread={(id) => dock.openChat(id, { newTab: true, into: { group: group.id } })}
          onNew={onNewTab && (() => onNewTab({ group: group.id }))}
        />
      )}
    </div>
  )
}
