/* ── One layout per kind of tool ──
   `tools.ts` reads a call; this file draws it. The split is the same one the
   rest of the transcript keeps: nothing here matches on a vendor tool name —
   it asks `toolViewOf` which view applies and asks the matching `extract*` for
   the fields, so teaching the app about a new runtime's tool is an edit to one
   file rather than to a component tree.

   The views exist because three runtimes describe the same act three ways and
   ACP's `kind` is too coarse to separate them. A checklist arrives as tool
   *input* under `kind: "think"` from Claude Code and `kind: "other"` from
   OpenCode; an MCP call arrives under `kind: "execute"` from Codex, which put
   it in the shell layout; a web search arrives under `kind: "search"`, which
   put prose through a `path:line:` splitter. Each of those was a JSON dump or
   a wrong-shaped pane before it had a view. */
import * as React from "react"
import {
  BotIcon,
  ChevronRightIcon,
  FileWarningIcon,
  GlobeIcon,
  LinkIcon,
  MessageCircleQuestionIcon,
  PlugZapIcon,
  SparklesIcon,
} from "lucide-react"
import { DiffView } from "@/components/ui/diff-view"
import { ToolCallSkeleton } from "@/components/ui/skeletons"
import {
  DetailSection,
  Highlighted,
  PANE,
  PANE_MAX_H,
  Prose,
  ShellScript,
  ShowAll,
  SmartBlock,
  ToolContentBlocks,
  ToolInput,
  ToolLocations,
  useShowAll,
} from "@/components/tool-parts"
import { useThreadLinks } from "@/lib/workspace/thread-links"
import { useTaskEvents, watchTask } from "@/lib/task-events"
import { loadSettings } from "@/lib/settings"
import {
  extractBackgroundTask,
  extractEdits,
  extractFindings,
  extractMcpCall,
  extractPlanProposal,
  extractQuestions,
  extractSkill,
  extractSubagent,
  extractTodos,
  extractWebSearch,
  searchFlags,
  shortPath,
  taskAgentRows,
  taskFindings,
  toolLanguage,
  toolOutputText,
  toolPrimaryText,
  toolTarget,
  toolViewOf,
  type BackgroundTask,
  type TodoEntry,
} from "@/lib/tools"
import type { ToolItem } from "@/lib/store"
import { cn } from "@/lib/utils"
import { useViewOptionsContext } from "@/lib/view-options"

/**
 * A shell run: the command on a `$` line, its stream underneath behind a
 * hairline. One pane, so the command and what it printed read as one event —
 * which is what a shell run is.
 */
function RunDetail({ item, active }: { item: ToolItem; active: boolean }) {
  const command = toolPrimaryText(item) ?? toolTarget(item)
  const failed = item.status === "failed"
  const [out, over, showAll] = useShowAll(toolOutputText(item, 200_000).text)

  return (
    <div className={cn(PANE, failed && "border-destructive/40 bg-destructive/5")}>
      <div className="flex items-start gap-2 px-2.5 py-1.5 font-mono text-[11.5px] leading-relaxed">
        <span aria-hidden className="shrink-0 leading-relaxed select-none text-muted-foreground/60">
          $
        </span>
        <ShellScript command={command} className="min-w-0 flex-1" />
      </div>
      {out.trim() && (
        <pre
          className={cn(
            PANE_MAX_H,
            "overflow-auto border-t border-inherit px-2.5 py-1.5 font-mono text-[11.5px] leading-relaxed break-words whitespace-pre-wrap",
            failed ? "text-destructive" : "text-muted-foreground"
          )}
        >
          {out}
        </pre>
      )}
      {/* Running with nothing printed yet: breathing lines, not an empty pane. */}
      {!out.trim() && active && <ToolCallSkeleton className="border-t border-inherit p-2.5" />}
      {over && <ShowAll onClick={showAll} />}
    </div>
  )
}

/**
 * A file read: numbered lines, starting at the requested offset so the numbers
 * match the editor. Reading a file is the one case where "which line" is the
 * whole point, and a flat pre throws that away.
 */
