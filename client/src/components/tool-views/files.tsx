/* ── The filesystem and command views ──
   What the agent did to the machine in front of it: a shell run (through the
   ordinary channel or through Codex's terminal one), a file read, a search,
   a write. See `./index.tsx` for the rule these all obey — nothing here
   matches on a vendor tool name. */
import * as React from "react"
import { Badge } from "@/components/ui/badge"
import { CopyButton } from "@/components/ui/copy-button"
import { DiffView } from "@/components/ui/diff-view"
import { ToolCallSkeleton } from "@/components/ui/skeletons"
import {
  Highlighted,
  LABEL,
  PANE,
  PANE_MAX_H,
  ShellPane,
  ShellScript,
  ShowAll,
  SmartBlock,
  ToolContentBlocks,
  useShowAll,
} from "@/components/tool-parts"
import {
  extractEdits,
  searchFlags,
  shortPath,
  toolLanguage,
  toolOutputText,
  toolPrimaryText,
  toolTarget,
} from "@/lib/tools"
import type { ToolItem } from "@/lib/store"
import { cn } from "@/lib/utils"
import { useLayoutOptionsContext } from "@/lib/layout-options"

/**
 * A shell run: the command on a `$` line, its stream underneath behind a
 * hairline. One pane, so the command and what it printed read as one event —
 * which is what a shell run is.
 */
export function RunDetail({ item, active }: { item: ToolItem; active: boolean }) {
  /* The pane itself is shared with the reader's own `!` command — see
     `ShellPane` in tool-parts, which is what makes the two read as one act. */
  return (
    <ShellPane
      command={toolPrimaryText(item) ?? toolTarget(item)}
      output={toolOutputText(item, 200_000).text}
      failed={item.status === "failed"}
      running={active}
    />
  )
}

/**
 * A file read: numbered lines, starting at the requested offset so the numbers
 * match the editor. Reading a file is the one case where "which line" is the
 * whole point, and a flat pre throws that away.
 */
