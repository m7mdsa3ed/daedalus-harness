/* ── The commit box ──
   What the panel is for: say what this work is, and commit it.

   It was an inline `<form>` in `repo-section.tsx` and is a component now,
   because the AI half grew a second question and the section had no business
   owning either. The shape it takes is the thread composer's, deliberately:
   a box you type into, and underneath it a row where the left is what will
   happen and the right is what can act on what you typed. Source control is
   the app's other place where a person writes a sentence and sends it, and
   the two reading differently was an accident of which file they grew up in.

   **Two AI questions, not one.** Drafting writes a message from the diff;
   enhancing rewrites the one you started against the same diff
   (`server/src/git.ts`'s `commitMessagePrompt` takes the draft as a section of
   the same prompt). Which button you get follows what is in the box, because
   they are the same gesture asked at two moments — the composer's enhancer
   makes exactly this bargain, and it is why the wand does not simply blank
   what someone has half-written.

   **The call is abortable and the abort is real.** The old draft button fired
   and hoped: switching repository or closing the panel mid-draft left a
   promise that came back and wrote into a box that had moved on. */
import * as React from "react"
import { PencilEdit02Icon, SparklesIcon, Tick02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { ActionIcon, actionClass, type ActionPhase } from "@/components/ui/action-state"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { IconAction } from "@/components/workspace/scm/shared"
import { canUseAi, gitPick } from "@/lib/ai-picks"
import { describeError } from "@/lib/errors"
import { useProfiles } from "@/lib/queries/catalog"
import { useServer } from "@/lib/server-context"
import { cn } from "@/lib/utils"
import { draftCommitMessage, gitCommit } from "@/lib/workspace/git-api"

export function CommitBox({
  projectId,
  repo,
  repoName,
  /** Drawn on the placeholder only where there is more than one repository. */
  named,
  branch,
  busy,
  commitPhase = "idle",
  /** Everything changed here, narrowed by the view's filter. */
  changeCount,
  stagedCount,
  unstagedCount,
  canAmend,
  prefill,
  onCommit,
  onError,
}: {
  projectId: string
  repo: string
  repoName: string
  named: boolean
  branch: string
  busy: boolean
  commitPhase?: ActionPhase
  changeCount: number
  stagedCount: number
  unstagedCount: number
  /** There is a commit to amend (not unborn). */
  canAmend?: boolean
  /** Words put back into the box — an undone commit's message. `id` changes
      per fill, so the same message undone twice still lands. */
  prefill?: { text: string; id: number } | null
  /** Answers false when the commit did not happen, so the message stays put. */
  onCommit: (message: string, amend: boolean) => Promise<boolean>
  /** A draft that failed belongs beside the box it was meant to fill, not in a
      toast over a panel the reader is already looking at. */
  onError: (message: string | null) => void
}) {
  const settings = useServer()
  const [message, setMessage] = React.useState("")
  const [drafting, setDrafting] = React.useState(false)
  /* Amend rewrites the last commit: with it on, the button needs no staged
     change (a reword is an amend), and the box holds the message being
     replaced — an empty box would amend it to nothing, which git refuses. */
  const [amend, setAmend] = React.useState(false)

  React.useEffect(() => {
    if (prefill) setMessage(prefill.text)
  }, [prefill])

  React.useEffect(() => {
    if (!canAmend) setAmend(false)
  }, [canAmend])

  const toggleAmend = async () => {
    const next = !amend
    setAmend(next)
    if (!next || message.trim()) return
    try {
      const last = await gitCommit(settings, projectId, "HEAD", repo || undefined)
      setMessage((current) => current || last.body)
    } catch (err) {
      onError(describeError(err).title)
    }
  }

  /* Source control has its own device-local pick (Settings › AI helpers),
     separate from the composer's enhancer: reading a diff and sharpening a
     sentence are different jobs, and the provider you want on your patches is
     not necessarily the one you want on your prose. */
  const profiles = useProfiles()
  /* Subscribed for the re-render — `resolveProfile` reads the remembered pick
     out of the store, so without these a pick made in Settings would not reach
     the button until something else re-rendered the panel. */
  gitPick.useProfileId()
  gitPick.useModelId()
  const draftProfile = React.useMemo(() => {
    const picked = gitPick.resolveProfile(profiles)
    return canUseAi(picked) ? picked : null
  }, [profiles])

  const abort = React.useRef<AbortController | null>(null)
  /* Repo and project are in the deps because this box is reused across them: a
     draft asked for one repository must not land in another's message. */
  React.useEffect(() => () => abort.current?.abort(), [projectId, repo])

  const typed = message.trim()

  const ask = React.useCallback(async () => {
    if (!draftProfile) return
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    setDrafting(true)
    onError(null)
    try {
      const { message: drafted } = await draftCommitMessage(
        settings,
        projectId,
        {
          profileId: draftProfile.id,
          model: gitPick.resolveModelId(draftProfile) || undefined,
          repo: repo || undefined,
          /* The one difference between the two questions. Empty means "write
             one"; anything else means "sharpen this". */
          ...(typed ? { draft: typed } : {}),
        },
        controller.signal
      )
      if (controller.signal.aborted) return
      setMessage(drafted)
    } catch (err) {
      if (controller.signal.aborted) return
      onError(describeError(err).title)
    } finally {
      if (abort.current === controller) {
        abort.current = null
        setDrafting(false)
      }
    }
  }, [draftProfile, settings, projectId, repo, typed, onError])

  const submit = async () => {
    if (!summary.trim()) return
    /* Cleared only on a commit that happened — a refused hook or a conflict
       leaves the words where the author can fix them and try again. */
    if (await onCommit(typed, amend)) {
      setMessage("")
      setAmend(false)
    }
  }

  /* One message, two boxes: the summary is the first line and the description
     is what follows the blank line, joined back with exactly one blank line -
     git's own convention, and what every other part of this box (the draft, the
     amend text, the undo prefill) already writes. */
  const nl = message.indexOf("\n")
  const summary = nl === -1 ? message : message.slice(0, nl)
  const description = nl === -1 ? "" : message.slice(nl).replace(/^\n+/, "")
  const join = (head: string, body: string) => (body ? `${head}\n\n${body}` : head)
  const descriptionRef = React.useRef<HTMLTextAreaElement>(null)

  const sendOnShortcut = (event: React.KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault()
      void submit()
    }
  }

  return (
    <form
      className="space-y-1.5 border-t border-border/60 p-2"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <div className="flex items-center gap-1">
        <Input
          value={summary}
          onChange={(event) => setMessage(join(event.target.value.replace(/\n/g, " "), description))}
          placeholder={amend ? "Amended summary" : named ? `Commit to ${repoName}` : "Commit summary"}
          aria-label="Commit summary"
          className="h-7 min-w-0 flex-1 text-xs"
          onKeyDown={(event) => {
            sendOnShortcut(event)
            if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
              event.preventDefault()
              descriptionRef.current?.focus()
            }
          }}
        />
        <span className={cn("w-6 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-foreground", summary.length > 72 && "text-amber-600 dark:text-amber-400")} title="Summary length - 72 or fewer reads well in a log">
          {summary.length}
        </span>
        {canAmend && (
          <IconAction
            label={amend ? "Stop amending" : "Amend the last commit"}
            icon={PencilEdit02Icon}
            disabled={busy}
            variant={amend ? "secondary" : "ghost"}
            className={cn(amend && "text-primary")}
            onClick={() => void toggleAmend()}
          />
        )}
        {/* Offered only where there is a profile that can do it: a disabled
            wand nobody can enable is worse than no wand. The label is the only
            thing that changes between the two questions - one control, because
            to the reader it is one gesture applied to whatever is in the box. */}
        {draftProfile &&
          (drafting ? (
            <span className="flex size-6 shrink-0 items-center justify-center" aria-live="polite">
              <Spinner className="size-3.5" />
              <span className="sr-only">
                {typed ? "Rewriting the message…" : "Drafting the message…"}
              </span>
            </span>
          ) : (
            <IconAction
              label={
                typed
                  ? `Rewrite this message with ${draftProfile.name}`
                  : `Draft the message with ${draftProfile.name}`
              }
              icon={SparklesIcon}
              disabled={busy || changeCount === 0}
              onClick={() => void ask()}
            />
          ))}
      </div>
      <Textarea
        ref={descriptionRef}
        value={description}
        onChange={(event) => setMessage(join(summary, event.target.value))}
        placeholder="Description"
        aria-label="Commit description"
        rows={3}
        className="min-h-0 resize-y text-xs"
        onKeyDown={sendOnShortcut}
      />
      {/* The button says what it will commit, because "commit" with nothing
          staged silently means "stage everything first" and that is not
          something a button should imply. */}
      <Button
        type="submit"
        size="sm"
        className={cn("w-full", actionClass(commitPhase))}
        disabled={busy || !summary.trim() || (changeCount === 0 && !amend)}
        title={`${amend ? "Amend the last commit" : "Commit"} on ${branch} (⌘Enter)`}
      >
        <ActionIcon phase={commitPhase}><HugeiconsIcon icon={Tick02Icon} strokeWidth={2} className="size-3.5" /></ActionIcon>
        <span className="truncate">
          {amend
            ? stagedCount > 0
              ? `Amend with ${stagedCount} ${stagedCount === 1 ? "file" : "files"}`
              : "Amend message"
            : stagedCount > 0
              ? `Commit ${stagedCount} ${stagedCount === 1 ? "file" : "files"} to ${branch}`
              : unstagedCount > 0
                ? `Stage all & commit ${unstagedCount} to ${branch}`
                : `Commit to ${branch}`}
        </span>
      </Button>
    </form>
  )
}
