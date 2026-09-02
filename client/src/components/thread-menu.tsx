/* ── A thread's actions ── one vocabulary, two surfaces.

   The sidebar row (the ⋯ menu, and the right-click — or long-press, on a
   phone — context menu) is where a thread's own actions live — rename, pin,
   open in a new tab, copy its link, delete — and it is the surface that has
   *every* thread, not just the routed one. The header's ⋯ now offers the same
   list behind one row,
   because the sidebar is not always there to be asked: it is collapsed on a
   narrow screen, and the thread the reader means is the one already on screen.

   So the header menu is three rows deep by design. "Open a panel" is a
   submenu of the workspace group, and everything about the routed thread —
   the sidebar's five, plus what only this surface can say (Refresh, the
   Connection submenu, its id, the project it runs in) — is behind "This
   thread". Both lists are still built here, next to the row's, so the two
   surfaces cannot drift apart. */
import * as React from "react"
import {
  Copy,
  ExternalLink,
  Eye,
  FolderOpen,
  Link as LinkIcon,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plug,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2,
  Undo2,
} from "lucide-react"
import { useNavigate } from "react-router"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { renderMenuItems, type MenuItemSpec } from "@/components/item-context-menu"
import { useConfirm } from "@/components/confirm-dialog"
import { SessionSettingsDialog } from "@/components/session-settings"
import { WorkspacePanelItems } from "@/components/workspace/panel-items"
import type { PanelKind } from "@/lib/workspace/panels"
import { usePrompt } from "@/components/prompt-dialog"
import type { Actions } from "@/lib/actions"
import { reportError } from "@/lib/errors"
import { togglePin, usePins } from "@/lib/pins"
import { projectPath, threadPath } from "@/lib/router"
import { type SessionMeta } from "@/lib/settings"
import { useStoreSelect } from "@/lib/store"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"

/** Copy the address of a thread. The one action that is the same sentence on
    every surface, so it is written once. */
function copyThreadLink(session: SessionMeta) {
  writeClipboard(new URL(threadPath(session.id), window.location.origin).toString())
    .then(() => toast.success("Link copied"))
    .catch((err) => reportError(err, "Couldn't copy the link"))
}

/** What the server caps a hand-typed title at (`TITLE_MAX` in sessions.ts) —
    stated here so the box stops where the server would trim, rather than
    accepting text it silently loses. */
const TITLE_MAX = 200

const pinItem = (session: SessionMeta, pinned: boolean): MenuItemSpec => ({
  label: pinned ? "Unpin" : "Pin to top",
  icon: pinned ? <PinOff /> : <Pin />,
  onClick: () => togglePin(session.id),
})

const renameItem = (session: SessionMeta, rename: (session: SessionMeta) => void): MenuItemSpec => ({
  label: "Rename",
  icon: <Pencil />,
  onClick: () => rename(session),
})

const deleteItem = (
  session: SessionMeta,
  onDelete: (session: SessionMeta) => void
): MenuItemSpec => ({
  label: "Delete",
  icon: <Trash2 />,
  destructive: true,
  onClick: () => onDelete(session),
})

/** The row menu for a live thread — Trash rows get their own two items. */
export function threadMenuItems(
  session: SessionMeta,
  pinned: boolean,
  handlers: {
    openInNewTab: () => void
    onRename: (session: SessionMeta) => void
    onDelete: (session: SessionMeta) => void
  }
): MenuItemSpec[] {
  return [
    renameItem(session, handlers.onRename),
    pinItem(session, pinned),
    { label: "Open in new tab", icon: <ExternalLink />, onClick: handlers.openInNewTab },
    { label: "Copy link", icon: <LinkIcon />, onClick: () => copyThreadLink(session) },
    { type: "separator" },
    deleteItem(session, handlers.onDelete),
  ]
}

