/* ── What the work lands on, and the four things you do to it ──
 *
 * A reading in the composer footer's cluster, the same 24px-trigger-over-a-
 * popover shape as the checklist, the workers, the last turn's changes and the
 * context ring: the branch is a fact about where this thread's work is going,
 * glanced at constantly and acted on rarely. It used to be nowhere in the app
 * outside the source-control panel, which meant the one place you are actually
 * *writing* the instructions never said which branch would receive them.
 *
 * A project is a directory, not a repository (`server/src/git.ts`), so this is
 * a list and not a value — the project's own checkout plus the ones below it,
 * which is what `git/repos` already answers. With one repository the list is
 * its own header and there is nothing to pick; with two or more the rows are
 * the picker, and every action names the repository it is about, because
 * "commit" with a client and a server checked out side by side is a question,
 * not a button.
 *
 * The two AI actions run on source control's own profile pick (Settings › AI
 * helpers, `lib/ai-picks.ts`) — not the thread's, and deliberately not the
 * composer enhancer's: reading a diff and sharpening a prompt are different
 * jobs. The call itself is one completion on the server (`server/src/ai.ts`),
 * never a turn on the thread's agent: drafting a commit message must not
 * journal into the conversation, touch the queue, or cost a full agent run. The
 * diff is read server-side; this sends a profile id, not a patch. Where no
 * profile can make that call the two buttons are simply not drawn.
 */
import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  ArrowDownToLineIcon,
  ArrowUpFromLineIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  LoaderCircleIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { BranchPicker, type BranchChoice } from "@/components/workspace/scm/branch-picker"
import { Notice } from "@/components/notice"
import {
  OpenInInspector,
  READING_MARK,
  READING_TRIGGER,
  ReadingFace,
} from "@/components/composer/indicator"
import { canUseAi, gitPick } from "@/lib/ai-picks"
import { errorText } from "@/lib/errors"
import { useProfiles } from "@/lib/queries/catalog"
import {
  projectGitBranchesKey,
  projectGitLogKey,
  projectGitStatusKey,
  projectReposKey,
} from "@/lib/queries/keys"
import { useGitBranches, useGitLog, useGitStatus, useProjectRepos } from "@/lib/queries/surfaces"
import { shortAge } from "@/lib/time"
import { useServer } from "@/lib/server-context"
import type { SessionMeta } from "@/lib/settings"
import { draftCommitMessage, gitWrite, type GitRepo, type GitStatus } from "@/lib/workspace/git-api"
import { cn } from "@/lib/utils"

export function RepoIndicator({ meta }: { meta: SessionMeta }) {
  const [open, setOpen] = useState(false)
  const { data } = useProjectRepos(meta.projectId)
  const repos = data ?? []
  if (repos.length === 0) return null

  /* The trigger says the project's own branch — the first repository, which is
     the project's own where it has one. Which branch the *actions* are about is
     the popover's question, and with two repositories it is asked explicitly. */
  const lead = repos[0]
  const label = lead.branch ?? "detached"

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className={cn(READING_TRIGGER, "text-muted-foreground hover:text-foreground")}
            title={
              repos.length > 1
                ? `${repos.length} repositories — ${lead.name} on ${label}`
                : `On ${label}`
            }
            aria-label={`Repository — on ${label}`}
          >
            {/* The one reading in the cluster whose value is a *name*, so there
                is no bubble form of it: a branch abbreviated to a digit says
                nothing. Where the panel has no room for words the bare mark
                stands, and the popover is where the name is read. */}
            <ReadingFace icon={<GitBranchIcon className={READING_MARK} />} label={label} />
          </Button>
        }
      />
      <PopoverContent align="end" side="top" className="w-88 gap-3">
        {/* Mounted with the popover, so a thread nobody opens this on never asks
            the server for a status. */}
        <RepoPanel meta={meta} repos={repos} />
        {/* The panel this popover is the glance of. */}
        <OpenInInspector
          tab="changes"
          label="Open Source Control"
          onOpen={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  )
}

/** How many commits the glance shows. Not a page — the source-control panel's
    history is. */
const RECENT_COMMITS = 5

