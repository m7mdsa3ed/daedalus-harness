/* The workspace's modes and its one horizontal inset: plain data, no JSX, so
   the toolbar, the rail, the switcher and the save-view dialog name a layout
   the same way. */
import { CalendarDays, ChartGantt, List, Rocket, SquareKanban, Table2, type LucideIcon } from "lucide-react"

import type { ViewKind } from "@/lib/boards"

export type WorkspaceMode = ViewKind | "sprints"

export const MODES: { id: WorkspaceMode; label: string; icon: LucideIcon }[] = [
  { id: "board", label: "Board", icon: SquareKanban },
  { id: "list", label: "List", icon: List },
  { id: "table", label: "Table", icon: Table2 },
  { id: "calendar", label: "Calendar", icon: CalendarDays },
  { id: "timeline", label: "Timeline", icon: ChartGantt },
  { id: "sprints", label: "Sprints", icon: Rocket },
]

export const modeLabel = (id: WorkspaceMode | string) => MODES.find((m) => m.id === id)?.label ?? id

/** The header, tab bar, toolbar, pills and every view's content share it. */
export const INSET_X = "px-3 @panel-sm:px-4 @panel-lg:px-6"
