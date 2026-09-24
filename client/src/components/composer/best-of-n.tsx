/* ── Best-of-N ──
   The chevron beside Send: "Send to several threads…" — the same message to
   2–4 new threads, each optionally on a different model, each isolated in a
   git worktree of its own so their edits cannot collide, opened side by side
   in a new dock group to be compared.

   No new concept: every copy is a draft minted through the one door
   (`actions.startThreadIn`), retuned through `configureDraft` without
   publishing (a copy's model is not the project's next default), and sent
   through `actions.send` — so each is exactly the thread the user would have
   made by hand. Offered only where isolation is (a project whose directory is
   a repository root) and only inside the dock. Attachments stay behind: a
   copy carries the words. */
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { ChevronDown, CopyIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { DockContext } from "@/components/workspace/dock-context"
import type { Actions } from "@/lib/actions"
import { reportError } from "@/lib/errors"
import { useProfiles, useProjects } from "@/lib/queries/catalog"
import { emptyDefaults, resolveThreadStart } from "@/lib/thread-defaults"
import { gitReposKey } from "@/lib/queries/keys"
import { useServer } from "@/lib/server-context"
import type { SessionMeta } from "@/lib/settings"
import { cn } from "@/lib/utils"
import { gitRepos } from "@/lib/workspace/git-api"

const COUNTS = [2, 3, 4] as const

export function BestOfNMenu({
  meta,
  actions,
  text,
  size,
  disabled,
  onSent,
}: {
  meta?: SessionMeta
  actions: Actions
  text: string
  size: "icon-xs" | "icon-sm"
  disabled: boolean
  /** The words have gone out as copies: clear the box. */
  onSent: () => void
}) {
  const dock = React.useContext(DockContext)
  const settings = useServer()
  const projectId = meta?.projectId ?? ""
  const repos = useQuery({
    queryKey: gitReposKey(settings, projectId),
    queryFn: ({ signal }) => gitRepos(settings, projectId, signal),
    enabled: !!projectId && !!dock,
    staleTime: 60_000,
  })
  const [open, setOpen] = React.useState(false)
  if (!meta || !dock || !repos.data?.some((repo) => repo.path === "")) return null

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size={size}
              className="shrink-0 rounded-pill text-muted-foreground hover:text-foreground [&_svg]:size-3.5"
              disabled={disabled}
              title="More ways to send"
              aria-label="More ways to send"
            >
              <ChevronDown />
            </Button>
          }
        />
        <DropdownMenuContent align="end" side="top" className="w-56">
          <DropdownMenuItem onClick={() => setOpen(true)}>
            <CopyIcon />
            Send to several threads…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <BestOfNDialog
        open={open}
        onOpenChange={setOpen}
        meta={meta}
        text={text}
        onSend={(models) => {
          const ids: string[] = []
          for (const model of models) {
            const id = actions.startThreadIn({ projectId: meta.projectId })
            if (!id) break
            actions.configureDraft(id, { isolate: true, ...(model ? { model } : {}) }, false)
            ids.push(id)
          }
          if (ids.length === 0) {
            reportError(new Error("There is no project to start a thread in."), "Couldn't send to several threads")
            return
          }
          dock.openGroup(ids.map((sessionId) => ({ kind: "chat" as const, sessionId })))
          onSent()
          /* A task later, not now: `send` finds a draft by reading the
             last-*committed* store, and the drafts minted above commit when
             this click's render does. Each records its own failure in its own
             transcript. */
          setTimeout(() => {
            for (const id of ids) void actions.send(id, text).catch(() => {})
          }, 0)
        }}
      />
    </>
  )
}

function BestOfNDialog({
  open,
  onOpenChange,
  meta,
  text,
  onSend,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  meta: SessionMeta
  text: string
  /** One entry per copy: a model id, or "" for the project's default. */
  onSend: (models: string[]) => void
}) {
  /* The copies start where `startThreadIn` starts them — the project's own
     pair — so their models are that profile's, not necessarily this thread's. */
  const profiles = useProfiles()
  const project = useProjects().find((p) => p.id === meta.projectId)
  const start = project ? resolveThreadStart(project.defaults ?? emptyDefaults(), profiles) : null
  const models = start?.profile.models ?? []
  const [count, setCount] = React.useState<number>(2)
  const [picks, setPicks] = React.useState<string[]>([])
  React.useEffect(() => {
    if (open) setPicks([])
  }, [open])

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Send to several threads</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            The same message to new threads, each in its own git worktree and branch, opened side by
            side to compare.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Threads</span>
            <div role="radiogroup" aria-label="How many threads" className="flex gap-1 rounded-lg bg-muted p-0.5">
              {COUNTS.map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={count === n}
                  onClick={() => setCount(n)}
                  className={cn(
                    "min-w-8 rounded-md px-2 py-1 text-sm font-medium tabular-nums",
                    count === n ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"
                  )}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>

          {models.length > 0 ? (
            <ul className="space-y-1.5">
              {Array.from({ length: count }, (_, i) => (
                <li key={i} className="flex items-center gap-2 text-sm">
                  <span className="w-14 shrink-0 text-muted-foreground">Copy {i + 1}</span>
                  <select
                    aria-label={`Model for copy ${i + 1}`}
                    value={picks[i] ?? ""}
                    onChange={(event) => {
                      const next = [...picks]
                      next[i] = event.target.value
                      setPicks(next)
                    }}
                    className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-sm"
                  >
                    <option value="">Project default</option>
                    {models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.label}
                      </option>
                    ))}
                  </select>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">
              This profile lets the agent choose its own model, so every copy runs on the project's
              default.
            </p>
          )}

          <p className="line-clamp-3 rounded-md bg-muted/50 px-2 py-1.5 text-xs whitespace-pre-wrap text-muted-foreground">
            {text.trim()}
          </p>
        </div>

        <ResponsiveDialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!text.trim()}
            onClick={() => {
              onSend(Array.from({ length: count }, (_, i) => picks[i] ?? ""))
              onOpenChange(false)
            }}
          >
            Send to {count}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
