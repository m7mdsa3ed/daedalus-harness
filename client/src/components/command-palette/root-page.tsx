/* ── The root list: commands, and only commands ──
   Everything here is answered from memory — the store, localStorage and the
   dock. Nothing on this page fetches, which is the point of it: the palette
   used to run a debounced full-text search against the server on every
   keystroke *while* filtering the command list, so the fast half of the list
   redrew on the slow half's clock and "Toggle the sidebar" was ranked against
   somebody's message from last Tuesday. Searching is a page of its own now
   (`search-page.tsx`), reached by a command like any other.

   It is still not a second source of truth: every row calls the same
   navigate()/actions the sidebar and composer call, so a command cannot drift
   from the control next to it. The palette only decides what is *offered*, and
   it offers a command only when it would actually work — no "Change model"
   without a session, no "Revive" on a live agent.

   Two rows are about whatever is typed rather than about themselves: "Search
   for “…”" and "Ask a new thread — “…”". Both are `rank: "bottom"`, so a query
   that names a real command never loses ↵ to them, and a query that names
   nothing falls through to Search first — the cheap, reversible one — with the
   one that spawns an agent below it and on ⌘↵. */
import * as React from "react"
import {
  AppWindowIcon,
  ChevronLeft,
  ChevronRight,
  SquareKanbanIcon,
  Copy,
  Cpu,
  DownloadIcon,
  FolderIcon,
  FolderPlus,
  Gauge,
  Keyboard,
  LogOut,
  MessageSquarePlusIcon,
  Minus,
  Monitor,
  MonitorIcon,
  Moon,
  Palette as PaletteIcon,
  PanelLeft,
  PanelRightIcon,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  RotateCw,
  SearchIcon,
  ServerIcon,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  SquareKanban,
  SquareTerminalIcon,
  Sun,
  Trash2,
  Zap,
} from "lucide-react"
import { useNavigate } from "react-router"

import { useConfirm } from "@/components/confirm-dialog"
import { AgentIcon, ProjectIcon } from "@/components/entity-icon"
import { SETTINGS_SECTIONS } from "@/components/settings/sections"
import { useSidebar } from "@/components/ui/sidebar"
import { useIsMobile } from "@/hooks/use-device"
import { SECTION_META } from "@/components/right-panel/right-panel"
import { useRouteScope } from "@/components/right-panel/scope-dock"
import { openSection, rightSheet, sectionsFor, toggleRightPanel } from "@/lib/right-panel"
import { openTerminal } from "@/lib/workspace/open-terminal"
import { adjacentThread, useActiveChat } from "@/lib/workspace/open-threads"
import { HOME_PROJECT_ID } from "@/lib/workspace/panels"
import { reportError } from "@/lib/errors"
import { currentChoiceLabel } from "@/lib/session-options"
import { requestComposerFocus } from "@/lib/composer-focus"
import { useKeybindings } from "@/lib/keybindings"
import { KEYS } from "@/lib/shortcuts"
import { boardPath, newRoutinePath, settingsPath, settingsRootPath, threadPath } from "@/lib/router"
import { runShortcut } from "@/hooks/use-hotkey"
import {
  activityAt,
  clearSettings,
  isListed,
  loadServers,
  loadSettings,
  setActiveServer,
} from "@/lib/settings"
import { useAgents, useProfiles, useProjects } from "@/lib/queries/catalog"
import { recordPaletteCommand, usePaletteRecents } from "@/lib/palette-recents"
import { usePins } from "@/lib/pins"
import { emptyDefaults, loadThreadDefaults, resolveThreadStart } from "@/lib/thread-defaults"
import { useRoutines } from "@/lib/queries/routines"
import { useLiveTurnActive, useStoreSelect } from "@/lib/store"
import { toast } from "@/lib/toast"
import { usePrompt } from "@/components/prompt-dialog"
import { FONT_SIZE_DEFAULT, useFontSize, useTheme } from "@/lib/theme"
import { usePalette } from "./context"
import { ItemList, type PaletteItem } from "./list"
import { threadItem } from "./rows"
import { useThreadTarget } from "./thread-config"
import { transcriptText } from "./transcript-text"

const capitalize = (text: string) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text)

const MODES = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const

