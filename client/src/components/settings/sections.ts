/* ── Settings sections ──
   The metadata both sides of the settings screen share: the sidebar nav
   (app-shell) and each page's header. Every section is its own route —
   /settings/<id> — with its page component in this directory; register new
   sections here and add a <Route> in app-shell's route tree. */
import {
  Bell,
  Cpu,
  FolderIcon,
  KeyRound,
  Palette,
  Plug,
  Search,
  Server,
  Sparkles,
  SquareSlash,
} from "lucide-react"

export const SETTINGS_SECTIONS = [
  {
    id: "general",
    label: "General",
    icon: Server,
    title: "Connection",
    description:
      "The harness server this client talks to. Projects, profiles and agents live there, shared by every connected client.",
  },
  {
    id: "appearance",
    label: "Appearance",
    icon: Palette,
    title: "Appearance",
    description: "How the harness looks on this device. Stored locally, never synced.",
  },
  {
    id: "notifications",
    label: "Notifications",
    icon: Bell,
    title: "Notifications",
    description:
      "What interrupts you on this device when something happens in a thread you're not looking at. Stored locally, never synced.",
  },
  {
    id: "projects",
    label: "Projects",
    icon: FolderIcon,
    title: "Projects",
    description:
      "A project is the workspace a thread runs in: directory, MCP servers and skills.",
  },
  {
    id: "mcp",
    label: "MCP servers",
    icon: Plug,
    title: "MCP servers",
    description:
      "Reusable MCP server definitions. Attach them to a project; the client sends them to the agent in ACP session/new.",
  },
  {
    id: "skills",
    label: "Skills",
    icon: Sparkles,
    title: "Skills",
    description:
      "Reusable skill directories on the server. Attach them to a project; they are symlinked into <cwd>/.claude/skills at spawn.",
  },
  {
    id: "commands",
    label: "Commands",
    icon: SquareSlash,
    title: "Slash commands",
    description:
      "Reusable prompts invoked as /name from the composer. Attach them to a project; they are written into <cwd>/.claude/commands at spawn and the agent advertises them like its own.",
  },
  {
    id: "profiles",
    label: "Profiles",
    icon: KeyRound,
    title: "Profiles",
    description: "A profile is the agent configuration a thread runs with: runtime, credentials and models.",
  },
  {
    id: "agents",
    label: "Agents",
    icon: Cpu,
    title: "Agents",
    description: "ACP runtimes registered on the server (data/agents.json).",
  },
  {
    id: "web-search",
    label: "Web search",
    icon: Search,
    title: "Web search",
    description:
      "The default search/fetch backend the harness's own web-search MCP server answers against. Profiles can override it.",
  },
] as const

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"]
export type SectionMeta = (typeof SETTINGS_SECTIONS)[number]

export const sectionMeta = (id: SettingsSectionId): SectionMeta =>
  SETTINGS_SECTIONS.find((s) => s.id === id) ?? SETTINGS_SECTIONS[0]

export const SETTINGS_NAV_GROUPS: readonly {
  label: string
  sections: readonly SettingsSectionId[]
}[] = [
  { label: "Preferences", sections: ["general", "appearance", "notifications", "web-search"] },
  { label: "Workspace", sections: ["projects", "mcp", "skills", "commands"] },
  { label: "Agents", sections: ["profiles", "agents"] },
] as const