export function trashMenuItems(
  session: SessionMeta,
  restore: (session: SessionMeta) => void,
  purge: (session: SessionMeta) => void
): MenuItemSpec[] {
  return [
    { label: "Restore", icon: <Undo2 />, onClick: () => restore(session) },
    { type: "separator" },
    {
      label: "Delete forever",
      icon: <Trash2 />,
      destructive: true,
      onClick: () => purge(session),
    },
  ]
}

/**
 * Delete / restore / purge, with the confirmations and the Undo toast.
 *
 * Shared by the sidebar list and the header menu: deleting a thread stops an
 * agent and can kill a running turn, so the sentence that asks about it must
 * be the same one wherever it is asked — and the toast's one-click way back
 * has to exist on both.
 */
export function useThreadRowActions(
  actions: Actions,
  opts: { activeThreadId?: string | null; onLeave?: () => void } = {}
) {
  const confirm = useConfirm()
  const prompt = usePrompt()
  const { activeThreadId } = opts
  /* Held in a ref, not closed over: the sidebar hands over an inline arrow and
     its rows are memoized on these handlers — a fresh identity per render
     would re-render every row on every streamed token. */
  const leave = React.useRef(opts.onLeave)
  leave.current = opts.onLeave

  const remove = React.useCallback(
    async (session: SessionMeta) => {
      /* A draft was never started: no process to stop, no server row, and
         nothing for Trash to hold. Discarding it is the whole operation. */
      if (session.draft) {
        if (
          !(await confirm({
            title: "Discard this thread?",
            description:
              "It was never started, so there is no agent to stop and nothing to restore afterwards.",
            confirmLabel: "Discard",
            destructive: true,
          }))
        )
          return
        if (activeThreadId === session.id) leave.current?.()
        void actions.deleteThread(session.id)
        return
      }
      if (
        !(await confirm({
          title: `Delete "${session.title}"?`,
          description:
            "The agent process is stopped and the thread moves to Trash, where it can be restored.",
          confirmLabel: "Delete",
          destructive: true,
        }))
      )
        return
      // Leave the route first: a deleted thread has no page to show.
      if (activeThreadId === session.id) leave.current?.()
      actions
        .deleteThread(session.id)
        .then(() =>
          toast("Moved to Trash", {
            description: session.title,
            action: {
              label: "Undo",
              onClick: () => {
                actions
                  .restoreThread(session.id)
                  .catch((err) => reportError(err, "Couldn't restore the thread"))
              },
            },
          })
        )
        .catch((err) => reportError(err, "Couldn't delete the thread"))
    },
    [confirm, activeThreadId, actions]
  )

  /* Asking for the name and saving it are one action, so they are one
     callback: every surface that offers Rename offers the same dialog, the
     same trim and the same failure. A draft is renamed too — its name is
     carried into the create call by the first message. */
  const rename = React.useCallback(
    async (session: SessionMeta) => {
      const title = await prompt({
        title: "Rename thread",
        value: session.title,
        placeholder: "Thread name",
        confirmLabel: "Rename",
        maxLength: TITLE_MAX,
      })
      if (title === null || title === session.title) return
      actions
        .renameThread(session.id, title)
        .catch((err) => reportError(err, "Couldn't rename the thread"))
    },
    [actions, prompt]
  )

  const restore = React.useCallback(
    (session: SessionMeta) => {
      actions
        .restoreThread(session.id)
        .catch((err) => reportError(err, "Couldn't restore the thread"))
    },
    [actions]
  )

  const purge = React.useCallback(
    async (session: SessionMeta) => {
      if (
        !(await confirm({
          title: `Delete "${session.title}" forever?`,
          description:
            "The harness forgets this thread. Only the agent's own transcript file would still have the conversation.",
          confirmLabel: "Delete forever",
          destructive: true,
        }))
      )
        return
      actions
        .purgeThread(session.id)
        .catch((err) => reportError(err, "Couldn't delete the thread"))
    },
    [confirm, actions]
  )

  return { rename, remove, restore, purge }
}

