import * as React from "react"
import {
  DockviewReact,
  themeAbyss,
  themeLight,
  type DockviewApi,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from "dockview-react"
import "dockview-react/dist/styles/dockview.css"
import { MessageSquareIcon, XIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { ErrorBoundary } from "@/components/error-boundary"
import { ItemContextMenu, type MenuItemSpec } from "@/components/item-context-menu"
import { reportError } from "@/lib/errors"
import { ThreadView } from "@/components/thread-view"
import { navigateTo, threadPath } from "@/lib/router"
import type { Actions } from "@/lib/actions"
import { useStore } from "@/lib/store"
import { useTheme } from "@/lib/theme"
import { cn } from "@/lib/utils"

const STORAGE_KEY = "daedalus.sessionDock.v1"

const isChat = (panel: { api: { component: string } }) => panel.api.component === "chat"

function ChatPanel({
  actions,
  api,
  params,
}: IDockviewPanelProps<{ sessionId: string }> & { actions: Actions }) {
  const { state } = useStore()
  const meta = state.sessions.find((session) => session.id === params.sessionId)

  React.useEffect(() => {
    if (!meta) return
    // openThread writes the failure into the thread itself, which is the panel
    // the user is already staring at — nothing more to do here.
    actions.openThread(meta).catch(() => {})
  }, [actions, meta])

  React.useEffect(() => {
    api.setTitle(meta?.title || "Thread")
  }, [api, meta?.title])

  if (!meta) return null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ErrorBoundary name="this thread" resetKeys={[meta.id]}>
        <ThreadView key={meta.id} sessionId={meta.id} actions={actions} />
      </ErrorBoundary>
    </div>
  )
}

function SessionTab({ api, containerApi, params }: IDockviewPanelHeaderProps) {
  const [active, setActive] = React.useState(api.isActive)
  const [closable, setClosable] = React.useState(false)
  const [hasOthers, setHasOthers] = React.useState(false)
  const [hasRightward, setHasRightward] = React.useState(false)

  React.useEffect(() => {
    const disposable = api.onDidActiveChange((event) => setActive(event.isActive))
    return () => disposable.dispose()
  }, [api])

  // Chat tabs sharing this tab's group, in tab order. Recomputed inside every
  // menu handler too — a snapshot taken at render could close the wrong tabs.
  const groupChats = React.useCallback(() => {
    const self = containerApi.getPanel(api.id)
    return self ? self.group.panels.filter(isChat) : []
  }, [api, containerApi])

  React.useEffect(() => {
    const sync = () => {
      setClosable(containerApi.panels.filter(isChat).length > 1)
      const chats = groupChats()
      const index = chats.findIndex((panel) => panel.id === api.id)
      setHasOthers(chats.length > 1)
      setHasRightward(index >= 0 && index < chats.length - 1)
    }
    sync()
    const disposables = [
      containerApi.onDidAddPanel(sync),
      containerApi.onDidRemovePanel(sync),
      // Dragging a tab between groups changes the siblings without adding
      // or removing a panel.
      containerApi.onDidLayoutChange(sync),
    ]
    return () => disposables.forEach((disposable) => disposable.dispose())
  }, [api, containerApi, groupChats])

  const sessionId = (params as { sessionId?: string }).sessionId
  const items: MenuItemSpec[] = [
    { label: "Close", disabled: !closable, onClick: () => api.close() },
    {
      label: "Close others",
      disabled: !hasOthers,
      onClick: () => {
        for (const panel of groupChats()) {
          if (panel.id !== api.id) containerApi.removePanel(panel)
        }
      },
    },
    {
      label: "Close to the right",
      disabled: !hasRightward,
      onClick: () => {
        const chats = groupChats()
        const index = chats.findIndex((panel) => panel.id === api.id)
        if (index < 0) return
        for (const panel of chats.slice(index + 1)) containerApi.removePanel(panel)
      },
    },
    { type: "separator" },
    {
      label: "Copy link",
      disabled: !sessionId,
      onClick: () => {
        if (!sessionId) return
        navigator.clipboard
          .writeText(new URL(threadPath(sessionId), window.location.origin).toString())
          .then(() => toast.success("Link copied"))
          .catch((err) => reportError(err, "Couldn't copy the link"))
      },
    },
  ]

  return (
    <ItemContextMenu items={items}>
      <div className="flex h-full items-center py-1">
        <div
          className={cn(
            "flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-xs transition-colors",
            active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          )}
        >
          <MessageSquareIcon className="size-3.5 shrink-0" />
          <span className="max-w-40 truncate">{api.title ?? "Thread"}</span>
          {closable && (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Close tab"
              className="-mr-1 size-5 opacity-60 hover:opacity-100"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                api.close()
              }}
            >
              <XIcon className="size-3" />
            </Button>
          )}
        </div>
      </div>
    </ItemContextMenu>
  )
}

