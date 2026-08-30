/* ── Command palette ──
   ⌘K / Ctrl-K. One list over everything the shell can do: jump to a thread,
   create one, retune the running agent, walk into a settings section, change
   the look, drop the server.

   It is deliberately not a second source of truth — every entry calls the same
   navigate()/actions the sidebar and composer call, so a command can never
   drift from the control next to it. The palette only decides what is
   *offered*, and it offers a command only when it would actually work: no
   "Change model" without a session, no "Revive" on a live agent. */
import * as React from "react"
import {
  ArrowLeft,
  CodeXmlIcon,
  Copy,
  Cpu,
  FolderIcon,
  FolderPlus,
  FolderTreeIcon,
  GitBranchIcon,
  MonitorIcon,
  Gauge,
  Keyboard,
  LogOut,
  MessageSquareIcon,
  Minus,
  Monitor,
  Moon,
  Palette,
  PanelBottom,
  PanelLeft,
  PanelsTopLeft,
  Rows3,
  SquareStack,
  SquareTerminalIcon,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  ScrollTextIcon,
  RotateCw,
  ServerIcon,
  ShieldCheck,
  Square,
  SquareKanban,
  Sun,
  Trash2,
} from "lucide-react"
import type * as acp from "@agentclientprotocol/sdk"
import { toast } from "sonner"
import { reportError } from "@/lib/errors"
import {
  currentChoiceLabel,
  flattenSelectOptions,
  partitionSessionOptions,
} from "@/lib/session-options"
import { useConfirm } from "@/components/confirm-dialog"
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command"
import { useSidebar } from "@/components/ui/sidebar"
import type { WorkspaceDock } from "@/components/workspace/dock"
import { openTerminal } from "@/components/workspace/terminal-panel"
import { useHotkey } from "@/hooks/use-hotkey"
import { KEYS, formatChord } from "@/lib/shortcuts"
import { SETTINGS_SECTIONS } from "@/components/settings/sections"
import type { Actions } from "@/lib/actions"
import { customThemeValue } from "@/lib/custom-themes"
import { togglePin, usePins } from "@/lib/pins"
import { shortAge } from "@/lib/time"
import { useLocation, useNavigate } from "react-router"
import { boardPath, currentThreadId, settingsPath, threadPath } from "@/lib/router"
import {
  clearSettings,
  loadServers,
  loadSettings,
  setActiveServer,
  type SessionMeta,
} from "@/lib/settings"
import { searchThreads, snippetParts, type SearchResult } from "@/lib/search"
import { useStore, type ThreadItem, type ThreadState } from "@/lib/store"
import { cn } from "@/lib/utils"
import {
  BUILTIN_THEMES,
  FONT_SIZE_DEFAULT,
  useCustomThemes,
  useFontSize,
  useTheme,
} from "@/lib/theme"

/** Open state + the ⌘K binding, so the shell only has to render the palette. */
export function useCommandPalette() {
  const [open, setOpen] = React.useState(false)

  useHotkey(KEYS.palette, (event) => {
    event.preventDefault()
    setOpen((previous) => !previous)
  })

  return { open, setOpen }
}

const MODES = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const

/** Sub-lists the palette can descend into, each a filtered second screen. */
type Page = "root" | "theme" | "model" | "effort" | "mode"

/** The transcript as markdown — what you would paste into an issue. */
function transcriptText(items: ThreadItem[]): string {
  return items
    .map((item) => {
      const text = itemText(item)
      // A subagent's items sit under the step that launched them.
      return text && "parentId" in item && item.parentId ? indent(text) : text
    })
    .filter(Boolean)
    .join("\n\n")
}

const indent = (text: string): string =>
  text
    .split("\n")
    .map((line) => (line ? `  ${line}` : line))
    .join("\n")