function ReadDetail({ item }: { item: ToolItem }) {
  const input =
    item.rawInput && typeof item.rawInput === "object" && !Array.isArray(item.rawInput)
      ? (item.rawInput as Record<string, unknown>)
      : null
  const first = typeof input?.offset === "number" ? input.offset : 1
  const [body, over, showAll] = useShowAll(toolOutputText(item, 200_000).text)
  if (!body.trim()) return null

  const lines = body.split("\n")
  // Agents often return content already prefixed with `NNN\t`; don't number twice.
  const preNumbered = lines.length > 1 && /^\s*\d+\t/.test(lines[0])

  const language = toolLanguage(item)

  return (
    <div className={PANE}>
      {/* The gutter is a sibling column, not a prefix on each line: that keeps
          the code a single fence the highlighter can colour, and `whitespace-pre`
          on both halves means one screen line per source line, so the numbers
          stay aligned. */}
      <div className="flex max-h-80 overflow-auto">
        {!preNumbered && (
          <pre
            aria-hidden
            className="shrink-0 py-1 pe-3 ps-2 text-end font-mono text-[11.5px] leading-5 tabular-nums whitespace-pre text-muted-foreground/45 select-none"
          >
            {lines.map((_, index) => first + index).join("\n")}
          </pre>
        )}
        <div className="min-w-max flex-1 py-1 pe-3">
          <Highlighted
            code={body}
            language={language}
            className="[&_pre]:whitespace-pre [&_pre]:leading-5 [&_pre]:text-[11.5px]"
          />
        </div>
      </div>
      {over && <ShowAll onClick={showAll} />}
    </div>
  )
}

/** Highlight every occurrence of the search pattern inside one result line. */
function MarkedLine({ text, pattern }: { text: string; pattern: string | null }) {
  if (!pattern) return <>{text}</>
  // The pattern is a regex the agent wrote; compiling it is the point, but a
  // bad one must not take the transcript down with it.
  let re: RegExp
  try {
    re = new RegExp(`(${pattern})`, "gi")
  } catch {
    return <>{text}</>
  }
  return (
    <>
      {text.split(re).map((part, index) =>
        index % 2 === 1 ? (
          <mark key={index} className="bg-primary/20 text-foreground">
            {part}
          </mark>
        ) : (
          <React.Fragment key={index}>{part}</React.Fragment>
        )
      )}
    </>
  )
}

const MAX_MATCHES = 200

/**
 * Search hits as located matches, not a wall of text. `path:line:match` is
 * split so the paths form a scannable column and the matched text reads as
 * content — the shape ripgrep output actually has.
 */
