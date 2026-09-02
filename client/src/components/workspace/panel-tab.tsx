/* One tab for every panel kind. It replaces Dockview's default tab, which is
   what makes `dock.closePanel` the only way a panel closes — and therefore the
   only place a dirty editor gets asked. */
import * as React from "react"
import type { IDockviewPanelHeaderProps } from "dockview-react"
import { XIcon } from "lucide-react"
import { toast } from "@/lib/toast"

import { Button } from "@/components/ui/button"
import { ItemContextMenu, type MenuItemSpec } from "@/components/item-context-menu"
import { PANEL_ICONS } from "@/components/workspace/panel-kinds"
import { useDock } from "@/components/workspace/dock"
import { reportError } from "@/lib/errors"
import { threadPath } from "@/lib/router"
import { PANEL_SPECS, isPanelKind, parsePanel } from "@/lib/workspace/panels"
import { cn } from "@/lib/utils"

export function PanelTab({ api, containerApi, params }: IDockviewPanelHeaderProps) {
  const dock = useDock()
  const [active, setActive] = React.useState(api.isActive)
  const [closable, setClosable] = React.useState(false)
  const [hasOthers, setHasOthers] = React.useState(false)
  const [hasRightward, setHasRightward] = React.useState(false)

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

  const descriptor = parsePanel(api.component, params)
  const Icon = isPanelKind(api.component) ? PANEL_ICONS[api.component] : null
  const fallbackTitle = isPanelKind(api.component) ? PANEL_SPECS[api.component].defaultTitle : "Panel"

  const items: MenuItemSpec[] = [
    { label: "Close", disabled: !closable, onClick: () => void dock.closePanel(api.id) },
    { label: "Close others", disabled: !hasOthers, onClick: () => void dock.closeOthers(api.id) },
    {
      label: "Close to the right",
      disabled: !hasRightward,
      onClick: () => void dock.closeToTheRight(api.id),
    },
    { label: "Close group", disabled: !hasOthers, onClick: () => void dock.closeGroup(api.id) },
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
      <div className="flex h-full items-center py-1">
        <div
          className={cn(
            "flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-xs transition-colors",
            active
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          )}
        >
          {Icon && <Icon className="size-3.5 shrink-0" />}
          <span className="max-w-40 truncate">{api.title ?? fallbackTitle}</span>
          {closable && (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Close tab"
              className="-mr-1 size-5 opacity-60 hover:opacity-100"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                void dock.closePanel(api.id)
              }}
            >
              <XIcon className="size-3" />
            </Button>
          )}
        </div>
      </div>
    </ItemContextMenu>
  )
}
import { writeClipboard } from "@/lib/clipboard"
