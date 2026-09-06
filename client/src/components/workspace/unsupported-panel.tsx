import type { IDockviewPanelProps } from "dockview-react"
import { PackageOpenIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useDock } from "@/components/workspace/dock"
import { PanelEmptyState } from "@/components/workspace/primitives"
import { PANEL_SPECS, isPanelKind } from "@/lib/workspace/panels"

/**
 * A panel this build cannot draw.
 *
 * Two ways to get here, and they deserve the same treatment: a kind that is
 * declared but not built yet, and a layout restored from a newer build. Neither
 * is an error the user caused, and neither should cost them the rest of the
 * workspace — so the panel says what it is and offers the one useful action.
 */
export function UnsupportedPanel({ api }: IDockviewPanelProps) {
  const dock = useDock()
  const kind = api.component
  const name = isPanelKind(kind) ? PANEL_SPECS[kind].defaultTitle : kind

  return (
    <PanelEmptyState className="text-foreground">
      <PackageOpenIcon className="size-6 text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-sm font-medium">{name} isn't available in this version</p>
        <p className="text-xs text-muted-foreground">
          This panel was saved by a build that has it. Everything else in the workspace is fine.
        </p>
      </div>
      <Button size="sm" variant="outline" onClick={() => void dock.closePanel(api.id)}>
        Close panel
      </Button>
    </PanelEmptyState>
  )
}