function SearchDetail({ item }: { item: ToolItem }) {
  const input =
    item.rawInput && typeof item.rawInput === "object" && !Array.isArray(item.rawInput)
      ? (item.rawInput as Record<string, unknown>)
      : null
  const pick = (key: string) => (typeof input?.[key] === "string" ? (input[key] as string) : null)
  const pattern = pick("pattern") ?? pick("query")
  const scope = pick("path") ?? pick("glob")
  const lines = toolOutputText(item, 60_000)
    .text.split("\n")
    .filter((line) => line.trim().length > 0)
  const shown = lines.slice(0, MAX_MATCHES)
  /* Claude Code's Grep carries its flags as separate input keys — `-i`, the
     context window, an output mode, a head limit. A header that showed only
     the pattern and the path claimed a case-insensitive search with two lines
     of context either side was a plain one. */
  const flags = searchFlags(item)

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px]">
        {pattern && <code className="font-mono text-foreground">{pattern}</code>}
        {scope && (
          <span className="font-mono text-muted-foreground">in {shortPath(scope, 44)}</span>
        )}
        <span className="text-muted-foreground/70">
          {lines.length} {lines.length === 1 ? "match" : "matches"}
        </span>
        {flags.map((flag) => (
          <span
            key={flag}
            className="rounded border border-border/60 px-1 py-px text-[10px] text-muted-foreground/70"
          >
            {flag}
          </span>
        ))}
      </div>
      {shown.length > 0 && (
        <div className={cn(PANE, "max-h-80 overflow-auto")}>
          <ul className="divide-y divide-border/40 font-mono text-[11.5px]">
            {shown.map((line, index) => {
              const match = /^(.*?):(\d+):(.*)$/.exec(line)
              return (
                <li key={index} className="flex gap-2 px-2.5 py-1">
                  {match ? (
                    <>
                      <span className="shrink-0 text-muted-foreground/70">
                        {shortPath(match[1], 42)}
                        <span className="text-muted-foreground/40">:{match[2]}</span>
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        <MarkedLine text={match[3].trim()} pattern={pattern} />
                      </span>
                    </>
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{line}</span>
                  )}
                </li>
              )
            })}
          </ul>
          {lines.length > shown.length && (
            <div className="px-2.5 py-1 text-[11px] text-muted-foreground/60">
              …and {lines.length - shown.length} more
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** A fetch: the URL as a link first, because that is the thing you want to open. */
function FetchDetail({ item }: { item: ToolItem }) {
  const input =
    item.rawInput && typeof item.rawInput === "object" && !Array.isArray(item.rawInput)
      ? (item.rawInput as Record<string, unknown>)
      : null
  const pick = (key: string) => (typeof input?.[key] === "string" ? (input[key] as string) : null)
  const url = pick("url")
  const query = pick("query") ?? pick("prompt")
  const { text } = toolOutputText(item, 20_000)

  return (
    <div className="space-y-1.5">
      {url && (
        <a
          href={/^https?:\/\//.test(url) ? url : undefined}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 font-mono text-[11px] text-primary hover:underline"
        >
          <GlobeIcon className="size-3 shrink-0" />
          <span className="truncate">{url}</span>
        </a>
      )}
      {query && !url && <div className="text-[11px] text-muted-foreground">“{query}”</div>}
      <SmartBlock text={text} />
    </div>
  )
}


/** Keeps the server's tail alive through quiet stretches (a subagent can run
    for many minutes between journal lines) and backfills anything a missed
    notification or a reload dropped. The push stream is the fast path; this is
    the floor under it. */
const TASK_REFRESH_MS = 90_000

/**
 * Live progress of a background task — work the agent launched and left
 * running past the end of the turn (a Claude Code workflow, say). The turn is
 * over, so no ACP frame will ever carry this; the events come off the server's
 * tail of the task's own journal on disk. Mounting the panel starts that tail
 * (`/api/tasks/watch`), and the module store it fills is keyed by transcript
 * dir, so every peer and every remount reads the same journal.
 */
function TaskProgress({ task }: { task: BackgroundTask }) {
  const events = useTaskEvents(task.transcriptDir)
  const [unreachable, setUnreachable] = React.useState(false)
  React.useEffect(() => {
    const settings = loadSettings()
    if (!settings) return
    let cancelled = false
    const ask = () =>
      watchTask(settings, task.transcriptDir).then(
        () => !cancelled && setUnreachable(false),
        () => !cancelled && setUnreachable(true)
      )
    void ask()
    const timer = setInterval(() => void ask(), TASK_REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [task.transcriptDir])

  const rows = taskAgentRows(events)
  const findings = taskFindings(rows)
  const finished = rows.filter((row) => row.done).length

  if (rows.length === 0) {
    return (
      <p className={cn("text-[11px] text-muted-foreground/70", !unreachable && "harness-shimmer")}>
        {unreachable
          ? "Couldn't follow this task's journal on the server."
          : "Waiting for the task's journal…"}
      </p>
    )
  }
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
        {task.summary && (
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{task.summary}</span>
        )}
        <span className="shrink-0 tabular-nums text-muted-foreground/70">
          {finished}/{rows.length} agents finished
        </span>
      </div>
      <ul className="space-y-0.5">
        {rows.map((row, index) => (
          <li key={row.agentId} className="flex items-center gap-2 text-[11px]">
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                row.failed
                  ? "bg-destructive"
                  : row.done
                    ? "bg-primary"
                    : "harness-node-active bg-primary"
              )}
            />
            {/* The journal's agent ids are hashes; their order is the readable
                identity. The real id stays on the tooltip for cross-reference
                with the transcript dir. */}
            <span
              title={row.agentId}
              className={cn("font-mono", row.done ? "text-muted-foreground" : "harness-shimmer")}
            >
              agent {index + 1}
            </span>
            <span className={cn("text-[10px]", row.failed ? "text-destructive" : "text-muted-foreground/60")}>
              {row.failed ? "failed" : row.done ? "finished" : "running"}
            </span>
          </li>
        ))}
      </ul>
      {findings.length > 0 && (
        <div className={cn(PANE, "max-h-56 overflow-auto")}>
          <ul className="divide-y divide-border/40">
            {findings.map((title, index) => (
              <li key={index} className="px-2.5 py-1 text-[11px] text-muted-foreground">
                {title}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// ─── Terminal ────────────────────────────────────────────────────────────────

/**
 * A command whose output arrived through the terminal channel.
 *
 * Codex announces every shell run as `content: [{type: "terminal"}]` and then
 * streams the bytes on later updates' `_meta`, regardless of what the client
 * claimed it could take. The content block is a *handle*, so drawing it as
 * content printed the literal string `[terminal]` and nothing else for the
 * whole run; the bytes are reassembled in `lib/tools` and land on the item.
 *
 * Same pane as an ordinary run — a shell run should not look like two
 * different things depending on which agent spawned it — plus the exit code,
 * which is the one thing this channel knows that the other does not.
 */
function TerminalDetail({ item, active }: { item: ToolItem; active: boolean }) {
  const command = toolPrimaryText(item) ?? toolTarget(item)
  const exitCode = item.terminal?.exitCode
  const failed = item.status === "failed" || (typeof exitCode === "number" && exitCode !== 0)
  const [out, over, showAll] = useShowAll(toolOutputText(item, 200_000).text)

  return (
    <div className={cn(PANE, failed && "border-destructive/40 bg-destructive/5")}>
      <div className="flex items-start gap-2 px-2.5 py-1.5 font-mono text-[11.5px] leading-relaxed">
        <span aria-hidden className="shrink-0 leading-relaxed select-none text-muted-foreground/60">
          $
        </span>
        <ShellScript command={command} className="min-w-0 flex-1" />
      </div>
      {out.trim() && (
        <pre
          className={cn(
            PANE_MAX_H,
            "overflow-auto border-t border-inherit px-2.5 py-1.5 font-mono text-[11.5px] leading-relaxed break-words whitespace-pre-wrap",
            failed ? "text-destructive" : "text-muted-foreground"
          )}
        >
          {out}
        </pre>
      )}
      {!out.trim() && active && <ToolCallSkeleton className="border-t border-inherit p-2.5" />}
      {over && <ShowAll onClick={showAll} />}
      {/* Only a non-zero code earns a line. "exited 0" is what every command
          that worked would say, which is nothing worth the row. */}
      {typeof exitCode === "number" && exitCode !== 0 && (
        <div className="border-t border-inherit px-2.5 py-1 font-mono text-[11px] text-destructive">
          exited {exitCode}
          {item.terminal?.signal ? ` (${item.terminal.signal})` : ""}
        </div>
      )}
    </div>
  )
}

// ─── Todos ───────────────────────────────────────────────────────────────────

const TODO_DOT: Record<TodoEntry["status"], string> = {
  completed: "bg-primary",
  in_progress: "harness-node-active bg-primary",
  pending: "bg-muted-foreground/40",
}

const TODO_TEXT: Record<TodoEntry["status"], string> = {
  completed: "text-muted-foreground line-through",
  in_progress: "text-foreground",
  pending: "text-muted-foreground",
}

/**
 * The agent's checklist.
 *
 * Deliberately the same drawing as `PlanStep`: Codex sends its list through
 * ACP's `plan` channel and the other two send theirs as the input of a tool
 * call, and the reader should not be able to tell which — a checklist is a
 * checklist. The difference is only in where it was read from, which is
 * `lib/tools`' problem.
 */
export function TodoList({ todos }: { todos: TodoEntry[] }) {
  return (
    <ul className="space-y-1">
      {todos.map((todo, index) => (
        <li key={index} className="flex items-start gap-2 text-xs">
          <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", TODO_DOT[todo.status])} />
          <span className={cn("min-w-0", TODO_TEXT[todo.status])}>
            {todo.content}
            {todo.priority === "high" && todo.status !== "completed" ? (
              <span className="ml-1.5 text-[10px] tracking-wide uppercase text-primary/70">high</span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  )
}

function TodosDetail({ item }: { item: ToolItem }) {
  const todos = extractTodos(item) ?? []
  return <TodoList todos={todos} />
}

// ─── Edits ───────────────────────────────────────────────────────────────────

/**
 * A write, as its diff — every hunk of it.
 *
 * The single-hunk case was already drawn; this adds the two that were not. A
 * `MultiEdit` keeps its hunks one level down in an array, so the old
 * single-pair reader found nothing and the call fell through to a JSON dump of
 * the very thing a diff view exists to show. A `Write` has no "before" at all,
 * which read the same way — so a new file rendered as its own source quoted
 * inside JSON.
 */
function EditDetail({ item, active }: { item: ToolItem; active: boolean }) {
  const view = useViewOptionsContext()
  const failed = item.status === "failed"
  const diffs = item.content.filter((block) => block.type === "diff")
  const edits = diffs.length > 0 ? [] : extractEdits(item)

  return (
    <div className="space-y-1.5">
      {diffs.length > 0 && <ToolContentBlocks item={item} />}
      {edits.map((edit, index) => (
        <div key={index} className="space-y-1">
          {/* Numbered only when there is more than one: a lone "hunk 1 of 1"
              is a label for a fact the reader can already see. */}
          {edits.length > 1 && (
            <div className="text-[10px] tracking-wide uppercase text-muted-foreground/50">
              hunk {index + 1} of {edits.length}
            </div>
          )}
          <DiffView
            oldText={edit.oldText}
            newText={edit.newText}
            path={edit.path ? shortPath(edit.path, 80) : undefined}
            split={view.splitDiffs}
          />
        </div>
      ))}
      {failed && <SmartBlock text={toolOutputText(item).text} tone="error" />}
      {diffs.length === 0 && edits.length === 0 && active && <ToolCallSkeleton className="py-1" />}
    </div>
  )
}

// ─── MCP ─────────────────────────────────────────────────────────────────────

/**
 * A call into an MCP server: which server, which tool, the arguments as
 * arguments, and the result underneath.
 *
 * Codex reports these as `kind: "execute"`, which used to route them into the
 * shell layout — a `$` prompt in front of `{"server":"…","tool":"…"}`, and the
 * `{result, error}` envelope printed as JSON rather than the result inside it.
 * Naming the server is the point of the header: the question a reader has
 * about an MCP call is which integration acted.
 */
function McpDetail({ item, active }: { item: ToolItem; active: boolean }) {
  const call = extractMcpCall(item)
  if (!call) return null
  const error = call.error === null || call.error === undefined ? null : call.error
  const args = call.arguments
  const hasArgs = args !== undefined && args !== null && JSON.stringify(args) !== "{}"
  const result = error === null ? (call.result ?? item.rawOutput) : null

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-[11px]">
        <PlugZapIcon className="size-3 shrink-0 text-muted-foreground/60" />
        <span className="font-mono text-foreground">{call.server}</span>
        {call.tool && (
          <>
            <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/40" />
            <span className="font-mono text-muted-foreground">{call.tool}</span>
          </>
        )}
      </div>
      {hasArgs && (
        <DetailSection label="Arguments">
          {/* The same flat-table-or-JSON reader an ordinary input gets, pointed
              at the arguments rather than at the envelope around them. */}
          <ToolInput item={{ ...item, rawInput: args }} />
        </DetailSection>
      )}
      {error !== null && (
        <DetailSection label="Error">
          <SmartBlock text={textOf(error)} tone="error" />
        </DetailSection>
      )}
      {error === null && (result !== undefined && result !== null) && (
        <DetailSection label={active ? "Result so far" : "Result"}>
          <SmartBlock text={textOf(result)} />
        </DetailSection>
      )}
      {item.content.length > 0 && <ToolContentBlocks item={item} />}
      {active && result === null && error === null && <ToolCallSkeleton className="py-1" />}
    </div>
  )
}

/** Anything an MCP server returned, as text — a string stays a string, a
    content-block array is flattened, and a structure becomes JSON. */
function textOf(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2) ?? ""
  } catch {
    return String(value)
  }
}

// ─── Subagents ───────────────────────────────────────────────────────────────

/**
 * Work handed to another agent: who, what it was asked, what it said back.
 *
 * The prompt is the interesting half and it is long, so it gets its own
 * bordered block rather than a row in the key/value table an unknown tool
 * would have got — where a five-paragraph brief rendered as one unwrapped
 * cell. A live background task (a workflow that outlives the turn) still shows
 * its own progress panel above all of this.
 */
function SubagentDetail({ item, active }: { item: ToolItem; active: boolean }) {
  const call = extractSubagent(item)
  const task = extractBackgroundTask(item)
  if (!call) return null
  const { text, truncated } = toolOutputText(item)
  const failed = item.status === "failed"

  return (
    <div className="space-y-2">
      {task && (
        <DetailSection label={task.workflowName ? `Task · ${task.workflowName}` : "Background task"}>
          <TaskProgress task={task} />
        </DetailSection>
      )}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
        <BotIcon className="size-3 shrink-0 text-muted-foreground/60" />
        {call.agentType && <span className="font-mono text-foreground">{call.agentType}</span>}
        {call.model && <span className="text-muted-foreground/70">{call.model}</span>}
        {/* Codex reports a subagent's lifecycle rather than its prompt — the
            activity IS the whole content of the call, so it is not optional
            chrome the way the rest of this row is. */}
        {call.activity && <span className="text-muted-foreground/70">{call.activity}</span>}
        {call.description && <span className="text-muted-foreground">{call.description}</span>}
      </div>
      {call.prompt && (
        <DetailSection label="Brief">
          <div className={cn(PANE_MAX_H, "overflow-auto rounded-md border border-border/50 bg-muted/40 px-2.5 py-2")}>
            <Prose text={call.prompt} />
          </div>
        </DetailSection>
      )}
      {text.trim() && (
        <DetailSection label={failed ? "Error" : active ? "Report so far" : "Report"}>
          <SmartBlock text={truncated ? `${text}\n\n… output truncated` : text} tone={failed ? "error" : undefined} />
        </DetailSection>
      )}
      {!text.trim() && active && !task && <ToolCallSkeleton className="py-1" />}
    </div>
  )
}

// ─── Web search ──────────────────────────────────────────────────────────────

/**
 * A search of the *web*. ACP files it under the same `kind` as a ripgrep, and
 * Codex actively uses `kind: "search"` for it — so the repo-search layout was
 * counting sentences as "matches" and trying to split prose on `path:line:`.
 *
 * Results are links, because a link is the thing a reader wants to do
 * something with. Codex's other two actions (opening a page, finding within
 * one) name themselves instead: there is no result list for those.
 */
function WebSearchDetail({ item, active }: { item: ToolItem; active: boolean }) {
  const call = extractWebSearch(item)
  if (!call) return null
  const domains = [
    ...(call.allowedDomains ?? []).map((domain) => ({ domain, allowed: true })),
    ...(call.blockedDomains ?? []).map((domain) => ({ domain, allowed: false })),
  ]
  const { text } = toolOutputText(item, 40_000)

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px]">
        <GlobeIcon className="size-3 shrink-0 self-center text-muted-foreground/60" />
        {call.query && <span className="text-foreground">“{call.query}”</span>}
        {call.pattern && <code className="font-mono text-foreground">{call.pattern}</code>}
        {call.url && (
          <a
            href={call.url}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 truncate font-mono text-primary hover:underline"
          >
            {call.url}
          </a>
        )}
        {call.action && call.action !== "search" && (
          <span className="text-muted-foreground/70">{call.action.replace(/([A-Z])/g, " $1").toLowerCase()}</span>
        )}
      </div>
      {domains.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {domains.map(({ domain, allowed }) => (
            <span
              key={domain}
              className={cn(
                "rounded border px-1 py-px font-mono text-[10px]",
                allowed
                  ? "border-border/60 text-muted-foreground"
                  : "border-destructive/40 text-destructive/80"
              )}
            >
              {allowed ? "" : "−"}
              {domain}
            </span>
          ))}
        </div>
      )}
      {call.results.length > 0 ? (
        <ul className={cn(PANE, "max-h-80 divide-y divide-border/40 overflow-auto")}>
          {call.results.map((hit, index) => (
            <li key={index} className="px-2.5 py-1.5">
              <a
                href={hit.url}
                target="_blank"
                rel="noreferrer"
                className="flex items-start gap-1.5 text-[11.5px] hover:underline"
              >
                <LinkIcon className="mt-0.5 size-3 shrink-0 text-muted-foreground/50" />
                <span className="min-w-0">
                  <span className="text-foreground">{hit.title}</span>
                  <span className="block truncate font-mono text-[10px] text-muted-foreground/60">
                    {hit.url}
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        /* No parsed hits: the runtime returned prose (a page's text, a
           summary), which is worth showing whole rather than discarding
           because it did not look like a result list. */
        <SmartBlock text={text} />
      )}
      {call.results.length === 0 && !text.trim() && active && <ToolCallSkeleton className="py-1" />}
    </div>
  )
}

// ─── Questions ───────────────────────────────────────────────────────────────

/**
 * The record of a question the agent asked. The *live* question is a form
 * (`elicitation-form.tsx`); this is what stays in the transcript once it has
 * been answered — and left generic it was a nested JSON dump of the same
 * options the reader had just clicked one of.
 */
function QuestionsDetail({ item }: { item: ToolItem }) {
  const questions = extractQuestions(item)
  if (!questions) return null
  return (
    <div className="space-y-2">
      {questions.map((question, index) => (
        <div key={index} className="space-y-1">
          <div className="flex items-start gap-1.5 text-xs">
            <MessageCircleQuestionIcon className="mt-0.5 size-3 shrink-0 text-muted-foreground/60" />
            <span className="min-w-0 text-foreground">{question.question}</span>
            {question.multiSelect && (
              <span className="shrink-0 text-[10px] text-muted-foreground/60">multi</span>
            )}
          </div>
          {question.options.length > 0 && (
            <ul className="ms-4 space-y-0.5">
              {question.options.map((option, optionIndex) => (
                <li key={optionIndex} className="text-[11px]">
                  <span className="text-foreground/80">{option.label}</span>
                  {option.description && (
                    <span className="text-muted-foreground/70"> — {option.description}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  )
}

// ─── Findings ────────────────────────────────────────────────────────────────

/** A review's results. They are a table — file, line, what is wrong — and a
    table is exactly what a JSON dump of them was hiding. */
function FindingsDetail({ item }: { item: ToolItem }) {
  const findings = extractFindings(item)
  const links = useThreadLinks()
  if (!findings) return null
  if (findings.length === 0) {
    return <p className="text-[11px] text-muted-foreground">No findings.</p>
  }
  return (
    <ul className={cn(PANE, "max-h-80 divide-y divide-border/40 overflow-auto")}>
      {findings.map((finding, index) => {
        const where = `${shortPath(finding.file, 48)}${finding.line != null ? `:${finding.line}` : ""}`
        return (
          <li key={index} className="space-y-0.5 px-2.5 py-1.5 text-[11.5px]">
            <div className="flex items-center gap-1.5">
              <FileWarningIcon className="size-3 shrink-0 text-muted-foreground/50" />
              {links ? (
                <button
                  type="button"
                  className="min-w-0 truncate font-mono text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  onClick={() => links.openFile(finding.file, finding.line ?? undefined)}
                >
                  {where}
                </button>
              ) : (
                <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                  {where}
                </span>
              )}
              {finding.category && (
                <span className="shrink-0 rounded border border-border/60 px-1 text-[10px] text-muted-foreground/70">
                  {finding.category}
                </span>
              )}
              {finding.verdict && (
                <span className="shrink-0 text-[10px] text-muted-foreground/60">
                  {finding.verdict.toLowerCase()}
                </span>
              )}
            </div>
            <p className="text-foreground/85">{finding.summary}</p>
          </li>
        )
      })}
    </ul>
  )
}

// ─── Plan proposal ───────────────────────────────────────────────────────────

/** An `ExitPlanMode`: the plan the agent is asking to run, which is markdown
    and is the entire content of the call. Rendering it through the generic
    input table put a document in a `<dd>`. */
function PlanProposalDetail({ item }: { item: ToolItem }) {
  const plan = extractPlanProposal(item)
  if (plan === null) {
    // `switch_mode` with no plan on it — a plain mode change. Say which.
    return <SmartBlock text={toolOutputText(item).text} />
  }
  return (
    <div className={cn(PANE_MAX_H, "overflow-auto rounded-md border border-border/50 bg-muted/40 px-2.5 py-2")}>
      <Prose text={plan} />
    </div>
  )
}

// ─── Skills ──────────────────────────────────────────────────────────────────

/** A skill load: which packaged workflow came in, and with what arguments. The
    call returns nothing, so the name is the whole story. */
function SkillDetail({ item }: { item: ToolItem }) {
  const skill = extractSkill(item)
  if (!skill) return null
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px]">
      <SparklesIcon className="size-3 shrink-0 text-muted-foreground/60" />
      <span className="font-mono text-foreground">{skill.name}</span>
      {skill.args && <span className="font-mono text-muted-foreground/80">{skill.args}</span>}
    </div>
  )
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

/**
 * The body of an expanded step.
 *
 * `toolViewOf` decides which layout applies — including the priority between
 * them, which is a judgement (a checklist beats its `think` kind; a terminal
 * beats `execute`) and belongs next to the readers that make it, not spread
 * through the branches of this switch. What is left here is one case per view
 * and a default that is the old generic pane: input, files, output.
 */
export function ToolDetail({ item, active }: { item: ToolItem; active: boolean }) {
  const failed = item.status === "failed"

  switch (toolViewOf(item)) {
    case "edit":
      return <EditDetail item={item} active={active} />
    case "todos":
      return <TodosDetail item={item} />
    case "terminal":
      return <TerminalDetail item={item} active={active} />
    case "mcp":
      return <McpDetail item={item} active={active} />
    case "subagent":
      return <SubagentDetail item={item} active={active} />
    case "websearch":
      return <WebSearchDetail item={item} active={active} />
    case "questions":
      return <QuestionsDetail item={item} />
    case "findings":
      return <FindingsDetail item={item} />
    case "plan":
      return <PlanProposalDetail item={item} />
    case "skill":
      return <SkillDetail item={item} />
    case "execute":
      return <RunDetail item={item} active={active} />
    case "read":
      return <ReadDetail item={item} />
    case "search":
      return <SearchDetail item={item} />
    case "fetch":
      return <FetchDetail item={item} />
    default: {
      // Everything else, an unrecognised MCP tool included: what went in, what
      // came back.
      const { text, truncated } = toolOutputText(item)
      const hasInput = JSON.stringify(item.rawInput ?? null) !== "null"
      const task = extractBackgroundTask(item)
      return (
        <>
          {task && (
            <DetailSection label={task.workflowName ? `Task · ${task.workflowName}` : "Background task"}>
              <TaskProgress task={task} />
            </DetailSection>
          )}
          {hasInput && (
            <DetailSection label="Input">
              <ToolInput item={item} />
            </DetailSection>
          )}
          {item.locations.length > 0 && (
            <DetailSection label={item.locations.length === 1 ? "File" : "Files"}>
              <ToolLocations item={item} />
            </DetailSection>
          )}
          {(text.trim() || item.content.length > 0) && (
            <DetailSection label={failed ? "Error" : active ? "Output so far" : "Output"}>
              <ToolContentBlocks item={item} />
              {item.content.length === 0 && (
                <SmartBlock
                  text={truncated ? `${text}\n\n… output truncated` : text}
                  tone={failed ? "error" : undefined}
                  language={toolLanguage(item)}
                />
              )}
            </DetailSection>
          )}
          {!text.trim() && item.content.length === 0 && active && (
            <ToolCallSkeleton className="py-1" />
          )}
        </>
      )
    }
  }
}

/**
 * Whether an expanded step would have anything in it. The row's disclosure
 * affordance is drawn from this, so it has to agree with `ToolDetail` — a
 * chevron that opens an empty box is worse than no chevron.
 *
 * The views that read a call's *input* are why this is not just "is there
 * output": a checklist, a question and a plan all return nothing at all.
 */
export function toolHasDetail(item: ToolItem): boolean {
  return (
    item.content.length > 0 ||
    item.locations.length > 0 ||
    JSON.stringify(item.rawInput ?? null) !== "null" ||
    toolOutputText(item, 1).text.length > 0
  )
}

/** Steps that open by themselves. A diff is the point of an edit and a
    checklist is the point of a todo write — collapsed, the only thing worth
    reading is the thing that is hidden. A background task is still producing
    after its turn ends, so folded it would be the one live thing on screen and
    invisible. Everything else stays folded: a read or a search is a fact. */
export function toolOpensByDefault(item: ToolItem): boolean {
  const view = toolViewOf(item)
  return view === "edit" || view === "todos" || view === "plan" || extractBackgroundTask(item) !== null
}
