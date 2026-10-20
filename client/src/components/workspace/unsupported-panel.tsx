import type { IDockviewPanelProps } from "dockview-react"
import { PackageOpenIcon } from "lucide-react"

import { Empty } from "@/components/empty"
import { Button } from "@/components/ui/button"
import { useDock } from "@/components/workspace/dock-context"
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
    <div className="flex h-full min-h-0 items-center justify-center p-2.5">
      <Empty
        size="lg"
        icon={PackageOpenIcon}
        className="max-w-md text-foreground"
        action={
          <Button size="sm" variant="outline" onClick={() => void dock.closePanel(api.id)}>
            Close panel
          </Button>
        }
      >
        <span className="block font-medium">{name} isn't available in this version</span>
        <span className="mt-1 block text-xs text-muted-foreground">
          This panel was saved by a build that has it. Everything else in the workspace is fine.
        </span>
      </Empty>
    </div>
  )
}
