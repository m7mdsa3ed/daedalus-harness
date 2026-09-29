/* ── One commit, opened ──
   What the history row can only hint at: the whole message, who wrote it and
   who committed it, where it sits (parents, refs) and every file it changed
   with its lines. A file opens as a diff against the commit's first parent —
   the change it brought to the line it landed on, the same measure the file
   list uses (`git.commitDetail`). */
import * as React from "react"
import { ArrowLeftIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/ui/copy-button"
import { PanelRowsSkeleton } from "@/components/ui/skeletons"
import { Notice } from "@/components/notice"
import { LineCounts } from "@/components/workspace/scm/shared"
import { describeError } from "@/lib/errors"
import { useServer } from "@/lib/server-context"
import { shortAge } from "@/lib/time"
import { cn } from "@/lib/utils"
import { basename } from "@/lib/workspace/fs-api"
import { gitCommit, type CommitDetail, type CommitFile, type GitCommit } from "@/lib/workspace/git-api"

const STATUS_CLASS: Record<string, string> = {
  A: "text-emerald-600 dark:text-emerald-400",
  M: "text-amber-600 dark:text-amber-400",
  D: "text-red-600 dark:text-red-400",
  R: "text-sky-600 dark:text-sky-400",
  C: "text-sky-600 dark:text-sky-400",
}

export function CommitDetailView({
  projectId,
  repo,
  commit,
  coarse,
  onBack,
  onOpenFile,
}: {
  projectId: string
  repo: string
  /** The row that was clicked — drawn at once while the rest is read. */
  commit: GitCommit
  coarse: boolean
  onBack: () => void
  /** `path` is repository-relative; `parent` is "" for a root commit. */
  onOpenFile: (file: CommitFile, detail: CommitDetail) => void
}) {
  const settings = useServer()
  const [detail, setDetail] = React.useState<CommitDetail | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    const controller = new AbortController()
    setDetail(null)
    setError(null)
    gitCommit(settings, projectId, commit.hash, repo || undefined, controller.signal)
      .then(setDetail)
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(describeError(err).title)
      })
    return () => controller.abort()
  }, [settings, projectId, repo, commit.hash])

  const [subject, ...rest] = (detail?.body ?? commit.subject).split("\n")
  const body = rest.join("\n").trim()
  const when = new Date(commit.at * 1000)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1">
        <Button variant="ghost" size="xs" className="gap-1" onClick={onBack}>
          <ArrowLeftIcon className="size-3.5" /> History
        </Button>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">{commit.short}</span>
        <CopyButton text={commit.hash} size="icon-xs" />
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="space-y-2 border-b border-border/50 px-3 py-2.5">
          <p className="text-xs font-semibold break-words">{subject}</p>
          {body && (
            <pre className="max-h-48 overflow-auto font-sans text-[11px] leading-4 whitespace-pre-wrap text-muted-foreground">
              {body}
            </pre>
          )}
          {commit.refs.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {commit.refs.map((ref) => (
                <Badge key={ref} variant="outline" className="px-1 text-[10px]">
                  {ref}
                </Badge>
              ))}
            </div>
          )}
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[10px]">
            <dt className="text-muted-foreground">Author</dt>
            <dd className="min-w-0 truncate" title={detail?.email}>
              {commit.author}
              {detail?.email && <span className="text-muted-foreground"> &lt;{detail.email}&gt;</span>}
            </dd>
            <dt className="text-muted-foreground">Date</dt>
            <dd title={when.toISOString()}>
              {when.toLocaleString()} · {shortAge(commit.at * 1000)}
            </dd>
            {detail && (detail.committer !== commit.author || detail.committedAt !== commit.at) && (
              <>
                <dt className="text-muted-foreground">Committed</dt>
                <dd className="min-w-0 truncate">
                  {detail.committer} · {shortAge(detail.committedAt * 1000)}
                </dd>
              </>
            )}
            <dt className="text-muted-foreground">{commit.parents.length > 1 ? "Parents" : "Parent"}</dt>
            <dd className="font-mono">
              {commit.parents.length === 0 ? "root commit" : commit.parents.map((p) => p.slice(0, 7)).join(" ")}
            </dd>
          </dl>
        </div>

        <div className="flex items-center gap-2 px-3 pt-2 pb-1 text-[11px] font-medium text-muted-foreground">
          <span>
            {detail ? detail.files.length : commit.filesChanged}{" "}
            {(detail ? detail.files.length : commit.filesChanged) === 1 ? "file" : "files"} changed
          </span>
          <LineCounts
            insertions={detail?.insertions ?? commit.insertions}
            deletions={detail?.deletions ?? commit.deletions}
          />
          {commit.parents.length > 1 && <span className="ml-auto text-[10px]">vs first parent</span>}
        </div>

        {error ? (
          <div className="px-2 py-1">
            <Notice tone="error">{error}</Notice>
          </div>
        ) : !detail ? (
          <PanelRowsSkeleton rows={Math.min(6, commit.filesChanged || 3)} className="space-y-1.5 p-2" />
        ) : (
          <ul className="px-1 pb-2">
            {detail.files.map((file) => {
              const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : ""
              return (
                <li key={file.path}>
                  <button
                    type="button"
                    onClick={() => onOpenFile(file, detail)}
                    title={file.from ? `${file.from} → ${file.path}` : file.path}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-accent/50",
                      coarse ? "min-h-11" : "min-h-7"
                    )}
                  >
                    <span
                      className={cn(
                        "w-3 shrink-0 text-center font-mono text-[10px] font-bold",
                        STATUS_CLASS[file.status] ?? "text-muted-foreground"
                      )}
                    >
                      {file.status}
                    </span>
                    <span className={cn("min-w-0 shrink-0 truncate", file.status === "D" && "line-through opacity-70")}>
                      {basename(file.path)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">{dir}</span>
                    {file.insertions === null ? (
                      <span className="shrink-0 text-[10px] text-muted-foreground">binary</span>
                    ) : (
                      <LineCounts insertions={file.insertions} deletions={file.deletions} />
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