export function ReadDetail({ item }: { item: ToolItem }) {
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
            className="shrink-0 py-1 pe-3 ps-2 text-end font-mono text-xs leading-5 tabular-nums whitespace-pre text-muted-foreground select-none"
          >
            {lines.map((_, index) => first + index).join("\n")}
          </pre>
        )}
        <div className="min-w-max flex-1 py-1 pe-3">
          <Highlighted
            code={body}
            language={language}
            className="[&_pre]:whitespace-pre [&_pre]:leading-5 [&_pre]:text-xs"
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
          <mark key={index} className="bg-accent text-accent-foreground">
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
export function SearchDetail({ item }: { item: ToolItem }) {
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
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
        {pattern && <code className="font-mono text-foreground">{pattern}</code>}
        {scope && (
          <span className="font-mono text-muted-foreground">in {shortPath(scope, 44)}</span>
        )}
        <span className="text-muted-foreground">
          {lines.length} {lines.length === 1 ? "match" : "matches"}
        </span>
        {flags.map((flag) => (
          <Badge key={flag} variant="outline" className="font-mono">
            {flag}
          </Badge>
        ))}
      </div>
      {shown.length > 0 && (
        <div className={cn(PANE, "max-h-80 overflow-auto")}>
          <ul className="divide-y font-mono text-xs">
            {shown.map((line, index) => {
              const match = /^(.*?):(\d+):(.*)$/.exec(line)
              return (
                <li key={index} className="flex gap-2 px-2.5 py-1">
                  {match ? (
                    <>
                      <span className="shrink-0 text-muted-foreground">
                        {shortPath(match[1], 42)}
                        <span className="text-muted-foreground">:{match[2]}</span>
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
            <div className="px-2.5 py-1 text-xs text-muted-foreground">
              …and {lines.length - shown.length} more
            </div>
          )}
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
export function TerminalDetail({ item, active }: { item: ToolItem; active: boolean }) {
  const command = toolPrimaryText(item) ?? toolTarget(item)
  const exitCode = item.terminal?.exitCode
  const failed = item.status === "failed" || (typeof exitCode === "number" && exitCode !== 0)
  const whole = toolOutputText(item, 200_000).text
  const [out, over, showAll] = useShowAll(whole)
  const exited =
    typeof exitCode === "number" && exitCode !== 0
      ? `exited ${exitCode}${item.terminal?.signal ? ` (${item.terminal.signal})` : ""}`
      : null
  /* What someone actually pastes into an issue is the command AND what it
     said, so the copy carries both — and `whole`, not `out`, so a run cut off
     by the Show-all cap still copies every byte that arrived. */
  const transcript = [command && `$ ${command}`, whole.trim() || null, exited]
    .filter(Boolean)
    .join("\n")

  return (
    <div className={cn(PANE, failed && "bg-destructive/10")}>
      <div className="flex items-start gap-2 px-2.5 py-1.5 font-mono text-xs leading-relaxed">
        <span aria-hidden className="shrink-0 leading-relaxed select-none text-muted-foreground">
          $
        </span>
        <ShellScript command={command} className="min-w-0 flex-1" />
      </div>
      {out.trim() && (
        <pre
          className={cn(
            PANE_MAX_H,
            "overflow-auto border-t border-inherit px-2.5 py-1.5 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap",
            failed ? "text-destructive" : "text-muted-foreground"
          )}
        >
          {out}
        </pre>
      )}
      {!out.trim() && active && <ToolCallSkeleton className="border-t border-inherit p-2.5" />}
      {over && <ShowAll onClick={showAll} />}
      {/* A footer only a failure earns. "exited 0" is what every command that
          worked would say, which is nothing worth the row — but a run that
          died is a row worth having, because it is what carries the copy of
          the command and its output out of here. */}
      {failed && (
        <div className="flex items-center gap-2 border-t border-inherit px-2.5 py-1 font-mono text-xs text-destructive">
          <span className="min-w-0 flex-1 truncate">{exited ?? "failed"}</span>
          <CopyButton
            text={transcript}
            size="icon-xs"
            className="shrink-0 text-destructive hover:bg-destructive/20 hover:text-destructive"
          />
        </div>
      )}
    </div>
  )
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
export function EditDetail({ item, active }: { item: ToolItem; active: boolean }) {
  const view = useLayoutOptionsContext()
  const failed = item.status === "failed"
  /* The diff blocks win over the input's pair (they are the final change, and
     under AIR the input carries no text at all); extractEdits reads them
     when the input has none, so one list covers both. A runtime sends one
     block per hunk, so hunks are numbered per path. */
  const hasDiffs = item.content.some((block) => block.type === "diff")
  const edits = hasDiffs
    ? extractEdits({ ...item, rawInput: undefined })
    : extractEdits(item)
  const others = hasDiffs ? item.content.filter((block) => block.type !== "diff") : []
  const perPath = new Map<string | undefined, number>()
  for (const edit of edits) perPath.set(edit.path, (perPath.get(edit.path) ?? 0) + 1)
  const seen = new Map<string | undefined, number>()

  return (
    <div className="space-y-1.5">
      {others.length > 0 && <ToolContentBlocks item={{ ...item, content: others }} />}
      {edits.map((edit, index) => {
        const total = perPath.get(edit.path) ?? 1
        const nth = (seen.get(edit.path) ?? 0) + 1
        seen.set(edit.path, nth)
        return (
        <div key={index} className="space-y-1">
          {/* Numbered only when a path has more than one: a lone "hunk 1 of 1"
              is a label for a fact the reader can already see. */}
          {total > 1 && (
            <div className={LABEL}>
              hunk {nth} of {total}
            </div>
          )}
          <DiffView
            oldText={edit.oldText}
            newText={edit.newText}
            path={edit.path ? shortPath(edit.path, 80) : undefined}
            split={view.splitDiffs}
          />
        </div>
        )
      })}
      {failed && <SmartBlock text={toolOutputText(item).text} tone="error" />}
      {edits.length === 0 && active && <ToolCallSkeleton className="py-1" />}
    </div>
  )
}