/**
 * The app header's one menu.
 *
 * It used to be three icon buttons in a 12px-tall header — a + that opened a
 * menu, an eye that opened a dialog, and Refresh — which is a row you have to
 * learn rather than read, and on a phone it is three targets in the space of
 * one. So there is a single ⋯ now, and its root is three lines:
 *
 *   - New thread, with "Open a panel" folded behind it — drawn by their own
 *     module so the chords they print stay bound in one place;
 *   - "This thread", which is every action the sidebar row offers *plus* the
 *     ones only this surface can perform, built from the same builders the
 *     row uses so the two lists say the same words;
 *   - View settings, which opens the dialog it always did.
 *
 * Refresh is the first thread row because it is the reflexive one — the
 * transcript on screen may be a replay from a socket that has since gone
 * quiet, and "is this still what the server thinks" should be one press. It is
 * `reconnectThread`, which is already the whole operation: re-read the session
 * list, drop the half-open socket, reattach — reviving the process when there
 * is none — so the transcript comes back as the server has it. A draft has no
 * server row and no socket, so its rows are disabled rather than dropped: a
 * control that comes and goes with a thread's state is one you have to hunt
 * for.
 *
 * `session` is optional because the workspace half of the menu is not about a
 * thread at all — with none routed the menu is still how a thread is started.
 */
