/* ── A dock inside a tab ──
   The `group` panel kind: a second dockview instance drawn where a panel's
   content goes, holding its own strip of tabs. Dockview supports this as
   "nested instances" — the outer knows nothing about the inner except through
   the two doors this file uses: the inner's layout is written back onto the
   panel's params (which is what makes the outer's own debounced save carry
   it, since a params change is a layout change to dockview), and the dock
   registers the inner api so every walk of "the panels that are open" sees
   through the tab (`attachNested` in `dock.tsx`).

   The same components, the same tab, the same strip (`DockSurface`): a tab in
   a group is the same object it was outside one, only drawn one card in. */
import * as React from "react"
import type { DockviewApi, IDockviewPanelProps } from "dockview-react"

import { DockSurface, useDock } from "@/components/workspace/dock"
import { parsePanel } from "@/lib/workspace/panels"

export function GroupPanel({ api, containerApi }: IDockviewPanelProps) {
  const dock = useDock()
  const detachRef = React.useRef<(() => void) | null>(null)

  const handleReady = React.useCallback(
    (nested: DockviewApi) => {
      detachRef.current?.()
      /* The layout as it stands *now*, read off dockview's own panel object and
         not off this component's props. DockviewReact builds its instance in a
         mount effect and disposes it on cleanup, and React's StrictMode runs
         that pair twice in development: the first instance is created, given
         the tab that was moved in, and thrown away, and the second is created
         before the params change the first one wrote has reached these props —
         so read from props it came up empty, and the moved tab was gone. The
         panel's `params` are updated synchronously by `updateParameters`, so
         they hold what the first instance persisted. A theme change remounts
         the same way, for the same reason. */
      const descriptor = parsePanel("group", containerApi.getPanel(api.id)?.params)
      const layout = descriptor?.kind === "group" ? descriptor.layout : undefined
      if (layout) {
        try {
          nested.fromJSON(layout)
        } catch (error) {
          /* Pruned on the way in like the outer one, so a throw is the grid
             itself. An empty group closes itself once it is attached. */
          console.warn("Could not restore the group's layout", error)
          nested.clear()
        }
      }
      detachRef.current = dock.attachNested(api.id, nested)
    },
    [dock, api.id, containerApi]
  )

  React.useEffect(
    () => () => {
      detachRef.current?.()
      detachRef.current = null
    },
    []
  )

  /* Hidden outright while its tab is not the one in front. Dockview hides an
     inactive panel's render overlay with `visibility`, and the inner dock's
     own overlays escaped it and drew over the outer group's other tabs;
     `display: none` has no inheritance to escape. */
  const [visible, setVisible] = React.useState(api.isVisible)
  React.useEffect(() => {
    setVisible(api.isVisible)
    const sub = api.onDidVisibilityChange((event) => setVisible(event.isVisible))
    return () => sub.dispose()
  }, [api])

  return (
    <DockSurface
      className={visible ? "dock-nested" : "dock-nested hidden"}
      onReady={handleReady}
    />
  )
}