export function useSessionDock() {
  const apiRef = React.useRef<DockviewApi | null>(null)

  const openChat = React.useCallback((sessionId: string, options?: { newTab?: boolean }) => {
    const api = apiRef.current
    if (!api) return

    const existing = api.getPanel(`thread:${sessionId}`)
    if (existing) {
      existing.api.setActive()
      return
    }

    const chats = api.panels.filter(isChat)
    const current =
      chats.find((panel) => panel.api.isActive) ??
      chats.find((panel) => panel.group.activePanel === panel) ??
      chats[0]
    const group = current?.group
    const replace = current && !options?.newTab
    const index = replace ? group.panels.indexOf(current) + 1 : undefined

    api.addPanel({
      id: `thread:${sessionId}`,
      component: "chat",
      title: "Thread",
      params: { sessionId },
      position: group ? { referenceGroup: group.id, direction: "within", index } : undefined,
    })

    if (replace) api.removePanel(current)
  }, [])

  const onReady = React.useCallback(
    (api: DockviewApi) => {
      apiRef.current = api
      try {
        const saved = localStorage.getItem(STORAGE_KEY)
        if (saved) {
          api.fromJSON(JSON.parse(saved))
        }
      } catch {
      }

      const syncChrome = () => {
        const hidden = api.groups.length === 1 && api.panels.length === 1
        for (const group of api.groups) {
          if (group.header.hidden !== hidden) group.header.hidden = hidden
        }
      }
      queueMicrotask(syncChrome)
      const disposables = [
        api.onDidAddPanel(syncChrome),
        api.onDidRemovePanel(syncChrome),
        api.onDidAddGroup(syncChrome),
        api.onDidRemoveGroup(syncChrome),
        api.onDidActivePanelChange(({ panel }) => {
          if (!panel || !panel.api.isActive || !isChat(panel)) return
          const sessionId = (panel.params as { sessionId?: string }).sessionId
          if (sessionId && location.pathname !== threadPath(sessionId))
            navigateTo(threadPath(sessionId), { replace: true })
        }),
      ]

      let saveTimer: ReturnType<typeof setTimeout> | undefined
      disposables.push(
        api.onDidLayoutChange(() => {
          clearTimeout(saveTimer)
          saveTimer = setTimeout(() => {
            try {
              localStorage.setItem(STORAGE_KEY, JSON.stringify(api.toJSON()))
            } catch (error) {
              console.warn("Could not persist session tabs", error)
            }
          }, 300)
        })
      )

    },
    []
  )

  const pruneMissingSessions = React.useCallback((liveIds: Iterable<string>) => {
    const api = apiRef.current
    if (!api) return
    const live = new Set(liveIds)
    for (const panel of [...api.panels]) {
      const sessionId = (panel.params as { sessionId?: string }).sessionId
      if (isChat(panel) && (!sessionId || !live.has(sessionId))) api.removePanel(panel)
    }
  }, [])

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const api = apiRef.current
      if (!api || event.repeat) return

      if ((event.metaKey || event.ctrlKey) && !event.altKey && /^[1-9]$/.test(event.key)) {
        const panel = api.panels.filter(isChat)[Number(event.key) - 1]
        if (!panel) return
        event.preventDefault()
        panel.api.setActive()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  React.useEffect(() => () => void (apiRef.current = null), [])

  return React.useMemo(
    () => ({ apiRef, openChat, onReady, pruneMissingSessions }),
    [openChat, onReady, pruneMissingSessions]
  )
}

export type { DockviewApi }

export function SessionDock({
  actions,
  onReady,
}: {
  actions: Actions
  onReady: (api: DockviewApi) => void
}) {
  const { resolved } = useTheme()
  const theme = React.useMemo(() => (resolved === "dark" ? themeAbyss : themeLight), [resolved])
  const components = React.useMemo(() => ({ chat: (props: IDockviewPanelProps<{ sessionId: string }>) => (
    <ChatPanel {...props} actions={actions} />
  ) }), [actions])

  return (
    <DockviewReact
      className="session-dock h-full min-h-0 flex-1"
      components={components}
      defaultRenderer="always"
      defaultTabComponent={SessionTab}
      disableFloatingGroups
      onReady={(event) => onReady(event.api)}
      theme={theme}
    />
  )
}
