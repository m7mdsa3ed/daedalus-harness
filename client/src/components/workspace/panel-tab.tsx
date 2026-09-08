/* One tab for every panel kind. It replaces Dockview's default tab, which is
   what makes `dock.closePanel` the only way a panel closes — and therefore the
   only place a dirty editor gets asked.

   ── One slab, rounded ──
   The chip is the tab: one rounded surface with air around it, filled when it
   is the panel you are looking at (`index.css`, `.panel-tab-chip`). The capsule
   design that came before drew a ground *per occupant*, which is right for the
   app header's own controls and wrong here — a tab is one object, and three
   frosted pills sharing a line read as three.

   What it draws is deliberately little: the kind's glyph, the title, and the
   close. The project it runs in is NOT among them — it is the composer's scope
   band, where it is a name and not a mark that drops its label below `sm`. The
   context reading is not among them either: it is the composer's footer
   cluster, said once, in front of the thread it is true of. A tab that carried
   it subscribed every strip to a value written on every streamed token.

   A panel's *reading* (`lib/workspace/panel-status`) is on the strip's tab list,
   where a panel you cannot see is the one you need it for. (It is still the
   panel's own answer and never a glyph a panel prefixes onto its title: that
   made the reading part of the title — nothing else could have one, it could not
   be coloured, and a screen reader read it as a stray character.) */
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
import { MENU_WIDTH } from "@/components/menu-row"
import {
  ItemContextMenu,
  renderMenuItems,
  type MenuItemSpec,
} from "@/components/item-context-menu"
import { PanelIcon } from "@/components/workspace/panel-kinds"
import { useDock } from "@/components/workspace/dock"
import { reportError } from "@/lib/errors"
import { useProjects } from "@/lib/queries/catalog"
import { settingsFormPath, threadPath } from "@/lib/router"
import { useSessionMeta } from "@/lib/store"
import { useRunHelper } from "@/lib/workspace/use-run-helper"
import { usePanelPinned } from "@/lib/workspace/panel-pins"
import { PANEL_SPECS, isPanelKind, parsePanel } from "@/lib/workspace/panels"
import { initialsOf } from "@/lib/tasks-view"
import { cn } from "@/lib/utils"

export function PanelTab({ api, containerApi, params }: IDockviewPanelHeaderProps) {
  const dock = useDock()
  const navigate = useNavigate()
  const runHelper = useRunHelper(dock)
  const descriptor = parsePanel(api.component, params)
  /* The thread's row, for the project it belongs to. A row keeps its identity
     unless it changes (see `useSessionMeta`), so this is not a subscription to
     anything a turn writes. */
  const chatSessionId = descriptor?.kind === "chat" ? descriptor.sessionId : ""
  const meta = useSessionMeta(chatSessionId)
  const projects = useProjects()
  /* Not drawn on the face — the composer's scope band says it. Still looked up,
     because "Project commands" below is this thread's project's. */
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

  /* ── Narrow: one title, the rest are marks ──
     On a phone only the tab you are on says its name. Four titles sharing a
     360px strip are four tabs truncated to "Fix th…", which is four identical
     tabs — a mark is short enough to be *whole*, and a whole thing can be told
     apart and pressed. The one you are reading keeps its name, because that is
     the tab whose name you are using.

     None of that is decided here. It is `index.css`, keyed on dockview's own
     `dv-active-tab`/`dv-inactive-tab`, because it has to *animate*: switching
     tabs collapses one title to its mark and opens the other out, and a
     transition needs one element changing rather than two elements swapping. */

  /* One list, two surfaces: the right-click menu (long-press on a touch screen,
     which Base UI's context menu handles) and the ⋮ beside the close. A context
     menu is a gesture you have to already know is there, and on a touch screen
     it competes with the drag that reorders the tab — the ⋮ is how the menu is
     *found*. It costs the tab nothing while you are not pointing at it, because
     it appears on the same terms the close does (`index.css`). */
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
      {/* Air on all four sides: the chip is a rounded surface *in* the strip,
          not a shape cut out of it, so it needs the room its corners imply. The
          0.5rem of side padding is the gap between one tab and the next. */}
      <div className="flex h-full min-w-0 flex-1 items-center px-0.5 py-1">
        <div
          /* The hook the shape hangs off (`index.css`): the radius, and the
             frosted ground the active tab takes. Published rather than decided
             here — whether a tab is in the app header's band is its *group's*
             answer, and subscribing a tab to the dock's layout to restyle itself
             would be a second measurement of something `workspace/dock.tsx`
             already knows. */
          data-active={active || undefined}
          title={title}
          className={cn(
            /* `h-8` — the height of the sidebar toggle and the view-settings
               sliders beside it (`HEADER_CHIP`), because in the header's band
               all three stand on the same line: a tab shorter than the controls
               next to it reads as a strip tucked under the header rather than
               as the header's own row. */
            "panel-tab-chip flex h-8 min-w-0 flex-1 items-center gap-1.5 px-2.5 text-xs transition-colors",
            active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
          )}
        >
          {/* A chat tab carries no mark. It wore its runtime's logo, a project
              logo and a status dot — three marks for one line of text, when the
              thing a reader needs to tell two tabs apart is the *name*. Every
              other kind keeps its glyph: an IDE tab with no mark is just a
              word. */}
          {descriptor?.kind !== "chat" && (
            <PanelIcon panel={descriptor} className="size-3.5 shrink-0" />
          )}
          {/* ── The mark a narrow tab shrinks to ──
              Drawn always and *hidden by CSS* off the phone, rather than
              swapped in by a `useIsMobile()` branch here. That branch was the
              whole reason the change could not be animated: React replaced one
              element with another, and there is nothing for a transition to
              interpolate between two different nodes. Both live in the DOM now,
              and `index.css` collapses whichever one this tab is not — which is
              a width and an opacity, both of which animate.

              Only a chat needs one: every other kind has its glyph above, and
              that glyph *is* its mark. */}
          {descriptor?.kind === "chat" && (
            <span data-tab-mark aria-hidden className="grid place-items-center overflow-hidden">
              <span className="text-[10px] font-semibold tracking-tight">{initialsOf(title)}</span>
            </span>
          )}
          <span data-tab-title className="min-w-0 flex-1 truncate">
            {title}
          </span>
          {/* Kept in the DOM on a narrow tab too, and hidden by the same rule:
              they are what the tab shrinks *past*, and unmounting them would
              make the width jump a step before the transition started. */}
          {/* The same list the right-click opens, on a button of its own — and
              `items` is built once above, so the two surfaces cannot drift. */}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  data-tab-action="menu"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Actions for ${title}`}
                  className="size-5 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
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
          {/* A pinned tab trades its close for the pin that undoes the pinning —
              the same width, and the gesture that got you here gets you back. It
              is why a pinned tab cannot be closed by a stray click, which is
              most of the point of pinning. It is also the one control that is
              always drawn: it is a *state*, not an action, and a pin that only
              appeared on hover would leave a pinned tab looking like any other. */}
          {pinned ? (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Unpin ${title}`}
              className="size-5 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
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
              /* Shown on the active tab and on hover, and on a touch screen
                 always (`index.css`) — a browser's rule, and the reason a tab
                 with a long title spends its width on the title. It stays in the
                 DOM either way so the title's truncation does not shift under
                 the pointer, and `:focus-visible` brings it back for a keyboard. */
              <Button
                data-tab-action="close"
                size="icon-xs"
                variant="ghost"
                aria-label="Close tab"
                className="size-5 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
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
        </div>
      </div>
    </ItemContextMenu>
  )
}

import { writeClipboard } from "@/lib/clipboard"
