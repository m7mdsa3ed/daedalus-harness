/* ── Settings sections, declared once ──
   The one table the settings screen is read off: the sidebar nav, the
   overview, the palette, each page's header *and* the `<Route>`s under
   /settings (`components/routes.tsx` maps this array). Adding a section is
   one entry here plus its row in `SETTINGS_NAV_GROUPS` below; there used to be
   a second hand-kept list of pages beside the routes, and a forgotten entry
   was a nav row that redirected straight back to the overview.

   `id` is the section id *and* the URL segment (`/settings/<id>`) — the two
   have never differed, and the route tree relies on that. `page` is the lazy
   list page; `sub` are the routes that hang off it — its import screen and its
   form — with paths relative to it, declared as siblings because that is what
   they are: the list page is not their layout. Route *declaration* order
   carries no meaning: React Router ranks by specificity, so `mcp/import` beats
   `mcp/:entryId` wherever either stands.

   ── Why `page` is a lazy binding and still here ──
   The pages are chunks (see the top of `routes.tsx`): a static import of one
   anywhere in the shell pulls it into the entry chunk. `lazyPage` is a dynamic
   import, so this module — which the sidebar and the palette load eagerly —
   costs one small closure per page and nothing more. The pages import this
   module back for their headers (`sectionMeta`); a dynamic edge closing that
   loop is harmless. */
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
  Lightbulb,
  Sparkles,
  SquareSlash,
  ScrollText,
  type LucideIcon,
} from "lucide-react"

import { lazyPage } from "@/lib/lazy-page"