function RepoPanel({ meta, repos }: { meta: SessionMeta; repos: GitRepo[] }) {
  const settings = useServer()
  const qc = useQueryClient()
  const [selected, setSelected] = useState(repos[0].path)
  const repo = repos.find((r) => r.path === selected) ?? repos[0]
  const status = useGitStatus(meta.projectId, repo.path)
  const log = useGitLog(meta.projectId, repo.path, RECENT_COMMITS)
  const branches = useGitBranches(meta.projectId, repo.path)

  /* The thread's own profile is the fallback, not the pick: a thread on a
     Default profile has no endpoint of its own, and the pick is what makes
     these buttons work there. */
  const profiles = useProfiles()
  const draftProfile = gitPick.resolveProfile(profiles, meta.profileId)
  const canDraft = canUseAi(draftProfile)

  const [message, setMessage] = useState("")
  const [branch, setBranch] = useState("")
  /* One busy flag, naming which action holds it: these are all writes against
     the same repository, so running two at once is never what was meant, and a
     spinner on the button you pressed is the whole feedback this needs. */
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [output, setOutput] = useState<string | null>(null)

  const state = status.data
  const dirty = state
    ? state.staged.length + state.unstaged.length + state.untracked.length
    : 0

  /** Every write lands here: one busy flag, one failure line, and the caches
      that could now be wrong. The status never round-trips — the write's own
      answer *is* the new status (the server runs it), so it is written
      straight into the cache the way the source-control panel does. The rest
      are invalidated and **not awaited**: the repos list is a directory walk
      and the log a git process each, and holding the button's spinner until
      four round trips land made a fast checkout read as a slow one. They
      repaint behind a spinner that has already cleared. */
  const act = async (
    name: string,
    run: () => Promise<GitStatus | void>,
    about = repo.path
  ) => {
    setBusy(name)
    setError(null)
    setOutput(null)
    try {
      const next = await run()
      if (next) {
        qc.setQueryData(projectGitStatusKey(settings, meta.projectId, about), next)
        /* The repo list is never refetched: nothing here adds a repository, and
           the only row a write moves is the one it names — the walk behind
           `git/repos` (a directory scan plus a process per repo) is the single
           slowest thing this popover could ask for, and the answer it would
           bring back for this row is already in hand. */
        qc.setQueryData(projectReposKey(settings, meta.projectId), (old: GitRepo[] | undefined) =>
          old?.map((r) => (r.path === (next.repo || "") ? { ...r, branch: next.branch } : r)),
        )
      }
      /* The prefix, not one limit's key: a commit or a pull moves the history
         for every surface reading it, whatever page size it asked for. */
      void qc.invalidateQueries({ queryKey: projectGitLogKey(settings, meta.projectId, about) })
      void qc.invalidateQueries({ queryKey: projectGitBranchesKey(settings, meta.projectId, about) })
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  const write = (action: "pull" | "push") =>
    act(action, async () => {
      const result = await gitWrite(settings, meta.projectId, { action, repo: repo.path })
      if (result.output) setOutput(result.output)
      return result
    })

  /* Commit from here is "commit what is in front of me": with nothing staged it
     stages the working set first, because the composer is not the place to
     curate an index — the source-control panel is, and it is one click away. */
  const commit = () =>
    act("commit", async () => {
      if (!state) return
      if (state.staged.length === 0) {
        const paths = [...state.unstaged, ...state.untracked].map((f) => f.path)
        if (paths.length === 0) throw new Error("nothing to commit")
        await gitWrite(settings, meta.projectId, { action: "stage", paths, repo: repo.path })
      }
      const result = await gitWrite(settings, meta.projectId, {
        action: "commit",
        message,
        repo: repo.path,
      })
      setMessage("")
      if (result.output) setOutput(result.output)
      return result
    })

  /** The two AI actions are one call with two house styles — the diff is read
      server-side either way, so the only thing that differs is where the answer
      is put. */
  const draft = (kind: "commit" | "branch") =>
    act(kind === "commit" ? "draft" : "name", async () => {
      if (!draftProfile) return
      const { message: answer } = await draftCommitMessage(settings, meta.projectId, {
        profileId: draftProfile.id,
        model: gitPick.resolveModelId(draftProfile) || undefined,
        repo: repo.path,
        kind,
      })
      if (kind === "commit") setMessage(answer)
      else setBranch(answer)
    })

  /** A pick out of any repository's own picker — switch, track a remote, or
      create. One door, because all three are `checkout` and the picker is what
      knows which of them was meant. */
  const checkout = (about: string, choice: BranchChoice) =>
    act(
      `switch:${about}`,
      () =>
        gitWrite(settings, meta.projectId, {
          action: "checkout",
          branch: choice.branch,
          create: choice.create,
          track: choice.track,
          repo: about,
        }).then((result) => {
          setBranch("")
          return result
        }),
      about
    )

  const spin = (name: string) => busy === name

  return (
    <>
      {/* One row per repository, and the branch on each row is that
          repository's own picker — a cwd holding a client and a server is two
          checkouts, and switching the one you are not "on" was otherwise
          impossible without opening the panel. The row itself picks which
          repository the buttons below act on; with one repository there is
          nothing to pick and the row is just its header. */}
      <div className="space-y-0.5">
        {repos.map((r) => {
          const active = r.path === repo.path
          return (
            <div
              key={r.path}
              onClick={() => setSelected(r.path)}
              className={cn(
                "flex items-center gap-2 rounded-md px-1.5 py-1 text-xs",
                repos.length > 1 && "cursor-pointer hover:bg-muted",
                active && repos.length > 1 && "bg-muted"
              )}
            >
              {repos.length > 1 && <span className="shrink-0 font-medium">{r.name}</span>}
              <BranchPicker
                projectId={meta.projectId}
                repo={r.path}
                branch={r.branch}
                unborn={active ? state?.unborn : undefined}
                disabled={Boolean(busy)}
                onPick={(choice) => void checkout(r.path, choice)}
                className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-0.5 text-start text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <GitBranchIcon className="size-3 shrink-0 opacity-60" />
                <span className="min-w-0 truncate font-mono text-[11px]">
                  {spin(`switch:${r.path}`) ? "Switching…" : (r.branch ?? "detached")}
                </span>
              </BranchPicker>
              {active && state && (
                <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">
                  {state.ahead > 0 && `↑${state.ahead} `}
                  {state.behind > 0 && `↓${state.behind} `}
                  {dirty > 0 ? `${dirty} changed` : "clean"}
                </span>
              )}
            </div>
          )
        })}
      </div>

      <div className="flex gap-2">
        <Button
          size="xs"
          variant="outline"
          className="flex-1"
          disabled={Boolean(busy)}
          loading={spin("pull")}
          onClick={() => void write("pull")}
        >
          {spin("pull") ? <Spinner /> : <ArrowDownToLineIcon className="size-3.5" />}
          Pull
        </Button>
        <Button
          size="xs"
          variant="outline"
          className="flex-1"
          disabled={Boolean(busy)}
          loading={spin("push")}
          onClick={() => void write("push")}
        >
          {spin("push") ? <Spinner /> : <ArrowUpFromLineIcon className="size-3.5" />}
          Push
        </Button>
      </div>

      {/* Commit. The message is the only free text here, so it is the only
          textarea; Draft fills it rather than committing on its own, because a
          message nobody read is a commit nobody can find later. */}
      <div className="space-y-1.5">
        <Textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={dirty > 0 ? "Commit message" : "Nothing to commit"}
          rows={2}
          className="min-h-0 resize-none text-xs"
        />
        <div className="flex gap-2">
          {canDraft && (
            <Button
              size="xs"
              variant="outline"
              className="flex-1"
              disabled={Boolean(busy) || dirty === 0}
              loading={spin("draft")}
              onClick={() => void draft("commit")}
              title="Write a message from this repository's diff"
            >
              {spin("draft") ? <Spinner /> : <SparklesIcon className="size-3.5" />}
              Draft
            </Button>
          )}
          <Button
            size="xs"
            className="flex-1"
            disabled={Boolean(busy) || dirty === 0 || !message.trim()}
            loading={spin("commit")}
            onClick={() => void commit()}
          >
            {spin("commit") ? <Spinner /> : <GitCommitHorizontalIcon className="size-3.5" />}
            Commit
          </Button>
          {canDraft && (
            <Button
              size="icon-xs"
              variant="outline"
              disabled={Boolean(busy) || dirty === 0}
              loading={spin("name")}
              onClick={() => void draft("branch")}
              title="Name a branch from this repository's diff"
              aria-label="Suggest a branch name"
            >
              {spin("name") ? <Spinner /> : <GitBranchIcon className="size-3.5" />}
            </Button>
          )}
        </div>
      </div>

      {/* The AI's suggestion, which is the one branch name that needs a second
          pair of eyes before it becomes a ref. Typing a name is the picker's
          job; this row exists only while a draft is waiting to be accepted. */}
      {branch && (
        <div className="flex gap-2">
          <Input
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            className="h-7 min-w-0 flex-1 font-mono text-xs"
          />
          <Button
            size="xs"
            disabled={Boolean(busy) || !branch.trim()}
            loading={spin(`switch:${repo.path}`)}
            onClick={() => void checkout(repo.path, { branch: branch.trim(), create: true })}
          >
            {spin(`switch:${repo.path}`) ? <Spinner /> : null}
            Create
          </Button>
          <Button size="icon-xs" variant="ghost" onClick={() => setBranch("")} aria-label="Discard">
            <XIcon className="size-3.5" />
          </Button>
        </div>
      )}

      {/* What has already landed. Five, because this is a glance — "did my
          commit go in", "what did the last turn leave here" — and the panel's
          history is where a page of them is read. Drawn only once there is
          something to draw: an unborn repository answers with an empty list,
          not an error. */}
      {(log.data?.length ?? 0) > 0 && (
        <ul className="-mx-1 space-y-0.5 border-t px-1 pt-2">
          {log.data?.map((commit) => (
            <li key={commit.hash} className="flex items-baseline gap-2 text-xs">
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                {commit.short}
              </span>
              <span className="min-w-0 flex-1 truncate" title={`${commit.subject} — ${commit.author}`}>
                {commit.subject}
              </span>
              <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">
                {shortAge(commit.at * 1000)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* git's own words, which are most of the answer to a pull or a push —
          "Already up to date", a rejected non-fast-forward, the URL a branch was
          published to. A failure is the app's error tone; the rest is neutral. */}
      {error && (
        <Notice tone="error" title="Git failed">
          <span className="whitespace-pre-wrap break-words font-mono text-[11px]">{error}</span>
        </Notice>
      )}
      {output && !error && (
        <Notice tone="neutral">
          <span className="whitespace-pre-wrap break-words font-mono text-[11px]">{output}</span>
        </Notice>
      )}
    </>
  )
}

function Spinner() {
  return <LoaderCircleIcon aria-hidden className="size-3.5 animate-spin" />
}
