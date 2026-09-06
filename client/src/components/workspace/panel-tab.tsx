/* One tab for every panel kind. It replaces Dockview's default tab, which is
   what makes `dock.closePanel` the only way a panel closes — and therefore the
   only place a dirty editor gets asked.

   What it draws is deliberately little: the project a thread runs in, the
   thread's name, and the two controls that act on the tab itself. A panel's
   *reading* (`lib/workspace/panel-status`) is not among them — it is on the
   strip's tab list, where a panel you cannot see is the one you need it for.
   On the face it was a third mark competing with two logos for one line of
   text, in a row that already carries the context ring.

   (It is still the panel's own answer and never a glyph a panel prefixes onto
   its title: that made the reading part of the title — nothing else could have
   one, it could not be coloured, and a screen reader read it as a stray
   character.) */
import * as React from "react"
import type { IDockviewPanelHeaderProps } from "dockview-react"
import { useNavigate } from "react-router"
import { MoreVerticalIcon, PinOffIcon, XIcon } from "lucide-react"
import { toast } from "@/lib/toast"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ContextIndicator } from "@/components/composer-status"
import { ProjectIcon } from "@/components/entity-icon"
import { MENU_WIDTH } from "@/components/menu-row"
import {
  ItemContextMenu,
  renderMenuItems,
  type MenuItemSpec,
} from "@/components/item-context-menu"
import { PanelIcon } from "@/components/workspace/panel-kinds"
import { useDock, useDockActions } from "@/components/workspace/dock"
import { reportError } from "@/lib/errors"
import { useProjects } from "@/lib/queries/catalog"
import { settingsFormPath, threadPath } from "@/lib/router"
import { useSessionMeta, useThread } from "@/lib/store"
import { useRunHelper } from "@/lib/workspace/use-run-helper"
import { usePanelPinned } from "@/lib/workspace/panel-pins"
import { PANEL_SPECS, isPanelKind, parsePanel } from "@/lib/workspace/panels"
import { cn } from "@/lib/utils"

/**
 * The thread's context reading, on its own tab.
 *
 * Its own component for the reason the header's was: `useThread` is written on
 * every streamed token, and a tab that subscribed to it would redraw its whole
 * strip — every sibling tab included — thousands of times a turn to move one
 * ring. Nothing above this line reads a thread.
 */
function TabContextRing({ sessionId }: { sessionId: string }) {
  const actions = useDockActions()
  const thread = useThread(sessionId)
  const meta = useSessionMeta(sessionId)
  return (
    <ContextIndicator
      thread={thread}
      meta={meta}
      actions={actions}
      side="bottom"
      size="icon-xs"
      triggerClassName="size-6 rounded-lg"
    />
  )
}