function itemText(item: ThreadItem): string {
  switch (item.kind) {
    case "user":
      return `### You\n\n${item.text}`
    case "agent":
      return item.text
    case "thought":
      return item.text
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")
    case "notice":
      return `_${item.text}_`
    // The transcript gets pasted into bug reports; a failure is the single
    // most useful thing in one, details and all.
    case "error":
      return [
        `> **${item.title}**`,
        item.reason && `> ${item.reason}`,
        item.detail && `\n\`\`\`\n${item.detail}\n\`\`\``,
      ]
        .filter(Boolean)
        .join("\n")
    case "tool":
      return `- **${item.title}** — ${item.status}`
    case "subagent":
      return `- **${item.name}** — ${item.task} (${item.state})`
    case "plan":
      return item.entries.map((entry) => `- [${entry.status}] ${entry.content}`).join("\n")
    // The summary is the only part of the pre-compaction history the agent
    // still has, so a pasted transcript that dropped it would not explain
    // what the agent was working from after this point.
    case "compaction":
      return [
        `_Context compacted (${item.status})_`,
        item.error,
        ...item.summary.map((block) => (block.type === "text" ? block.text : "")),
      ]
        .filter(Boolean)
        .join("\n\n")
  }
}

export function CommandPalette({
  open,
  onOpenChange,
  actions,
  dock,
  onNewThread,
  onNewProject,
  onShortcuts,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  actions: Actions
  dock: WorkspaceDock
  onNewThread: () => void
  onNewProject: () => void
  onShortcuts: () => void
}) {
  const { state } = useStore()
  const location = useLocation()
  const navigate = useNavigate()
  const confirm = useConfirm()
  const { theme, setTheme, colorTheme, setColorTheme } = useTheme()
  const customThemes = useCustomThemes()
  const [fontSize, setFontSize] = useFontSize()
  const { toggleSidebar, setOpenMobile } = useSidebar()
  const [page, setPage] = React.useState<Page>("root")
  const [query, setQuery] = React.useState("")
  const pins = usePins()
  const servers = React.useMemo(loadServers, [])
  const activeServer = React.useMemo(loadSettings, [])

  // Every open starts at the root page with an empty query — a palette that
  // remembers where you left it is a palette you have to read before using.
  React.useEffect(() => {
    if (open) {
      setPage("root")
      setQuery("")
    }
  }, [open])

  const run = (fn: () => void) => {
    onOpenChange(false)
    fn()
  }
  const descend = (next: Page) => {
    setQuery("")
    setPage(next)
  }

  /* Full-text hits from the server, debounced behind the query. The palette's
     own lists filter locally; the transcripts live in SQLite, so "Messages" is
     the one group that asks the server — 250ms after the last keystroke, with
     the previous request aborted so a slow answer cannot overwrite a newer
     one. Failures stay quiet: a search box that toasts while you type is
     noise, and the thread list above still works. */
  const [messageHits, setMessageHits] = React.useState<SearchResult[]>([])
  const search = page === "root" ? query.trim() : ""
  React.useEffect(() => {
    if (!open || search.length < 2) {
      setMessageHits([])
      return
    }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      searchThreads(search, controller.signal)
        .then(setMessageHits)
        .catch(() => {}) // aborted, offline, or an old server without the route
    }, 250)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [open, search])

  const sessionId = currentThreadId(location.pathname, location.search)
  const meta = state.sessions.find((session) => session.id === sessionId) ?? null
  const thread: ThreadState | undefined = sessionId ? state.threads[sessionId] : undefined
  const modes = thread?.modes && thread.modes.availableModes.length > 1 ? thread.modes : null
  // The agent's own selectors, not the profile catalog: model and effort are
  // live ACP settings once a thread is running. An agent that advertises
  // neither simply has no model or effort page here.
  const options = partitionSessionOptions(
    thread?.configOptions ?? [],
    new Set(thread?.modes?.availableModes.map((mode) => mode.id) ?? [])
  )
  const modelChoices = options.model?.type === "select" ? flattenSelectOptions(options.model.options) : []
  const effortChoices = options.effort?.type === "select" ? flattenSelectOptions(options.effort.options) : []

  // Deleted threads live in the sidebar's Trash, not in the jump list — the
  // palette is for going somewhere, and a deleted thread is nowhere to go.
  const sessions = state.sessions
    .filter((session) => !session.deletedAt)
    .sort((a, b) => b.createdAt - a.createdAt)
  const projectName = (projectId: string) =>
    state.projects.find((project) => project.id === projectId)?.name ?? "Other"

  /* Retuning is one ACP call to the running agent — nothing restarts, nothing
     is replayed, and it is safe in the middle of a turn. That is why there is
     no confirmation here any more. */
  const retune = (option: acp.SessionConfigOption | undefined, value: string) => {
    if (!sessionId || !option) return
    actions
      .setConfigOption(sessionId, option.id, value)
      .catch((err) => reportError(err, `Couldn't change ${option.name}`))
  }

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

  // Backspace on an empty query walks back out of a sub-page.
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (page !== "root" && event.key === "Backspace" && !query) {
      event.preventDefault()
      setPage("root")
    }
  }

  const back = (
    <CommandItem value="back" onSelect={() => setPage("root")}>
      <ArrowLeft />
      Back
    </CommandItem>
  )

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} className="sm:max-w-xl">
      <Command loop onKeyDown={onKeyDown} className="bg-transparent">
        <CommandInput
          autoFocus
          value={query}
          onValueChange={setQuery}
          placeholder={PLACEHOLDERS[page]}
        />
        <CommandList className="max-h-[60vh]">
          <CommandEmpty>No matches.</CommandEmpty>

          {page === "theme" && (
            <>
              <CommandGroup heading="Palettes">
                {back}
                {BUILTIN_THEMES.map(({ value, label }) => (
                  <ChoiceItem
                    key={value}
                    icon={Palette}
                    label={label}
                    prefix="palette"
                    selected={colorTheme === value}
                    onSelect={() => run(() => setColorTheme(value))}
                  />
                ))}
              </CommandGroup>
              {customThemes.length > 0 && (
                <CommandGroup heading="Your themes">
                  {customThemes.map((custom) => (
                    <ChoiceItem
                      key={custom.id}
                      icon={Palette}
                      label={custom.name}
                      prefix="palette"
                      selected={colorTheme === customThemeValue(custom.id)}
                      onSelect={() => run(() => setColorTheme(customThemeValue(custom.id)))}
                    />
                  ))}
                </CommandGroup>
              )}
              <CommandSeparator />
              <CommandGroup>
                <CommandItem
                  value="build a theme"
                  onSelect={() => run(() => void navigate(settingsPath("appearance")))}
                >
                  <Palette />
                  Build a theme…
                </CommandItem>
              </CommandGroup>
            </>
          )}

          {page === "model" && (
            <CommandGroup heading={options.model?.name ?? "Model"}>
              {back}
              {modelChoices.map((choice) => (
                <ChoiceItem
                  key={choice.value}
                  icon={Cpu}
                  label={choice.name}
                  prefix="model"
                  selected={options.model?.type === "select" && options.model.currentValue === choice.value}
                  onSelect={() => run(() => retune(options.model, choice.value))}
                />
              ))}
            </CommandGroup>
          )}

          {page === "effort" && (
            <CommandGroup heading={options.effort?.name ?? "Reasoning effort"}>
              {back}
              {effortChoices.map((choice) => (
                <ChoiceItem
                  key={choice.value}
                  icon={Gauge}
                  label={choice.name}
                  prefix="effort"
                  capitalize
                  selected={options.effort?.type === "select" && options.effort.currentValue === choice.value}
                  onSelect={() => run(() => retune(options.effort, choice.value))}
                />
              ))}
            </CommandGroup>
          )}

          {page === "mode" && modes && (
            <CommandGroup heading="Permission mode">
              {back}
              {modes.availableModes.map((mode) => (
                <ChoiceItem
                  key={mode.id}
                  icon={ShieldCheck}
                  label={mode.name}
                  prefix="mode"
                  selected={modes.currentModeId === mode.id}
                  onSelect={() =>
                    run(() => {
                      if (!sessionId) return
                      actions.setMode(sessionId, mode.id).catch((err) => reportError(err, "Couldn't switch mode"))
                    })
                  }
                />
              ))}
            </CommandGroup>
          )}

          {page === "root" && (
            <>
              <CommandGroup heading="Create">
                <CommandItem
                  value="new thread session chat start"
                  onSelect={() => run(onNewThread)}
                >
                  <Plus />
                  New thread
                  <CommandShortcut>{formatChord(KEYS.newThread)}</CommandShortcut>
                </CommandItem>
                <CommandItem
                  value="new project workspace directory cwd"
                  onSelect={() => run(onNewProject)}
                >
                  <FolderPlus />
                  New project
                </CommandItem>
                <CommandItem
                  value="tasks board kanban todos todo list"
                  onSelect={() => run(() => void navigate(boardPath()))}
                >
                  <SquareKanban />
                  Tasks board
                </CommandItem>
              </CommandGroup>

              {/* The layout commands. Dragging a tab does all of this too, but a
                  gesture is not discoverable and cannot be typed — and the two
                  presets are the only way to get an arrangement back once it
                  has been dragged into a shape nobody wanted. */}
              <CommandGroup heading="Workspace">
                {meta && (
                  <CommandItem
                    value="explorer files tree open project folder"
                    onSelect={() =>
                      run(() =>
                        dock.openPanel(
                          { kind: "explorer", projectId: meta.projectId },
                          { direction: "left" }
                        )
                      )
                    }
                  >
                    <FolderTreeIcon />
                    File explorer
                    <CommandShortcut>{formatChord(KEYS.explorer)}</CommandShortcut>
                  </CommandItem>
                )}
                {meta && (
                  <CommandItem
                    value="output problems diagnostics errors log console"
                    onSelect={() =>
                      run(() =>
                        dock.openPanel(
                          { kind: "output", projectId: meta.projectId },
                          { direction: "below" }
                        )
                      )
                    }
                  >
                    <ScrollTextIcon />
                    Output &amp; problems
                    <CommandShortcut>{formatChord(KEYS.output)}</CommandShortcut>
                  </CommandItem>
                )}
                {meta && (
                  <CommandItem
                    value="preview browser dev server localhost web"
                    onSelect={() =>
                      run(() =>
                        dock.openPanel(
                          {
                            kind: "web",
                            trust: "project",
                            projectId: meta.projectId,
                            viewId: "default",
                          },
                          { direction: "right" }
                        )
                      )
                    }
                  >
                    <MonitorIcon />
                    Preview
                  </CommandItem>
                )}
                {meta && (
                  <CommandItem
                    value="vscode vs code ide editor code-server full editor"
                    onSelect={() =>
                      run(() => dock.openPanel({ kind: "ide", projectId: meta.projectId }))
                    }
                  >
                    <CodeXmlIcon />
                    VS Code
                  </CommandItem>
                )}
                {meta && (
                  <CommandItem
                    value="source control git changes commit branch staging"
                    onSelect={() =>
                      run(() =>
                        dock.openPanel(
                          { kind: "source-control", projectId: meta.projectId },
                          { direction: "left" }
                        )
                      )
                    }
                  >
                    <GitBranchIcon />
                    Source control
                    <CommandShortcut>{formatChord(KEYS.sourceControl)}</CommandShortcut>
                  </CommandItem>
                )}
                {meta && (
                  <CommandItem
                    value="terminal shell console command line"
                    onSelect={() => run(() => void openTerminal(dock, meta.projectId))}
                  >
                    <SquareTerminalIcon />
                    New terminal
                    <CommandShortcut>{formatChord(KEYS.terminal)}</CommandShortcut>
                  </CommandItem>
                )}
                <CommandItem
                  value="split panel right side by side"
                  onSelect={() => run(() => dock.splitActive("right"))}
                >
                  <PanelsTopLeft />
                  Split right
                  <CommandShortcut>{formatChord(KEYS.splitRight)}</CommandShortcut>
                </CommandItem>
                <CommandItem
                  value="split panel down below"
                  onSelect={() => run(() => dock.splitActive("below"))}
                >
                  <PanelBottom />
                  Split down
                </CommandItem>
                <CommandItem
                  value="maximize restore panel fullscreen"
                  onSelect={() => run(() => dock.toggleMaximize())}
                >
                  <Square />
                  Maximize / restore panel
                </CommandItem>
                <CommandItem
                  value="stack all tabs one group"
                  onSelect={() => run(() => dock.stackAll())}
                >
                  <SquareStack />
                  Stack all tabs
                </CommandItem>
                <CommandItem
                  value="layout ide preset explorer terminal"
                  onSelect={() => run(() => dock.applyPreset("ide"))}
                >
                  <Rows3 />
                  Layout: IDE
                </CommandItem>
                <CommandItem
                  value="layout focus preset single maximized"
                  onSelect={() => run(() => dock.applyPreset("focus"))}
                >
                  <Square />
                  Layout: Focus
                </CommandItem>
                {dock.hasClosedPanels() && (
                  <CommandItem
                    value="reopen closed panel tab undo close"
                    onSelect={() => run(() => dock.reopenClosed())}
                  >
                    <RotateCcw />
                    Reopen closed panel
                    <CommandShortcut>{formatChord(KEYS.reopenPanel)}</CommandShortcut>
                  </CommandItem>
                )}
                <CommandItem
                  value="reset layout workspace arrangement"
                  onSelect={() => run(() => dock.resetLayout())}
                >
                  <RotateCw />
                  Reset layout
                </CommandItem>
              </CommandGroup>

              {meta && (
                <CommandGroup heading="This thread">
                  {options.model && (
                    <CommandItem value="change model" onSelect={() => descend("model")}>
                      <Cpu />
                      Change model…
                      <span className="ml-auto shrink-0 truncate text-[11px] text-muted-foreground">
                        {currentChoiceLabel(options.model)}
                      </span>
                    </CommandItem>
                  )}
                  {options.effort && (
                    <CommandItem
                      value="change reasoning effort thinking"
                      onSelect={() => descend("effort")}
                    >
                      <Gauge />
                      Change reasoning effort…
                      <span className="ml-auto shrink-0 text-[11px] text-muted-foreground capitalize">
                        {currentChoiceLabel(options.effort)}
                      </span>
                    </CommandItem>
                  )}
                  {modes && (
                    <CommandItem
                      value="change permission mode approval"
                      onSelect={() => descend("mode")}
                    >
                      <ShieldCheck />
                      Change permission mode…
                      <span className="ml-auto shrink-0 truncate text-[11px] text-muted-foreground">
                        {modes.availableModes.find((m) => m.id === modes.currentModeId)?.name}
                      </span>
                    </CommandItem>
                  )}
                  <CommandItem
                    value="pin unpin thread favourite favorite"
                    onSelect={() => run(() => togglePin(meta.id))}
                  >
                    {pins.includes(meta.id) ? <PinOff /> : <Pin />}
                    {pins.includes(meta.id) ? "Unpin this thread" : "Pin this thread"}
                  </CommandItem>
                  <CommandItem value="copy transcript markdown export" onSelect={() => run(copyTranscript)}>
                    <Copy />
                    Copy transcript
                  </CommandItem>
                  {thread?.turnActive && (
                    <CommandItem
                      value="stop cancel interrupt turn"
                      onSelect={() =>
                        run(() => {
                          actions.stop(meta.id).catch((err) => reportError(err, "Couldn't stop the turn"))
                        })
                      }
                    >
                      <Square />
                      Stop the current turn
                    </CommandItem>
                  )}
                  {thread?.status === "closed" && (
                    <CommandItem
                      value="revive respawn restart agent"
                      onSelect={() =>
                        run(() => {
                          actions.reviveThread(meta.id).catch((err) => reportError(err, "Couldn't revive the agent"))
                        })
                      }
                    >
                      <RotateCw />
                      Revive the agent
                    </CommandItem>
                  )}
                  <CommandItem
                    value="delete thread remove trash kill close"
                    onSelect={() =>
                      /* The sidebar's row menu asks the same question. A palette
                         entry is easier to hit by accident than a menu item, not
                         harder, so it cannot be the one path that skips it. */
                      run(async () => {
                        if (
                          !(await confirm({
                            title: `Delete "${meta.title}"?`,
                            description:
                              "The agent process is stopped and the thread moves to Trash, where it can be restored.",
                            confirmLabel: "Delete",
                            destructive: true,
                          }))
                        )
                          return
                        void navigate("/")
                        actions
                          .deleteThread(meta.id)
                          .then(() =>
                            toast("Moved to Trash", {
                              description: meta.title,
                              action: {
                                label: "Undo",
                                onClick: () => {
                                  actions
                                    .restoreThread(meta.id)
                                    .catch((err) => reportError(err, "Couldn't restore the thread"))
                                },
                              },
                            })
                          )
                          .catch((err) => reportError(err, "Couldn't delete the thread"))
                      })
                    }
                  >
                    <Trash2 />
                    Move this thread to Trash
                  </CommandItem>
                </CommandGroup>
              )}

              {sessions.length > 0 && (
                <CommandGroup heading="Threads">
                  {sessions.map((session) => (
                    <ThreadItemRow
                      key={session.id}
                      session={session}
                      running={
                        state.threads[session.id]?.turnActive ?? session.promptActive
                      }
                      project={projectName(session.projectId)}
                      onSelect={() =>
                        run(() => {
                          setOpenMobile(false)
                          void navigate(threadPath(session.id))
                        })
                      }
                    />
                  ))}
                </CommandGroup>
              )}

              {messageHits.length > 0 && search.length >= 2 && (
                <CommandGroup heading="Messages">
                  {messageHits.map((hit) => (
                    <MessageHitRow
                      key={`${hit.sessionId}:${hit.seq}`}
                      hit={hit}
                      // The current query rides in the value so cmdk's filter —
                      // which never saw the transcript — cannot drop a row the
                      // server already matched.
                      query={search}
                      onSelect={() =>
                        run(() => {
                          setOpenMobile(false)
                          void navigate(threadPath(hit.sessionId))
                        })
                      }
                    />
                  ))}
                </CommandGroup>
              )}

              <CommandGroup heading="Go to">
                {SETTINGS_SECTIONS.map((section) => (
                  <SectionItem key={section.id} section={section} onSelect={run} />
                ))}
              </CommandGroup>

              <CommandGroup heading="Appearance">
                <CommandItem
                  value="change color theme palette skin"
                  onSelect={() => descend("theme")}
                >
                  <Palette />
                  Change color theme…
                </CommandItem>
                {MODES.map(({ value, label, icon: Icon }) => (
                  <CommandItem
                    key={value}
                    value={`appearance mode ${label}`}
                    data-checked={theme === value}
                    onSelect={() => run(() => setTheme(value))}
                  >
                    <Icon />
                    {label} mode
                  </CommandItem>
                ))}
                {/* Size stays open: nudging is iterative, and closing after every
                    step would make you reopen the palette to reach the next one. */}
                <CommandItem
                  value="increase text size bigger font zoom in"
                  onSelect={() => setFontSize(fontSize + 1)}
                >
                  <Plus />
                  Bigger text
                  <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                    {fontSize}px
                  </span>
                </CommandItem>
                <CommandItem
                  value="decrease text size smaller font zoom out"
                  onSelect={() => setFontSize(fontSize - 1)}
                >
                  <Minus />
                  Smaller text
                  <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                    {fontSize}px
                  </span>
                </CommandItem>
                {fontSize !== FONT_SIZE_DEFAULT && (
                  <CommandItem
                    value="reset text size default font"
                    onSelect={() => setFontSize(FONT_SIZE_DEFAULT)}
                  >
                    <RotateCcw />
                    Reset text size
                  </CommandItem>
                )}
                <CommandItem value="toggle sidebar panel collapse" onSelect={() => run(toggleSidebar)}>
                  <PanelLeft />
                  Toggle sidebar
                  <CommandShortcut>{formatChord(KEYS.sidebar)}</CommandShortcut>
                </CommandItem>
                <CommandItem
                  value="keyboard shortcuts keys bindings help"
                  onSelect={() => run(onShortcuts)}
                >
                  <Keyboard />
                  Keyboard shortcuts
                  <CommandShortcut>?</CommandShortcut>
                </CommandItem>
              </CommandGroup>

              <CommandSeparator />
              <CommandGroup heading="Server">
                {servers
                  .filter((server) => server.id !== activeServer?.id)
                  .map((server) => (
                    <CommandItem
                      key={server.id}
                      value={`switch server ${server.name} ${server.url}`}
                      onSelect={() =>
                        run(() => {
                          setActiveServer(server.id)
                          window.location.assign("/")
                        })
                      }
                    >
                      <ServerIcon />
                      Switch to {server.name}
                      <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">
                        {server.url}
                      </span>
                    </CommandItem>
                  ))}
                <CommandItem
                  value="disconnect sign out log out forget token"
                  onSelect={() =>
                    run(() => {
                      clearSettings()
                      window.location.assign("/")
                    })
                  }
                >
                  <LogOut />
                  Disconnect from this server
                </CommandItem>
              </CommandGroup>
            </>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  )
}

