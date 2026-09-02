/* Icons and chrome per panel kind. Kept beside the registry rather than inside
   `lib/workspace/panels.ts`, which stays a pure storage schema — a serialized
   layout has no business importing a component. */
import {
  CodeIcon,
  GlobeIcon,
  MessageSquareIcon,
  SquareTerminalIcon,
  type LucideIcon,
} from "lucide-react"

import type { PanelKind } from "@/lib/workspace/panels"

export const PANEL_ICONS: Record<PanelKind, LucideIcon> = {
  chat: MessageSquareIcon,
  ide: CodeIcon,
  terminal: SquareTerminalIcon,
  web: GlobeIcon,
}