export function ThreadHeaderMenu({
  actions,
  session,
  onNewTab,
  onOpenPanel,
  onOpenPreview,
  onOpenInNewTab,
}: {
  actions: Actions
  session?: SessionMeta
  onNewTab: () => void
  onOpenPanel: (kind: PanelKind) => void
  /** The preview row — only when the thread's project can run one. */
  onOpenPreview?: () => void
  /** Open the routed thread in a second dock tab — the sidebar row's action,
      which needs the dock and so is handed down rather than done here. */
  onOpenInNewTab?: (session: SessionMeta) => void
}) {
  const navigate = useNavigate()
  const [viewSettings, setViewSettings] = React.useState(false)
  const [refreshing, setRefreshing] = React.useState(false)
  const sessionId = session?.id
  const pins = usePins()
  /* One boolean off one thread. This menu is drawn beside a live transcript,
     so reading the whole state here re-opened the question on every streamed
     token of every thread. Undefined = no live thread, which is what the
     fallback to the server's `promptActive` below is for. */
  const liveTurnActive = useStoreSelect((state) =>
    sessionId ? state.threads[sessionId]?.turnActive : undefined
  )
  /* The same three the sidebar list holds, from the same hook: deleting from
     here asks the same question, and leaves the route the same way. */
  const { rename, remove } = useThreadRowActions(actions, {
    activeThreadId: sessionId,
    onLeave: () => void navigate("/"),
  })
  const refresh = React.useCallback(() => {
    if (!sessionId || refreshing) return
    setRefreshing(true)
    actions
      .reconnectThread(sessionId)
      .catch((err) => reportError(err, "Couldn't refresh the thread"))
      .finally(() => setRefreshing(false))
  }, [actions, refreshing, sessionId])

  const items = session ? threadItems(session) : []

  function threadItems(thread: SessionMeta): MenuItemSpec[] {
    const turnActive = liveTurnActive ?? thread.promptActive
    const draft = thread.draft === true
    return [
      {
        label: refreshing ? "Refreshing…" : "Refresh",
        /* The spin is the only feedback a reattach gives: the transcript it
           rebuilds usually looks exactly like the one it replaced. */
        icon: <RefreshCw className={cn(refreshing && "animate-spin")} />,
        disabled: draft || refreshing,
        onClick: refresh,
      },
      {
        type: "sub",
        label: "Connection",
        icon: <Plug />,
        /* Everything about the *process* under this thread, which is the one
           subject only this surface can speak to. Disabled wholesale on a
           draft: there is no process yet, and each row would have to say so. */
        disabled: draft,
        items: [
          {
            /* The same call Refresh makes, under the name somebody looks for
               after a socket has died — which is what the transcript's own
               recovery button already calls it. */
            label: "Reconnect",
            icon: <RotateCcw />,
            disabled: refreshing,
            onClick: () => {
              actions
                .reconnectThread(thread.id)
                .catch((err) => reportError(err, "Couldn't reconnect the thread"))
            },
          },
          {
            label: "Revive the agent",
            icon: <Plug />,
            onClick: () => {
              actions
                .reviveThread(thread.id)
                .catch((err) => reportError(err, "Couldn't revive the thread"))
            },
          },
          { type: "separator" },
          {
            label: "Stop the turn",
            icon: <Square />,
            disabled: !turnActive,
            onClick: () => {
              actions.stop(thread.id).catch((err) => reportError(err, "Couldn't stop the turn"))
            },
          },
        ],
      },
      { type: "separator" },
      /* The sidebar row's own list, in the sidebar's order — the same
         builders, so a change to Rename or Pin reaches both surfaces. */
      renameItem(thread, rename),
      pinItem(thread, pins.includes(thread.id)),
      ...(onOpenInNewTab
        ? [
            {
              label: "Open in new tab",
              icon: <ExternalLink />,
              onClick: () => onOpenInNewTab(thread),
            } satisfies MenuItemSpec,
          ]
        : []),
      { label: "Copy link", icon: <LinkIcon />, onClick: () => copyThreadLink(thread) },
      {
        label: "Copy thread ID",
        icon: <Copy />,
        onClick: () => {
          writeClipboard(thread.id)
            .then(() => toast.success("Thread ID copied"))
            .catch((err) => reportError(err, "Couldn't copy the id"))
        },
      },
      {
        label: "Open the project",
        icon: <FolderOpen />,
        onClick: () => void navigate(projectPath(thread.projectId)),
      },
      { type: "separator" },
      deleteItem(thread, remove),
    ]
  }

  const parts = {
    Item: DropdownMenuItem,
    Separator: DropdownMenuSeparator,
    Sub: DropdownMenuSub,
    SubTrigger: DropdownMenuSubTrigger,
    SubContent: DropdownMenuSubContent,
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-muted-foreground hover:text-foreground"
              aria-label="Menu"
              title="Menu"
            >
              <MoreHorizontal />
            </Button>
          }
        />
        {/* `w-auto` undoes the anchor-width sizing (the trigger is a 28px icon
            button, so every row would be squeezed); the max is the escape
            hatch for a narrow phone, where a menu wider than the screen would
            be clipped rather than merely wide. */}
        <DropdownMenuContent
          align="end"
          className="w-auto max-w-[min(20rem,calc(100vw-1.5rem))] min-w-60"
        >
          <WorkspacePanelItems
            onNewTab={onNewTab}
            onOpen={onOpenPanel}
            onOpenPreview={onOpenPreview}
            canOpenPanels={!!session}
          />
          {items.length > 0 && (
            <>
              <DropdownMenuSeparator />
              {/* One row, not a labelled block: the thread's list is long now
                  that it carries the sidebar's actions too, and the header is
                  not where somebody reads a list — it is where they reach for
                  one thing they already have in mind. */}
              <DropdownMenuGroup>
                {renderMenuItems(
                  [{ type: "sub", label: "This thread", icon: <MessageSquare />, items }],
                  parts
                )}
              </DropdownMenuGroup>
            </>
          )}
          <DropdownMenuSeparator />
          {/* Device-global, and about every thread rather than this one — so it
              sits below the thread's own rows, not among them. */}
          <DropdownMenuItem onClick={() => setViewSettings(true)}>
            <Eye />
            View settings
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <SessionSettingsDialog open={viewSettings} onOpenChange={setViewSettings} />
    </>
  )
}
import { writeClipboard } from "@/lib/clipboard"