const PLACEHOLDERS: Record<Page, string> = {
  root: "Search threads and commands…",
  theme: "Search palettes…",
  model: "Search models…",
  effort: "Search effort levels…",
  mode: "Search permission modes…",
}

/** One option in a sub-page — the tick comes from CommandItem's data-checked. */
function ChoiceItem({
  icon: Icon,
  label,
  prefix,
  selected,
  onSelect,
  capitalize,
  muted,
}: {
  icon: typeof Palette
  label: string
  prefix: string
  selected: boolean
  onSelect: () => void
  capitalize?: boolean
  muted?: boolean
}) {
  return (
    <CommandItem
      value={`${prefix} ${label}`}
      data-checked={selected}
      onSelect={onSelect}
      className={muted ? "text-muted-foreground" : undefined}
    >
      <Icon className={selected ? "text-primary" : undefined} />
      <span className={capitalize ? "capitalize" : undefined}>{label}</span>
    </CommandItem>
  )
}

function ThreadItemRow({
  session,
  project,
  running,
  onSelect,
}: {
  session: SessionMeta
  project: string
  running: boolean
  onSelect: () => void
}) {
  return (
    <CommandItem value={`thread ${session.title} ${project} ${session.id}`} onSelect={onSelect}>
      <MessageSquareIcon className={session.exited ? "opacity-50" : undefined} />
      <span className={cn("truncate", running && "harness-shimmer text-primary")}>
        {session.title}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
        <FolderIcon className="size-3" />
        {project}
        <span className="tabular-nums opacity-70">· {shortAge(session.createdAt)}</span>
      </span>
    </CommandItem>
  )
}