/** How many threads the landing list offers before you have typed anything. */
const RECENT_LIMIT = 6

/** The threads on the landing list are a destination, not a command: the
    sidebar's own Recents already answers "what was I just in", and remembering
    them here would spend the recently-used group on rows that are already one
    click away. */
const NOT_A_COMMAND = "Recent threads"

export function RootPage() {
  const palette = usePalette()
  const route = useRouteScope()
  const activeChat = useActiveChat()
  const sessions = useStoreSelect((store) => store.sessions)
  const projects = useProjects()
  const profiles = useProfiles()
  const agents = useAgents()
  const routines = useRoutines().data ?? []
  /* See search-page: a running mark per row, without subscribing to the
     stream that produces it. */
  const liveTurnActive = useLiveTurnActive()
  const navigate = useNavigate()
  const confirm = useConfirm()
  const prompt = usePrompt()
  const pins = usePins()
  const recents = usePaletteRecents()
  const { theme, setTheme } = useTheme()
  const [fontSize, setFontSize] = useFontSize()
  const { toggleSidebar, setOpenMobile } = useSidebar()
  const isMobile = useIsMobile()
  const { sessionId, meta, thread, modes, options } = useThreadTarget()
  const query = palette.query.trim()
  // The chords these rows advertise are the reader's own (lib/keybindings), so
  // a rebinding in settings reaches the palette without a second table.
  const binds = useKeybindings()

  // localStorage, so read once per open rather than per keystroke.
  const servers = React.useMemo(loadServers, [])
  const activeServer = React.useMemo(loadSettings, [])

  const agentName = (agentId: string) =>
    agents.find((agent) => agent.id === agentId)?.name ?? agentId

  /* Where a bare "New thread" lands — resolved with the same functions ⌘N uses
     and said on the row, so the one thing it decides for you (the project,
     which is the cwd the agent runs in) is visible before you commit to it. */
  const startTarget = React.useMemo(() => {
    const defaults = loadThreadDefaults()
    const project =
      projects.find((project) => project.id === defaults.projectId) ?? projects[0]
    const start = resolveThreadStart(project?.defaults ?? emptyDefaults(), profiles)
    return project && start ? { project, ...start } : null
  }, [projects, profiles])

  const openThread = (id: string) =>
    palette.run(() => {
      setOpenMobile(false)
      requestComposerFocus(id)
      void navigate(threadPath(id))
    })

  const copyTranscript = () => {
    const text = transcriptText(thread?.items ?? [])
    if (!text) {
      toast.error("Nothing to copy yet")
      return
    }
    writeClipboard(text)
      .then(() => toast.success("Transcript copied"))
      .catch((err) => reportError(err, "Couldn't copy the transcript"))
  }

  const items: PaletteItem[] = []

  /* ── Jump ── */
  items.push({
    id: "jump:search",
    group: "Jump",
    title: "Search threads and messages…",
    keywords: "find full text transcript grep look for",
    icon: <SearchIcon />,
    subtitle: "Titles instantly, full transcripts from the index",
    onSelect: () => palette.descend("search"),
  })
  if (sessionId) {
    items.push({
      id: "jump:thread-search",
      group: "Jump",
      title: "Search in this thread…",
      keywords: "find message transcript this conversation",
      icon: <SearchIcon />,
      subtitle: meta?.title ?? "Only search the thread in front of you",
      onSelect: () => palette.descend("thread-search"),
    })
  }
  if (routines.length > 0) {
    /* The one surface that answers "what have these been doing while I wasn't
       watching?" — one chord away on purpose, because a standing grant to act
       unattended is only tolerable if checking on it is cheap. */
    items.push({
      id: "jump:routine-activity",
      group: "Jump",
      title: "Routine activity…",
      keywords: "runs verdicts automation history blocked failed digest what happened",
      icon: <Zap />,
      subtitle: "Every routine's recent runs, newest first",
      onSelect: () => palette.descend("routine-activity"),
    })
  }
  if (projects.length > 0) {
    items.push({
      id: "jump:projects",
      group: "Jump",
      title: "Go to a project…",
      keywords: "workspace directory cwd open",
      icon: <FolderIcon />,
      onSelect: () => palette.descend("projects"),
    })
  }

  /* The landing list — a shortcut, not a search. It is gone the moment you type
     anything, because a thread list that filters here is exactly what pulled
     the server into every keystroke; typing reaches threads through the search
     page, which can say that it is still asking. */
  if (!query) {
    const recents = sessions
      .filter(isListed)
      .filter((session) => !session.deletedAt && session.id !== sessionId)
      .sort((a, b) => activityAt(b) - activityAt(a))
      .slice(0, RECENT_LIMIT)
    for (const session of recents) {
      items.push(
        threadItem({
          session,
          group: NOT_A_COMMAND,
          project: projects.find((project) => project.id === session.projectId) ?? "Other",
          running: liveTurnActive.get(session.id) ?? session.promptActive,
          onSelect: () => openThread(session.id),
        })
      )
    }
  }

  /* ── Create ── */
  items.push({
    id: "create:thread",
    group: "Create",
    title: "New thread",
    keywords: "session chat start",
    icon: <Plus />,
    chord: binds.newThread.chords[0],
    // What ↵ here is about to pick, in the order it is decided: the project
    // (the cwd), then the pair that runs in it.
    meta: startTarget
      ? [
          {
            label: startTarget.project.name,
            icon: <ProjectIcon project={startTarget.project} className="size-3.5" />,
          },
          {
            label: agentName(startTarget.agentId),
            icon: <AgentIcon agentId={startTarget.agentId} className="size-3.5" />,
          },
        ]
      : undefined,
    onSelect: () => palette.run(() => palette.newThread()),
  })
  if (projects.length > 1) {
    items.push({
      id: "create:thread-in",
      group: "Create",
      title: "New thread in another project…",
      keywords: "workspace elsewhere cwd",
      icon: <FolderIcon />,
      onSelect: () => palette.descend("start", { askText: "" }),
    })
  }
  items.push({
    id: "create:project",
    group: "Create",
    title: "New project",
    keywords: "workspace directory cwd",
    icon: <FolderPlus />,
    onSelect: () => palette.run(palette.newProject),
  })
  items.push({
    // Under Create because that is what it makes: threads. The conversation
    // already exists in the agent's own store — this is the harness adopting it.
    id: "create:import",
    group: "Create",
    title: "Import threads…",
    keywords: "sessions claude codex opencode existing resume adopt",
    icon: <DownloadIcon />,
    subtitle: "Adopt sessions an agent already holds — Claude Code, Codex, OpenCode",
    onSelect: () => palette.run(palette.importThreads),
  })
  /* Under Create because that is what a routine makes: threads, without you.
     The activity row is under Jump instead — it goes somewhere to read. */
  items.push({
    id: "create:routine",
    group: "Create",
    title: "New routine",
    keywords: "automation schedule cron webhook git trigger unattended fires on its own",
    icon: <Zap />,
    subtitle: "A thread that starts itself — on a schedule, a webhook or a push",
    onSelect: () => palette.run(() => void navigate(newRoutinePath())),
  })
  if (routines.length > 0) {
    items.push({
      id: "create:run-routine",
      group: "Create",
      title: "Run routine…",
      keywords: "automation fire now start trigger",
      icon: <Zap />,
      meta: [{ label: `${routines.length} routine${routines.length === 1 ? "" : "s"}`, dim: true }],
      onSelect: () => palette.descend("routines"),
    })
  }
  items.push({
    id: "create:board",
    group: "Create",
    title: "Tasks board",
    keywords: "kanban todos todo list",
    icon: <SquareKanban />,
    onSelect: () => palette.run(() => void navigate(boardPath())),
  })

  /* ── This thread ── */
  if (meta) {
    if (options.model) {
      items.push({
        id: "thread:model",
        group: "This thread",
        title: "Change model…",
        keywords: "llm switch",
        icon: <Cpu />,
        meta: [{ label: currentChoiceLabel(options.model) }],
        chord: binds.changeModel.chords[0],
        onSelect: () => palette.descend("model"),
      })
    }
    /* Only while it is a draft. After the first message the project is the
       agent's cwd — the composer's own row stops offering it there too, and a
       row that opens a page with nothing on it is worse than no row. */
    if (meta.draft && projects.length > 1) {
      items.push({
        id: "thread:project",
        group: "This thread",
        title: "Change project…",
        keywords: "workspace directory cwd where folder",
        icon: <ProjectIcon project={projects.find((p) => p.id === meta.projectId)} className="size-4" />,
        meta: [{ label: projects.find((p) => p.id === meta.projectId)?.name ?? "No project" }],
        chord: binds.changeProject.chords[0],
        onSelect: () => palette.descend("project"),
      })
    }
    if (options.effort) {
      items.push({
        id: "thread:effort",
        group: "This thread",
        title: "Change reasoning effort…",
        keywords: "thinking budget",
        icon: <Gauge />,
        meta: [{ label: capitalize(currentChoiceLabel(options.effort)) }],
        onSelect: () => palette.descend("effort"),
      })
    }
    if (modes) {
      items.push({
        id: "thread:mode",
        group: "This thread",
        title: "Change permission mode…",
        keywords: "approval auto accept plan",
        icon: <ShieldCheck />,
        meta: [
          {
            label:
              modes.availableModes.find((mode) => mode.id === modes.currentModeId)?.name ?? "",
          },
        ],
        onSelect: () => palette.descend("mode"),
      })
    }
    const pinned = pins.includes(meta.id)
    items.push({
      id: "thread:pin",
      group: "This thread",
      title: pinned ? "Unpin this thread" : "Pin this thread",
      keywords: "favourite favorite",
      icon: pinned ? <PinOff /> : <Pin />,
      onSelect: () => palette.run(() => void palette.actions.togglePin(meta.id)),
    })
    items.push({
      id: "thread:copy",
      group: "This thread",
      title: "Copy transcript",
      keywords: "markdown export clipboard",
      icon: <Copy />,
      onSelect: () => palette.run(copyTranscript),
    })
    if (thread?.turnActive) {
      items.push({
        id: "thread:stop",
        group: "This thread",
        title: "Stop the current turn",
        keywords: "cancel interrupt",
        icon: <Square />,
        onSelect: () =>
          palette.run(() => {
            palette.actions
              .stop(meta.id)
              .catch((err) => reportError(err, "Couldn't stop the turn"))
          }),
      })
    }
    if (thread && thread.phase.kind === "failed") {
      items.push({
        id: "thread:revive",
        group: "This thread",
        title: "Revive the agent",
        keywords: "respawn restart",
        icon: <RotateCw />,
        onSelect: () =>
          palette.run(() => {
            palette.actions
              .reviveThread(meta.id)
              .catch((err) => reportError(err, "Couldn't revive the agent"))
          }),
      })
    }
    items.push({
      id: "thread:delete",
      group: "This thread",
      title: "Move this thread to Trash",
      keywords: "delete remove kill close",
      icon: <Trash2 />,
      subtitle: "Stops the agent; restorable from Trash",
      /* The sidebar's row menu asks the same question. A palette entry is
         easier to hit by accident than a menu item, not harder, so it cannot be
         the one path that skips it. */
      onSelect: () =>
        palette.run(async () => {
          const ok = await confirm({
            title: `Delete "${meta.title}"?`,
            description:
              "The agent process is stopped and the thread moves to Trash, where it can be restored.",
            confirmLabel: "Delete",
            destructive: true,
          })
          if (!ok) return
          void navigate("/")
          palette.actions
            .deleteThread(meta.id)
            .then(() =>
              toast("Moved to Trash", {
                description: meta.title,
                action: {
                  label: "Undo",
                  onClick: () => {
                    palette.actions
                      .restoreThread(meta.id)
                      .catch((err) => reportError(err, "Couldn't restore the thread"))
                  },
                },
              })
            )
            .catch((err) => reportError(err, "Couldn't delete the thread"))
        }),
    })
  }

  /* ── Panel ──
     The right panel's sections, and the shells and preview it holds. With no
     thread routed the panel is the page's (a project's, or $HOME), and only the
     shell and the preview are offered. */
  {
    items.push({
      id: "panel:toggle",
      group: "Panel",
      title: "Show or hide the panel",
      keywords: "right side column inspector tools",
      icon: <PanelRightIcon />,
      chord: binds.rightPanel.chords[0],
      onSelect: () => palette.run(() => (isMobile ? rightSheet.set(true) : toggleRightPanel())),
    })
    for (const section of sectionsFor(route.scope)) {
      const { title, icon: Icon } = SECTION_META[section]
      if (section === "terminal") continue
      items.push({
        id: `panel:${section}`,
        group: "Panel",
        title: section === "preview" ? "Preview" : `Show ${title}`,
        keywords:
          section === "preview"
            ? "browser dev server localhost web"
            : `${title} inspector reading panel side`,
        icon: <Icon />,
        onSelect: () => palette.run(() => openSection(route.scope, section)),
      })
    }
    items.push({
      id: "panel:terminal",
      group: "Panel",
      title: "New terminal",
      keywords: "shell console command line",
      icon: <SquareTerminalIcon />,
      chord: binds.terminal.chords[0],
      onSelect: () =>
        palette.run(() => {
          /* A thread in front gets the shell in its worktree. */
          void openTerminal(
            route.scope,
            meta?.projectId ?? route.projectId ?? HOME_PROJECT_ID,
            meta ? { cwd: meta.worktree?.path, sessionId: meta.id } : {}
          )
        }),
    })
  }
  /* A board is the server's, not a project's, so this row is offered whether or
     not a thread is routed. */
  items.push({
    id: "panel:board",
    group: "Workspace",
    title: "Open the board",
    keywords: "tasks kanban board backlog sprint",
    icon: <SquareKanbanIcon />,
    onSelect: () => palette.run(() => void navigate(boardPath())),
  })
  items.push(
    {
      id: "thread:next",
      group: "Workspace",
      title: "Next thread",
      keywords: "switch cycle recent walk",
      icon: <ChevronRight />,
      chord: binds.nextTab.chords[0],
      onSelect: () =>
        palette.run(() => {
          const next = adjacentThread(-1, activeChat, (id) => sessions.some((s) => s.id === id && !s.deletedAt))
          if (next) void navigate(threadPath(next))
        }),
    },
    {
      id: "thread:prev",
      group: "Workspace",
      title: "Previous thread",
      keywords: "switch cycle recent walk back",
      icon: <ChevronLeft />,
      chord: binds.prevTab.chords[0],
      onSelect: () =>
        palette.run(() => {
          const next = adjacentThread(1, activeChat, (id) => sessions.some((s) => s.id === id && !s.deletedAt))
          if (next) void navigate(threadPath(next))
        }),
    }
  )
  if (meta && window.desktop?.openThreadWindow) {
    items.push({
      id: "thread:window",
      group: "Workspace",
      title: "Open this thread in a new window",
      keywords: "popout window monitor detach",
      icon: <AppWindowIcon />,
      onSelect: () => palette.run(() => void window.desktop?.openThreadWindow?.(meta.id)),
    })
  }

  /* ── Settings ── */
  items.push({
    id: "settings:overview",
    group: "Go to",
    title: "Settings",
    keywords: "settings preferences overview all",
    icon: <Settings2 />,
    onSelect: () => palette.run(() => void navigate(settingsRootPath())),
  })
  for (const section of SETTINGS_SECTIONS) {
    const Icon = section.icon
    items.push({
      id: `settings:${section.id}`,
      group: "Go to",
      title: section.label,
      keywords: `settings ${section.title}`,
      icon: <Icon />,
      meta: [{ label: "Settings", dim: true }],
      onSelect: () => palette.run(() => void navigate(settingsPath(section.id))),
    })
  }

  /* ── Appearance ── */
  items.push({
    id: "look:theme",
    group: "Appearance",
    title: "Change color theme…",
    keywords: "palette skin colours colors",
    icon: <PaletteIcon />,
    onSelect: () => palette.descend("theme"),
  })
  for (const { value, label, icon: Icon } of MODES) {
    items.push({
      id: `look:mode:${value}`,
      group: "Appearance",
      title: `${label} mode`,
      keywords: "appearance dark light system",
      icon: <Icon />,
      checked: theme === value,
      onSelect: () => palette.run(() => setTheme(value)),
    })
  }
  const size = [{ label: `${fontSize}px`, mono: true }]
  // Size stays open: nudging is iterative, and closing after every step would
  // make you reopen the palette to reach the next one.
  items.push(
    {
      id: "look:bigger",
      group: "Appearance",
      title: "Bigger text",
      keywords: "increase font size zoom in",
      icon: <Plus />,
      meta: size,
      onSelect: () => setFontSize(fontSize + 1),
    },
    {
      id: "look:smaller",
      group: "Appearance",
      title: "Smaller text",
      keywords: "decrease font size zoom out",
      icon: <Minus />,
      meta: size,
      onSelect: () => setFontSize(fontSize - 1),
    }
  )
  if (fontSize !== FONT_SIZE_DEFAULT) {
    items.push({
      id: "look:reset-size",
      group: "Appearance",
      title: "Reset text size",
      keywords: "default font",
      icon: <RotateCcw />,
      onSelect: () => setFontSize(FONT_SIZE_DEFAULT),
    })
  }
  items.push(
    {
      id: "look:sidebar",
      group: "Appearance",
      title: "Toggle sidebar",
      keywords: "panel collapse hide",
      icon: <PanelLeft />,
      chord: binds.sidebar.chords[0],
      onSelect: () => palette.run(toggleSidebar),
    },
    {
      id: "look:view-options",
      group: "Appearance",
      title: "View options",
      keywords: "transcript display density timestamps thinking diffs motion how drawn",
      icon: <SlidersHorizontal />,
      chord: binds.viewOptions.chords[0],
      onSelect: () => palette.run(palette.showViewOptions),
    },
    {
      id: "look:shortcuts",
      group: "Appearance",
      title: "Keyboard shortcuts",
      keywords: "keys bindings help chords",
      icon: <Keyboard />,
      onSelect: () => palette.run(palette.showShortcuts),
    }
  )

  /* ── Server ── */
  for (const server of servers.filter((server) => server.id !== activeServer?.id)) {
    items.push({
      id: `server:${server.id}`,
      group: "Server",
      title: `Switch to ${server.name}`,
      keywords: `server ${server.url}`,
      icon: <ServerIcon />,
      meta: [{ label: server.url, mono: true }],
      onSelect: () =>
        palette.run(() => {
          setActiveServer(server.id)
        }),
    })
  }
  items.push({
    id: "server:disconnect",
    group: "Server",
    title: "Disconnect from this server",
    keywords: "sign out log out forget token",
    icon: <LogOut />,
    subtitle: "Forgets the token on this device",
    onSelect: () =>
      palette.run(() => {
        clearSettings()
        window.location.assign("/")
      }),
  })

  /* ── The two rows that are about the query ── */
  if (query) {
    items.push({
      id: "fallback:search",
      group: `“${query}”`,
      title: `Search for “${query}”`,
      subtitle: "Thread titles and full transcripts",
      always: true,
      rank: "bottom",
      icon: <SearchIcon />,
      onSelect: () => palette.descend("search", { query }),
    })
    items.push({
      id: "fallback:ask",
      group: `“${query}”`,
      title: `Ask a new thread — “${query}”`,
      subtitle: startTarget
        ? `In ${startTarget.project.name} with ${agentName(startTarget.agentId)}`
        : undefined,
      always: true,
      rank: "bottom",
      icon: <MessageSquarePlusIcon />,
      chord: KEYS.send,
      onSelect: () => palette.run(() => palette.newThread({ text: query })),
    })
    if (projects.length > 1) {
      items.push({
        id: "fallback:ask-in",
        group: `“${query}”`,
        title: "Ask it in another project…",
        always: true,
        rank: "bottom",
        icon: <FolderIcon />,
        onSelect: () => palette.descend("start", { askText: query }),
      })
    }
  }

  /* Remembering happens here rather than in `list.tsx` because this is the one
     page whose ids are a vocabulary: a choice page's rows are the current
     agent's models, and the search page's are somebody's messages. Wrapping
     `onSelect` rather than recording in the row keeps `ItemList` a renderer,
     and keeps the rule about *which* rows are commands beside the rows. */
  const rows = items.map((item) =>
    item.always || item.group === NOT_A_COMMAND
      ? item
      : {
          ...item,
          onSelect: () => {
            recordPaletteCommand(item.id)
            item.onSelect?.()
          },
        }
  )

  return <ItemList items={rows} query={palette.query} recents={recents} />
}
import { writeClipboard } from "@/lib/clipboard"
