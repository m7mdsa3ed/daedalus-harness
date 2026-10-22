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
  Activity,
  Copy,
  ExternalLink,
  Eye,
  FolderOpen,
  GitBranchIcon,
  Link as LinkIcon,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Play,
  Plug,
  RefreshCw,
  RotateCcw,
  Square,
  SquareTerminal,
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
import { openInItems } from "@/components/open-in-menu"
import { MENU_ROW, MENU_WIDTH, MenuRow } from "@/components/menu-row"
import { ChangelogDialog } from "@/components/changelog-dialog"
import { useAppMeta } from "@/lib/queries"
import { releaseUnseen, useSeenRelease } from "@/lib/whats-new"
import { useConfirm } from "@/components/confirm-dialog"
import { usePrompt } from "@/components/prompt-dialog"
import type { Actions } from "@/lib/actions"
import { describeError, reportError } from "@/lib/errors"
import { usePins } from "@/lib/pins"
import { projectPath, settingsFormPath, threadPath } from "@/lib/router"
import { ApiError, type HelperCommand, type Project, type SessionMeta } from "@/lib/settings"
import { useProjects } from "@/lib/queries/catalog"
import { useServer } from "@/lib/server-context"
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

const pinItem = (
  session: SessionMeta,
  pinned: boolean,
  pin: (session: SessionMeta) => void
): MenuItemSpec => ({
  label: pinned ? "Unpin" : "Pin to top",
  icon: pinned ? <PinOff /> : <Pin />,
  onClick: () => pin(session),
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

/** "Remove worktree", for an isolated thread whose checkout is still there.
    Archiving leaves it on purpose — the work is in it — so this is the
    deliberate second step, on both the live and the Trash menu. */
const worktreeItems = (
  session: SessionMeta,
  onRemove?: (session: SessionMeta) => void
): MenuItemSpec[] =>
  onRemove && session.worktree && session.worktree.exists !== false
    ? [{ label: "Remove worktree", icon: <GitBranchIcon />, onClick: () => onRemove(session) }]
    : []

/** The row menu for a live thread — Trash rows get their own two items.
    `beside` is false on a phone, where "Open to the side" would be undone by
    the fold before the column was read. */
export function threadMenuItems(
  session: SessionMeta,
  pinned: boolean,
  handlers: {
    onRename: (session: SessionMeta) => void
    onDelete: (session: SessionMeta) => void
    onPin: (session: SessionMeta) => void
    onRemoveWorktree?: (session: SessionMeta) => void
  },
  options: { beside?: boolean } = {}
): MenuItemSpec[] {
  /* ── Open comes first ──
     Clicking the row navigates the tab in front, which is what a tab is for;
     the two rows above the separator are the *other* two shapes it can take
     (`openInItems` — one vocabulary shared with every other place-shaped row in
     the chrome, and the same one a drag into the dock performs). They are not a
     second name for the click: one adds a tab and the other splits the dock. */
  return [
    ...openInItems(threadPath(session.id), options),
    { type: "separator" },
    renameItem(session, handlers.onRename),
    pinItem(session, pinned, handlers.onPin),
    { label: "Copy link", icon: <LinkIcon />, onClick: () => copyThreadLink(session) },
    { type: "separator" },
    ...worktreeItems(session, handlers.onRemoveWorktree),
    deleteItem(session, handlers.onDelete),
  ]
}

export function trashMenuItems(
  session: SessionMeta,
  restore: (session: SessionMeta) => void,
  purge: (session: SessionMeta) => void,
  removeWorktree?: (session: SessionMeta) => void
): MenuItemSpec[] {
  return [
    { label: "Restore", icon: <Undo2 />, onClick: () => restore(session) },
    ...worktreeItems(session, removeWorktree),
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

  const pin = React.useCallback(
    (session: SessionMeta) => {
      actions.togglePin(session.id).catch((err) => reportError(err, "Couldn't pin the thread"))
    },
    [actions]
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

  /* Asked once plainly; when the server refuses because of uncommitted work,
     its refusal — which names the files — is the second question. */
  const removeWorktree = React.useCallback(
    async (session: SessionMeta) => {
      const branch = session.worktree?.branch ?? "its branch"
      if (
        !(await confirm({
          title: "Remove this thread's worktree?",
          description: `The checkout under ${session.worktree?.path ?? ".daedalus/worktrees"} is deleted; the branch ${branch} and its commits are kept. The thread cannot run again without it.`,
          confirmLabel: "Remove",
          destructive: true,
        }))
      )
        return
      try {
        await actions.removeWorktree(session.id)
        toast.success("Worktree removed", { description: `Branch ${branch} is kept.` })
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 409)) {
          reportError(err, "Couldn't remove the worktree")
          return
        }
        if (
          !(await confirm({
            title: "Remove it anyway?",
            description: describeError(err).title,
            confirmLabel: "Remove anyway",
            destructive: true,
          }))
        )
          return
        actions
          .removeWorktree(session.id, true)
          .then(() => toast.success("Worktree removed", { description: `Branch ${branch} is kept.` }))
          .catch((again) => reportError(again, "Couldn't remove the worktree"))
      }
    },
    [confirm, actions]
  )

  return { rename, remove, restore, purge, pin, removeWorktree }
}

import { writeClipboard } from "@/lib/clipboard"