/** One full-text hit: thread title, the snippet with its matches emphasised
    (decoded from marker codepoints into spans — never markup), the project on
    the trailing edge. Selecting opens the thread; the transcript's own
    windowed replay takes it from there. */
function MessageHitRow({
  hit,
  query,
  onSelect,
}: {
  hit: SearchResult
  query: string
  onSelect: () => void
}) {
  return (
    <CommandItem
      value={`message ${hit.sessionId} ${hit.seq} ${query}`}
      onSelect={onSelect}
      className="items-start"
    >
      <MessageSquareIcon className="mt-0.5" />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{hit.title}</span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {snippetParts(hit.snippet).map((part, i) =>
            part.match ? (
              <span key={i} className="font-semibold text-foreground">
                {part.text}
              </span>
            ) : (
              <React.Fragment key={i}>{part.text}</React.Fragment>
            )
          )}
        </span>
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
        <FolderIcon className="size-3" />
        {hit.projectName || "Other"}
        <span className="tabular-nums opacity-70">· {shortAge(hit.at)}</span>
      </span>
    </CommandItem>
  )
}

function SectionItem({
  section,
  onSelect,
}: {
  section: (typeof SETTINGS_SECTIONS)[number]
  onSelect: (fn: () => void) => void
}) {
  const navigate = useNavigate()
  const Icon = section.icon
  return (
    <CommandItem
      value={`settings ${section.label} ${section.title}`}
      onSelect={() => onSelect(() => void navigate(settingsPath(section.id)))}
    >
      <Icon />
      {section.label}
      <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">Settings</span>
    </CommandItem>
  )
}
