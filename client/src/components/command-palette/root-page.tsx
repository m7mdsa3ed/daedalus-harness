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
  Copy,
  Cpu,
  DownloadIcon,
  Drama,
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
  PanelBottom,
  PanelLeft,
  PanelsTopLeft,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  RotateCw,
  Rows3,
  SearchIcon,
  ServerIcon,
  ShieldCheck,
  Square,
  SquareKanban,
  SquareStack,
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
import { openTerminal } from "@/components/workspace/terminal-panel"
import { reportError } from "@/lib/errors"
import { currentChoiceLabel } from "@/lib/session-options"
import { useKeybindings } from "@/lib/keybindings"
import { KEYS } from "@/lib/shortcuts"
import { boardPath, newRoutinePath, settingsPath, threadPath } from "@/lib/router"
import {
  activityAt,
  clearSettings,
  isTopLevel,
  loadServers,
  loadSettings,
  setActiveServer,
} from "@/lib/settings"
import { recordPaletteCommand, usePaletteRecents } from "@/lib/palette-recents"
import { togglePin, usePins } from "@/lib/pins"
import { loadThreadDefaults, resolveThreadStart } from "@/lib/thread-defaults"
import { useLiveTurnActive, useStoreSelect } from "@/lib/store"
import { toast } from "@/lib/toast"
import { FONT_SIZE_DEFAULT, useFontSize, useTheme } from "@/lib/theme"
import { usePalette } from "./context"
import { ItemList, type PaletteItem } from "./list"
import { threadItem } from "./rows"
import { useThreadTarget } from "./thread-config"
import { transcriptText } from "./transcript-text"

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
  const sessions = useStoreSelect((store) => store.sessions)
  const projects = useStoreSelect((store) => store.projects)
  const profiles = useStoreSelect((store) => store.profiles)
  const agents = useStoreSelect((store) => store.agents)
  const personas = useStoreSelect((store) => store.personas)
  const routines = useStoreSelect((store) => store.routines)
  /* See search-page: a running mark per row, without subscribing to the
     stream that produces it. */
  const liveTurnActive = useLiveTurnActive()
  const navigate = useNavigate()
  const confirm = useConfirm()
  const pins = usePins()
  const recents = usePaletteRecents()
  const { theme, setTheme } = useTheme()
  const [fontSize, setFontSize] = useFontSize()
  const { toggleSidebar, setOpenMobile } = useSidebar()
  const { sessionId, meta, thread, modes, options } = useThreadTarget()
  const query = palette.query.trim()
  // The chords these rows advertise are the reader's own (lib/keybindings), so
  // a rebinding in settings reaches the palette without a second table.
  const binds = useKeybindings()

  // localStorage, so read once per open rather than per keystroke.
  const servers = React.useMemo(loadServers, [])
  const activeServer = React.useMemo(loadSettings, [])

  const projectName = (projectId: string) =>
    projects.find((project) => project.id === projectId)?.name ?? "Other"
  const agentName = (agentId: string) =>
    agents.find((agent) => agent.id === agentId)?.name ?? agentId

  /* Where a bare "New thread" lands — resolved with the same functions ⌘N uses
     and said on the row, so the one thing it decides for you (the project,
     which is the cwd the agent runs in) is visible before you commit to it. */
  const startTarget = React.useMemo(() => {
    const defaults = loadThreadDefaults()
    const project =
      projects.find((project) => project.id === defaults.projectId) ?? projects[0]
    const start = resolveThreadStart(defaults, profiles)
    return project && start ? { project, ...start } : null
  }, [projects, profiles])

  const openThread = (id: string) =>
    palette.run(() => {
      setOpenMobile(false)
      void navigate(threadPath(id))
    })

  const copyTranscript = () => {
    const text = transcriptText(thread?.items ?? [])
    if (!text) {
      toast.error("Nothing to copy yet")
      return
    }
    navigator.clipboard
      .writeText(text)
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
    onSelect: () => palette.descend("search"),
  })
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
      .filter(isTopLevel)
      .filter((session) => !session.deletedAt && session.id !== sessionId)
      .sort((a, b) => activityAt(b) - activityAt(a))
      .slice(0, RECENT_LIMIT)
    for (const session of recents) {
      items.push(
        threadItem({
          session,
          group: NOT_A_COMMAND,
          project: projectName(session.projectId),
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
    trailing: startTarget ? (
      <span className="ml-auto flex min-w-0 shrink items-center gap-1.5 text-[11px] text-muted-foreground">
        <ProjectIcon project={startTarget.project} className="size-3.5" />
        <span className="truncate">{startTarget.project.name}</span>
        <span className="opacity-70">·</span>
        <AgentIcon agentId={startTarget.agentId} className="size-3.5" />
        {/* The palette is a viewport dialog, not a panel — so the breakpoint is
            the window's. */}
        <span className="hidden truncate sm:inline">{agentName(startTarget.agentId)}</span>
      </span>
    ) : undefined,
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
    onSelect: () => palette.run(() => void navigate(newRoutinePath())),
  })
  if (routines.length > 0) {
    items.push({
      id: "create:run-routine",
      group: "Create",
      title: "Run routine…",
      keywords: "automation fire now start trigger",
      icon: <Zap />,
      trailing: (
        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums">
          {routines.length}
        </span>
      ),
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
        trailing: (
          <span className="ml-auto shrink-0 truncate text-[11px] text-muted-foreground">
            {currentChoiceLabel(options.model)}
          </span>
        ),
        onSelect: () => palette.descend("model"),
      })
    }
    if (options.effort) {
      items.push({
        id: "thread:effort",
        group: "This thread",
        title: "Change reasoning effort…",
        keywords: "thinking budget",
        icon: <Gauge />,
        trailing: (
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground capitalize">
            {currentChoiceLabel(options.effort)}
          </span>
        ),
        onSelect: () => palette.descend("effort"),
      })
    }
    /* Above the permission mode, and unlike it not gated on the agent
       advertising anything: a persona is the harness's own, so every started
       thread can take one. Drafts are excluded — their persona is a field on
       the composer's menu, and there is no thread to restart. */
    if (!meta.draft && personas.length > 0) {
      const persona = personas.find((p) => p.id === meta.personaId)
      items.push({
        id: "thread:persona",
        group: "This thread",
        title: "Change persona…",
        keywords: "style think more less chat quick fix lazy instructions prompt",
        icon: <Drama />,
        trailing: (
          <span className="ml-auto shrink-0 truncate text-[11px] text-muted-foreground">
            {persona?.name ?? "None"}
          </span>
        ),
        onSelect: () => palette.descend("persona"),
      })
    }
    if (modes) {
      items.push({
        id: "thread:mode",
        group: "This thread",
        title: "Change permission mode…",
        keywords: "approval auto accept plan",
        icon: <ShieldCheck />,
        trailing: (
          <span className="ml-auto shrink-0 truncate text-[11px] text-muted-foreground">
            {modes.availableModes.find((mode) => mode.id === modes.currentModeId)?.name}
          </span>
        ),
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
      onSelect: () => palette.run(() => togglePin(meta.id)),
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

  /* ── Workspace ──
     Dragging a tab does all of this too, but a gesture is not discoverable and
     cannot be typed — and the two presets are the only way to get an
     arrangement back once it has been dragged into a shape nobody wanted. */
  if (meta) {
    items.push({
      id: "dock:web",
      group: "Workspace",
      title: "Browser",
      keywords: "preview dev server localhost web",
      icon: <MonitorIcon />,
      onSelect: () =>
        palette.run(() =>
          palette.dock.openPanel(
            { kind: "web", trust: "project", projectId: meta.projectId, viewId: "default" },
            { direction: "right" }
          )
        ),
    })
    items.push({
      id: "dock:terminal",
      group: "Workspace",
      title: "New terminal",
      keywords: "shell console command line",
      icon: <SquareTerminalIcon />,
      chord: binds.terminal.chords[0],
      onSelect: () => palette.run(() => void openTerminal(palette.dock, meta.projectId)),
    })
  }
  items.push(
    {
      id: "dock:split-right",
      group: "Workspace",
      title: "Split right",
      keywords: "panel side by side",
      icon: <PanelsTopLeft />,
      chord: binds.splitRight.chords[0],
      onSelect: () => palette.run(() => palette.dock.splitActive("right")),
    },
    {
      id: "dock:split-down",
      group: "Workspace",
      title: "Split down",
      keywords: "panel below",
      icon: <PanelBottom />,
      onSelect: () => palette.run(() => palette.dock.splitActive("below")),
    },
    {
      id: "dock:maximize",
      group: "Workspace",
      title: "Maximize / restore panel",
      keywords: "fullscreen zoom",
      icon: <Square />,
      onSelect: () => palette.run(() => palette.dock.toggleMaximize()),
    },
    {
      id: "dock:stack",
      group: "Workspace",
      title: "Stack all tabs",
      keywords: "one group merge",
      icon: <SquareStack />,
      onSelect: () => palette.run(() => palette.dock.stackAll()),
    },
    {
      id: "dock:layout-ide",
      group: "Workspace",
      title: "Layout: IDE",
      keywords: "preset terminal arrangement",
      icon: <Rows3 />,
      onSelect: () => palette.run(() => palette.dock.applyPreset("ide")),
    },
    {
      id: "dock:layout-focus",
      group: "Workspace",
      title: "Layout: Focus",
      keywords: "preset single maximized arrangement",
      icon: <Square />,
      onSelect: () => palette.run(() => palette.dock.applyPreset("focus")),
    }
  )
  if (palette.dock.hasClosedPanels()) {
    items.push({
      id: "dock:reopen",
      group: "Workspace",
      title: "Reopen closed panel",
      keywords: "tab undo close",
      icon: <RotateCcw />,
      chord: binds.reopenPanel.chords[0],
      onSelect: () => palette.run(() => palette.dock.reopenClosed()),
    })
  }
  items.push({
    id: "dock:reset",
    group: "Workspace",
    title: "Reset layout",
    keywords: "workspace arrangement default",
    icon: <RotateCw />,
    onSelect: () => palette.run(() => palette.dock.resetLayout()),
  })

  /* ── Settings ── */
  for (const section of SETTINGS_SECTIONS) {
    const Icon = section.icon
    items.push({
      id: `settings:${section.id}`,
      group: "Go to",
      title: section.label,
      keywords: `settings ${section.title}`,
      icon: <Icon />,
      trailing: <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">Settings</span>,
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
  const size = (
    <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
      {fontSize}px
    </span>
  )
  // Size stays open: nudging is iterative, and closing after every step would
  // make you reopen the palette to reach the next one.
  items.push(
    {
      id: "look:bigger",
      group: "Appearance",
      title: "Bigger text",
      keywords: "increase font size zoom in",
      icon: <Plus />,
      trailing: size,
      onSelect: () => setFontSize(fontSize + 1),
    },
    {
      id: "look:smaller",
      group: "Appearance",
      title: "Smaller text",
      keywords: "decrease font size zoom out",
      icon: <Minus />,
      trailing: size,
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
      trailing: (
        <span className="ml-auto shrink-0 truncate font-mono text-[11px] text-muted-foreground">
          {server.url}
        </span>
      ),
      onSelect: () =>
        palette.run(() => {
          setActiveServer(server.id)
          window.location.assign("/")
        }),
    })
  }
  items.push({
    id: "server:disconnect",
    group: "Server",
    title: "Disconnect from this server",
    keywords: "sign out log out forget token",
    icon: <LogOut />,
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
      title: `Search threads and messages for “${query}”`,
      always: true,
      rank: "bottom",
      icon: <SearchIcon />,
      onSelect: () => palette.descend("search", { query }),
    })
    items.push({
      id: "fallback:ask",
      group: `“${query}”`,
      title: `Ask a new thread — “${query}”`,
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
            item.onSelect()
          },
        }
  )

  return <ItemList items={rows} query={palette.query} recents={recents} />
}