export const SETTINGS_SECTIONS = [
  {
    id: "general",
    page: lazyPage(() => import("./general"), "GeneralPage"),
    label: "General",
    icon: Server,
    title: "General",
    description:
      "The harness servers this device knows and which one it talks to, plus the device side of the install: whether the app is installed, what the browser makes of the page's security, and the site data it keeps.",
  },
  {
    id: "ai",
    page: lazyPage(() => import("./ai"), "AiPage"),
    label: "AI helpers",
    icon: Sparkles,
    title: "AI helpers",
    description:
      "The model calls the harness makes for you rather than as a thread: rewriting a draft prompt, drafting a commit message, naming a branch. Each picks its own profile and model, kept on this device; each is one completion on the server, never a turn on a thread's agent, and the key never leaves the server.",
  },
  {
    id: "appearance",
    page: lazyPage(() => import("./appearance"), "AppearancePage"),
    /* The theme editor is its own chunk rather than Appearance's: it is the
       single largest page in the app, and Appearance is a section someone
       opens to change the mode. Appearance imports the gallery from the same
       directory (`theme-builder/gallery`), never the editor. */
    sub: [
      { path: "themes/:themeId", page: lazyPage(() => import("@/components/theme-builder/editor"), "ThemeEditorPage") },
    ],
    label: "Appearance",
    icon: Palette,
    title: "Appearance",
    description: "How the harness looks. Your custom themes are saved on the server and followed across devices; the light/dark mode, font size, spacing and Windows window material are device settings.",
  },
  {
    id: "notifications",
    page: lazyPage(() => import("./notifications"), "NotificationsPage"),
    label: "Notifications",
    icon: Bell,
    title: "Notifications",
    description:
      "What interrupts you on this device when something happens in a thread you're not looking at. Stored locally, never synced.",
  },
  {
    id: "keyboard",
    page: lazyPage(() => import("./keyboard"), "KeyboardPage"),
    label: "Keyboard",
    icon: Keyboard,
    title: "Keyboard shortcuts",
    description:
      "Every key the harness binds, and what it does about the keys something else already wanted. Stored on this device, never synced.",
  },
  {
    id: "projects",
    page: lazyPage(() => import("./projects"), "ProjectsPage"),
    sub: [
      { path: ":entryId", page: lazyPage(() => import("./projects"), "ProjectFormPage") },
    ],
    label: "Projects",
    icon: FolderIcon,
    title: "Projects",
    description:
      "A project is the workspace a thread runs in: a directory on the server and a name. What a thread brings into it comes from its profile and its own picks.",
  },
  {
    id: "knowledge",
    page: lazyPage(() => import("./knowledge"), "KnowledgePage"),
    label: "Knowledge base",
    icon: BookOpen,
    title: "Knowledge base",
    description:
      "Everything the agents have written to the per-project knowledge base through the built-in knowledge MCP server, across all projects.",
  },
  {
    id: "mcp",
    page: lazyPage(() => import("./mcp"), "McpPage"),
    sub: [
      { path: "import", page: lazyPage(() => import("./mcp"), "McpImportPage") },
      { path: "browse", page: lazyPage(() => import("./mcp"), "McpBrowsePage") },
      /* A chunk of its own: the playground and the schema rendering are a
         page somebody navigates to, and the library list must not carry them. */
      { path: "playground", page: lazyPage(() => import("./mcp-detail"), "McpPlaygroundPage") },
      { path: ":entryId/tools", page: lazyPage(() => import("./mcp-detail"), "McpDetailPage") },
      { path: ":entryId", page: lazyPage(() => import("./mcp"), "McpFormPage") },
    ],
    label: "MCP servers",
    icon: Plug,
    title: "MCP servers",
    description:
      "Reusable MCP server definitions. Attach them to a profile, or pick them on a new thread; the server sends them to the agent in ACP session/new.",
  },
  {
    id: "skills",
    page: lazyPage(() => import("./skills"), "SkillsPage"),
    sub: [
      { path: "import", page: lazyPage(() => import("./skills"), "SkillImportPage") },
      { path: ":entryId", page: lazyPage(() => import("./skills"), "SkillFormPage") },
    ],
    label: "Skills",
    icon: Sparkles,
    title: "Skills",
    description:
      "Reusable skill directories on the server. Attach them to a profile, or pick them on a new thread; they are symlinked into <cwd>/.claude/skills at spawn.",
  },
  {
    id: "commands",
    page: lazyPage(() => import("./commands"), "CommandsPage"),
    sub: [
      { path: "import", page: lazyPage(() => import("./commands"), "CommandImportPage") },
      { path: ":entryId", page: lazyPage(() => import("./commands"), "CommandFormPage") },
    ],
    label: "Commands",
    icon: SquareSlash,
    title: "Slash commands",
    description:
      "Reusable prompts invoked as /name from the composer. Attach them to a profile, or pick them on a new thread; they are written into <cwd>/.claude/commands at spawn and the agent advertises them like its own.",
  },
  {
    id: "rules",
    page: lazyPage(() => import("./rules"), "RulesPage"),
    label: "Rules",
    icon: ScrollText,
    title: "Rules",
    description:
      "Standing instructions every thread starts with — one global block, plus a per-project block edited with the project. The server folds them into each spawn beneath the persona, through the door the runtime already opens for instructions, so nothing is pasted in front of your messages.",
  },
  {
    id: "personas",
    page: lazyPage(() => import("./personas"), "PersonasPage"),
    /* No import route: nothing in the agents' own configs is a persona to
       import — see settings/personas.tsx. */
    sub: [
      { path: ":entryId", page: lazyPage(() => import("./personas"), "PersonaFormPage") },
    ],
    label: "Personas",
    icon: Drama,
    title: "Personas",
    description:
      "How a thread wants to be worked on: a block of instructions appended to the agent's own system prompt, plus an optional thinking budget and effort. A thread picks one in its settings menu; the server hands it to each runtime through the door that runtime opens for it, so nothing is smuggled into your messages.",
  },
  {
    id: "model-prompts",
    page: lazyPage(() => import("./model-prompts"), "ModelPromptsPage"),
    sub: [
      { path: ":entryId", page: lazyPage(() => import("./model-prompts"), "ModelPromptFormPage") },
    ],
    label: "Model prompts",
    icon: Lightbulb,
    title: "Model prompts",
    description:
      "Instruction text assigned to a model by id or pattern, so a thread running Gemini is told it is Gemini and Qwen is told what Qwen needs. A row whose match is a glob wins over the runtime's built-in family calibrations; the file is re-read every turn, so a live model change swaps the guidance with no respawn.",
  },
  {
    id: "profiles",
    page: lazyPage(() => import("./profiles"), "ProfilesPage"),
    sub: [
      { path: ":entryId", page: lazyPage(() => import("./profiles"), "ProfileFormPage") },
    ],
    label: "Profiles",
    icon: KeyRound,
    title: "Profiles",
    description: "A profile is the agent configuration a thread runs with: runtime, credentials and models.",
  },
  {
    id: "agents",
    page: lazyPage(() => import("./agents"), "AgentsPage"),
    label: "Agents",
    icon: Cpu,
    title: "Agents",
    description: "ACP runtimes registered on the server (data/agents.json).",
  },
  {
    id: "usage",
    page: lazyPage(() => import("./quota"), "QuotaPage"),
    label: "Usage",
    icon: Gauge,
    title: "Plan usage",
    description:
      "What is left of the subscription each runtime is spending — the numbers Claude Code's /usage and Codex's /status report, read on the server. A profile that runs on an API key has no plan limits, and says so.",
  },
  {
    id: "backup",
    page: lazyPage(() => import("./backup"), "BackupPage"),
    label: "Backup",
    icon: DatabaseBackup,
    title: "Backup",
    description:
      "Export everything this server stores as one JSON file, or restore one — profiles, projects, the library, knowledge, threads, schedules, tasks and the web-search backend.",
  },
  {
    id: "web-search",
    page: lazyPage(() => import("./web-search"), "WebSearchPage"),
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

/** URL segment → a section that exists. `null` is the overview (`/settings`
    itself) and every segment that names nothing — the route tree redirects
    those to the overview, so nothing lights up on the way. */
export const sectionOf = (segment: string): SettingsSectionId | null =>
  SETTINGS_SECTIONS.find((s) => s.id === segment)?.id ?? null

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

/** A settings page that takes the whole frame — and, with it, no section rail:
    the studio is already two columns and a third is what makes neither fit. */
export const isFullWidthSettings = (pathname: string): boolean =>
  FULL_WIDTH_SETTINGS.some((pattern) => pattern.test(pathname))

export const SETTINGS_NAV_GROUPS: readonly {
  label: string
  sections: readonly SettingsSectionId[]
}[] = [
  { label: "Preferences", sections: ["general", "appearance", "keyboard", "notifications", "ai", "web-search"] },
  { label: "Workspace", sections: ["projects", "knowledge", "mcp", "skills", "commands", "rules", "personas", "model-prompts"] },
  { label: "Agents", sections: ["profiles", "agents", "usage"] },
  { label: "Server", sections: ["backup"] },
] as const
