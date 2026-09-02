/* ── Settings sections ──
   The metadata both sides of the settings screen share: the sidebar nav
   (app-shell) and each page's header. Every section is its own route —
   /settings/<id> — with its page component in this directory; register new
   sections here and add a <Route> in app-shell's route tree. */
import {
  Bell,
  BookOpen,
  Cpu,
  DatabaseBackup,
  FolderIcon,
  Gauge,
  Keyboard,
  KeyRound,
  Palette,
  Plug,
  Search,
  Server,
  Settings2,
  Drama,
  Sparkles,
  SquareSlash,
  type LucideIcon,
} from "lucide-react"

export const SETTINGS_SECTIONS = [
  {
    id: "general",
    label: "General",
    icon: Server,
    title: "General",
    description:
      "The harness servers this device knows and which one it talks to, plus the device side of the install: whether the app is installed, what the browser makes of the page's security, and the site data it keeps.",
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
    id: "keyboard",
    label: "Keyboard",
    icon: Keyboard,
    title: "Keyboard shortcuts",
    description:
      "Every key the harness binds, and what it does about the keys something else already wanted. Stored on this device, never synced.",
  },
  {
    id: "projects",
    label: "Projects",
    icon: FolderIcon,
    title: "Projects",
    description:
      "A project is the workspace a thread runs in: a directory on the server and a name. What a thread brings into it comes from its profile and its own picks.",
  },
  {
    id: "knowledge",
    label: "Knowledge base",
    icon: BookOpen,
    title: "Knowledge base",
    description:
      "Everything the agents have written to the per-project knowledge base through the built-in knowledge MCP server, across all projects.",
  },
  {
    id: "mcp",
    label: "MCP servers",
    icon: Plug,
    title: "MCP servers",
    description:
      "Reusable MCP server definitions. Attach them to a profile, or pick them on a new thread; the server sends them to the agent in ACP session/new.",
  },
  {
    id: "skills",
    label: "Skills",
    icon: Sparkles,
    title: "Skills",
    description:
      "Reusable skill directories on the server. Attach them to a profile, or pick them on a new thread; they are symlinked into <cwd>/.claude/skills at spawn.",
  },
  {
    id: "commands",
    label: "Commands",
    icon: SquareSlash,
    title: "Slash commands",
    description:
      "Reusable prompts invoked as /name from the composer. Attach them to a profile, or pick them on a new thread; they are written into <cwd>/.claude/commands at spawn and the agent advertises them like its own.",
  },
  {
    id: "personas",
    label: "Personas",
    icon: Drama,
    title: "Personas",
    description:
      "How a thread wants to be worked on: a block of instructions appended to the agent's own system prompt, plus an optional thinking budget and effort. A thread picks one in its settings menu; the server hands it to each runtime through the door that runtime opens for it, so nothing is smuggled into your messages.",
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
    id: "usage",
    label: "Usage",
    icon: Gauge,
    title: "Plan usage",
    description:
      "What is left of the subscription each runtime is spending — the numbers Claude Code's /usage and Codex's /status report, read on the server. A profile that runs on an API key has no plan limits, and says so.",
  },
  {
    id: "backup",
    label: "Backup",
    icon: DatabaseBackup,
    title: "Backup",
    description:
      "Export everything this server stores as one JSON file, or restore one — profiles, projects, the library, knowledge, threads, schedules, tasks and the web-search backend.",
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

/* The index page (`/settings`, components/settings/overview.tsx) is not a
   section — it has no sidebar row, and the palette does not list it beside
   the sections — but it has a header like one, so it carries the same shape. */
export const SETTINGS_OVERVIEW: PageMeta & { label: string; icon: LucideIcon } = {
  label: "Settings",
  icon: Settings2,
  title: "Settings",
  description:
    "Everything this device and this server can be configured with, in one place. Preferences stay on this device; the workspace, agents and server sections are the server's.",
}

/** What a page header needs — every section has it; so does the overview. */
export type PageMeta = { title: string; description: string }

export const sectionMeta = (id: SettingsSectionId): SectionMeta =>
  SETTINGS_SECTIONS.find((s) => s.id === id) ?? SETTINGS_SECTIONS[0]

/* ── How wide a settings page may get ──
   One column width for the whole section, set by the layout, because a page
   choosing its own would mean the frame jumping width as you move between
   them. The default is the reading width for a form: wide enough for a label
   beside its control and a two-up grid, narrow enough that a line of body copy
   does not run past what an eye tracks back from (page headers additionally
   clamp their prose at 65ch).

   A handful of pages are not forms. The theme studio is two columns — controls
   beside a sticky preview of the app — and at a form's width neither half has
   room: the preview shrinks to a thumbnail and the colour grid wraps its
   light/dark pair onto separate lines, which is the one comparison the whole
   screen exists to make. Those get the full width of the frame.

   Matched on the pathname rather than declared per route because the layout is
   what renders the container and it only knows the location; keeping the list
   here rather than in layout.tsx keeps route facts in the module that already
   owns them. */
const FULL_WIDTH_SETTINGS: readonly RegExp[] = [/^\/settings\/appearance\/themes\//]

export const settingsMaxWidth = (pathname: string): string =>
  FULL_WIDTH_SETTINGS.some((pattern) => pattern.test(pathname)) ? "max-w-none" : "max-w-5xl"

export const SETTINGS_NAV_GROUPS: readonly {
  label: string
  sections: readonly SettingsSectionId[]
}[] = [
  { label: "Preferences", sections: ["general", "appearance", "keyboard", "notifications", "web-search"] },
  { label: "Workspace", sections: ["projects", "knowledge", "mcp", "skills", "commands", "personas"] },
  { label: "Agents", sections: ["profiles", "agents", "usage"] },
  { label: "Server", sections: ["backup"] },
] as const
