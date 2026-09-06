/* Icons and chrome per panel kind. Kept beside the registry rather than inside
   `lib/workspace/panels.ts`, which stays a pure storage schema — a serialized
   layout has no business importing a component. */
import {
  CodeIcon,
  GlobeIcon,
  MessageSquareIcon,
  SquareKanbanIcon,
  SquareTerminalIcon,
  type LucideIcon,
} from "lucide-react"

import { AgentIcon } from "@/components/entity-icon"
import { useSessionMeta } from "@/lib/store"
import { cn } from "@/lib/utils"
import type { PanelDescriptor, PanelKind } from "@/lib/workspace/panels"

/** What a *kind* looks like — the answer where there is no instance to ask
    about, which is the "open a panel" menu. An open panel is `PanelIcon`. */
export const PANEL_ICONS: Record<PanelKind, LucideIcon> = {
  chat: MessageSquareIcon,
  ide: CodeIcon,
  terminal: SquareTerminalIcon,
  web: GlobeIcon,
  tasks: SquareKanbanIcon,
}

/**
 * The mark an **open** panel wears.
 *
 * A chat panel is a thread, and a thread's face is its agent's — the same mark
 * the sidebar row and the thread card draw (`entity-icon.tsx`, from the
 * server's `AgentDef.icon`). Every chat tab wearing one speech bubble made a
 * split dock of four threads four identical tabs, and told you nothing the
 * title did not; with the agent's mark a tab and its sidebar row are visibly
 * the same thing.
 *
 * Every other kind *is* its kind — an IDE is an IDE — so it keeps the kind
 * glyph above.
 */
export function PanelIcon({
  panel,
  className = "size-3.5",
}: {
  panel: PanelDescriptor | null
  className?: string
}) {
  /* Unconditional, because a hook is: a non-chat panel asks for a session that
     does not exist and gets nothing, which is the same answer as not asking. */
  const meta = useSessionMeta(panel?.kind === "chat" ? panel.sessionId : "")
  if (!panel) return null
  if (panel.kind === "chat")
    return <AgentIcon agentId={meta?.agentId} className={cn("shrink-0", className)} />
  const Icon = PANEL_ICONS[panel.kind]
  return <Icon className={cn("shrink-0", className)} />
}