export function PanelTab({ api, containerApi, params }: IDockviewPanelHeaderProps) {
  const dock = useDock()
  const navigate = useNavigate()
  const runHelper = useRunHelper(dock)
  const descriptor = parsePanel(api.component, params)
  /* The thread's row, for the project it belongs to. A row keeps its identity
     unless it changes (see `useSessionMeta`), so this is not the streamed
     subscription `TabContextRing` is careful about. */
  const chatSessionId = descriptor?.kind === "chat" ? descriptor.sessionId : ""
  const meta = useSessionMeta(chatSessionId)
  const projects = useProjects()
  const project = meta ? projects.find((p) => p.id === meta.projectId) : undefined
  const [active, setActive] = React.useState(api.isActive)
  const [closable, setClosable] = React.useState(false)
  const [hasOthers, setHasOthers] = React.useState(false)
  const [hasRightward, setHasRightward] = React.useState(false)
  const pinned = usePanelPinned(api.id)

  React.useEffect(() => {
    const disposable = api.onDidActiveChange((event) => setActive(event.isActive))
    return () => disposable.dispose()
  }, [api])

  React.useEffect(() => {
    const sync = () => {
      const self = containerApi.getPanel(api.id)
      const siblings = self ? self.group.panels : []
      const index = siblings.findIndex((panel) => panel.id === api.id)
      setHasOthers(siblings.length > 1)
      setHasRightward(index >= 0 && index < siblings.length - 1)
      /* The last thread stays: the route always points at one, so closing it
         would only re-open it. Everything else closes freely. */
      setClosable(
        api.component !== "chat" ||
          containerApi.panels.filter((panel) => panel.api.component === "chat").length > 1
      )
    }
    sync()
    const disposables = [
      containerApi.onDidAddPanel(sync),
      containerApi.onDidRemovePanel(sync),
      // Dragging a tab between groups changes the siblings without adding or
      // removing a panel.
      containerApi.onDidLayoutChange(sync),
    ]
    return () => disposables.forEach((disposable) => disposable.dispose())
  }, [api, containerApi])

  const fallbackTitle = isPanelKind(api.component) ? PANEL_SPECS[api.component].defaultTitle : "Panel"
  const title = api.title ?? fallbackTitle

  const items: MenuItemSpec[] = [
    /* Close comes first and names *this* tab, so a pinned panel still has a way
       out — the bulk closes below are the ones pinning is a defence against. */
    { label: "Close", disabled: !closable, onClick: () => void dock.closePanel(api.id) },
    { label: "Close others", disabled: !hasOthers, onClick: () => void dock.closeOthers(api.id) },
    {
      label: "Close to the right",
      disabled: !hasRightward,
      onClick: () => void dock.closeToTheRight(api.id),
    },
    { label: "Close group", disabled: !hasOthers, onClick: () => void dock.closeGroup(api.id) },
    { type: "separator" },
    { label: pinned ? "Unpin" : "Pin", onClick: () => dock.togglePin(api.id) },
    { label: "Move to a floating window", onClick: () => dock.toggleFloat(api.id) },
    {
      label: "Open in a new window",
      onClick: () => {
        void dock.popoutPanel(api.id).then((opened) => {
          /* A blocked popup is silent otherwise — the click appears to do
             nothing at all, which reads as a broken menu item rather than as a
             browser setting the user can change. */
          if (!opened) toast.error("The browser blocked the new window")
        })
      },
    },
    /* The project's saved shell lines, on the tab of a thread that belongs to
       it. They were in the app header's ⋯ menu, which is where the app's
       *general* rows live — a helper acts on one project, and which project
       that is, is a fact about this tab. A helper runs in a terminal panel, so
       the dock is already the thing it needs. */
    ...(project && project.helpers?.length
      ? ([
          { type: "separator" },
          {
            type: "sub",
            label: "Project commands",
            hint: `Saved shell lines for ${project.name}`,
            items: [
              ...project.helpers.map(
                (helper): MenuItemSpec => ({
                  label: helper.name,
                  onClick: () => void runHelper(helper, project.id),
                })
              ),
              { type: "separator" },
              {
                label: "Manage helpers…",
                onClick: () => void navigate(settingsFormPath("projects", project.id)),
              },
            ],
          },
        ] satisfies MenuItemSpec[])
      : []),
    { type: "separator" },
    {
      label: "Copy link",
      disabled: descriptor?.kind !== "chat",
      onClick: () => {
        if (descriptor?.kind !== "chat") return
        writeClipboard(new URL(threadPath(descriptor.sessionId), window.location.origin).toString())
          .then(() => toast.success("Link copied"))
          .catch((err) => reportError(err, "Couldn't copy the link"))
      },
    },
  ]

  return (
    <ItemContextMenu items={items}>
      {/* `flex-1`, not `w-full`: in a content-sized tab it does nothing, and in
          the full-width one (`singleTabMode`, dockview grows the tab itself) it
          fills — one rule for both, and no percentage resolved against a parent
          whose width is its child's. */}
      <div className="flex h-full min-w-0 flex-1 items-center py-1">
        <div
          /* The two hooks a tab standing in the app header's band is restyled
             by (`index.css`): in that row it wears the header's frosted ground
             instead of --muted, because everything else on the line is a
             capsule. Published rather than decided here — whether a tab is in
             the band is its *group's* answer, and subscribing a tab to the
             dock's layout to restyle itself would be a second measurement of
             something `workspace/dock.tsx` already knows. */
          data-active={active || undefined}
          className={cn(
            /* `h-8` — the sidebar toggle's own height (`icon-sm`), because
               they stand on the same line: a tab shorter than the control
               beside it reads as a strip tucked under the header rather than
               as the header's own row. The chip is layout and ink; what is
               drawn is the badges inside it (`index.css`), the same way in
               every strip. */
            "panel-tab-chip flex h-8 min-w-0 flex-1 items-center gap-1 rounded-lg px-1 text-xs transition-colors",
            /* Ink only. The ground belongs to the badges inside, in every strip
               (`index.css`) — a chip filled with --muted around capsules that
               have their own surface is two grounds for one tab. */
            active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
          )}
        >
          {/* ── One vocabulary, everywhere ──
              `p-1` is the sidebar toggle's own padding — 4px around a 16px mark
              — so a badge and the button beside it are the same 24px box on the
              same line, which is the difference between one bar of chrome and
              two things that happen to be next to each other. The extra right
              padding is the only asymmetry, and it is the label's: text needs
              room before a 10px corner that an icon, centred in its own square,
              does not.

              A badge per answer, the same shape and the same ground at every
              width: the project this thread runs in, then the thread itself.
              What changes between a phone and a desk is how much of a badge is
              *said*, never how it is drawn — the project keeps its mark and
              drops its name, rather than becoming a different object (it was a
              stacked pair of ringed avatars on one side of `sm` and a row of
              plain icons on the other, which is two designs sharing a
              component). */}
          {project && (
            <span
              data-tab-badge
              className="flex min-w-0 items-center gap-1 rounded-lg p-1 text-muted-foreground sm:pr-2"
            >
              <ProjectIcon project={project} className="size-3.5 shrink-0" />
              <span className="hidden max-w-24 truncate sm:inline">{project.name}</span>
            </span>
          )}
          {/* The thread: its name, and nothing beside it. A chat tab wore its
              runtime's logo, a project logo and a status dot — three marks for
              one line of text, when the thing a reader needs to tell two tabs
              apart is the *name*. A panel that is not a chat keeps its kind's
              glyph: an IDE tab with no mark at all is just a word. */}
          <span
            data-tab-badge
            className="flex min-w-0 items-center gap-1.5 rounded-lg p-1 pr-2"
          >
            {descriptor?.kind !== "chat" && <PanelIcon panel={descriptor} className="size-3.5" />}
            {/* One line, capped, ellipsis past it. Content-sized because a badge
                that stretched to the tab's width drew a frosted bar the length
                of the band for a five-word title: the room a full-width tab has
                is space *after* the name, not a longer name. */}
            <span data-tab-title className="max-w-40 min-w-0 truncate">
              {title}
            </span>
          </span>
          {/* The slack a full-width tab has, as an element rather than as an
              auto margin — because in the band it belongs to the *window*.

              With one tab the strip is the tab (dockview's `singleTabMode`), so
              the run of emptiness a user reaches for to move the window is
              inside it, and a tab has to be `no-drag` to stay pressable. This
              hands that run back: `index.css` marks it a drag region, which
              costs nothing, since the only tab that has slack is the one that
              is already active and a press here activates nothing. */}
          {/* `self-stretch` is load-bearing, not tidiness: the chip centres its
              children, so an empty span is a box of zero height — and Chromium
              builds the window's draggable region out of *rects*, discarding
              anything with no area. The region was being computed correctly and
              was 0px tall. */}
          <span data-tab-space aria-hidden className="min-w-0 flex-1 self-stretch" />
          {/* The badges stay the size of what they say and the slack falls
              before this, so the reading and the close sit at the tab's own end,
              under the app's right gutter, rather than trailing the name. */}
          <span className="flex shrink-0 items-center gap-1">
            {/* The reading of the thread this tab *is*, on every chat tab and
                not only the focused one: how full a context is stays true while
                you are reading something else, and a mark that appears when a
                tab is clicked reads as part of the selection rather than as a
                fact about the thread. */}
            {chatSessionId && <TabContextRing sessionId={chatSessionId} />}
            {/* The same list the right-click opens, on a button of its own.
                A context menu is a gesture you have to already know is there —
                and on a touch screen it is a long-press, which competes with
                the drag that reorders the tab. The ⋮ is how the menu is *found*,
                and it is the app's mark for "more of this thing" wherever one
                is offered; `items` is built once above and both surfaces render
                it, so neither can drift from the other. */}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Actions for ${title}`}
                    className="size-6 rounded-lg text-muted-foreground hover:text-foreground"
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    <MoreVerticalIcon className="size-3.5" />
                  </Button>
                }
              />
              <DropdownMenuContent align="end" className={MENU_WIDTH}>
                {renderMenuItems(items, {
                  Item: DropdownMenuItem,
                  Separator: DropdownMenuSeparator,
                  Sub: DropdownMenuSub,
                  SubTrigger: DropdownMenuSubTrigger,
                  SubContent: DropdownMenuSubContent,
                })}
              </DropdownMenuContent>
            </DropdownMenu>
            {/* A pinned tab trades its close button for the pin that undoes the
                pinning — the same width, and the gesture that got you here is
                the gesture that gets you back. It is why a pinned tab cannot be
                closed by a stray click, which is most of the point of pinning. */}
            {pinned ? (
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Unpin ${title}`}
                className="size-6 rounded-lg text-muted-foreground hover:text-foreground"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation()
                  dock.togglePin(api.id)
                }}
              >
                <PinOffIcon className="size-3" />
              </Button>
            ) : (
              closable && (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Close tab"
                  className="size-6 rounded-lg text-muted-foreground hover:text-foreground"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation()
                    void dock.closePanel(api.id)
                  }}
                >
                  <XIcon className="size-3" />
                </Button>
              )
            )}
          </span>
        </div>
      </div>
    </ItemContextMenu>
  )
}

import { writeClipboard } from "@/lib/clipboard"
