/* ── The structured views ──
   Calls whose content is a shape rather than a stream: a checklist, a question
   and its answer, a review's findings, a proposed plan, a skill load, a tool search. Each of
   these was a JSON dump before it had a view, and most of them carry their
   whole content in the call's *input* — which is why `toolHasDetail` in
   `./index.tsx` cannot just ask whether there was output. */
import { Spinner } from "@/components/ui/spinner"
import {
  CheckIcon,
  FileWarningIcon,
  MessageCircleQuestionIcon,
  PlugZapIcon,
  SparklesIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { TodoChecklist } from "@/components/todo-checklist"
import {
  LABEL,
  PANE,
  PANE_MAX_H,
  PANE_PAD,
  PlanFullscreen,
  Prose,
  ProsePreview,
  SmartBlock,
  ToolProse,
} from "@/components/tool-parts"
import {
  extractFindings,
  extractPlanProposal,
  extractQuestions,
  extractSkill,
  extractTodos,
  extractToolSearch,
  formatMcpName,
  parseMcpToolName,
  shortPath,
  toolOutputText,
  type LoadedTool,
  type TodoEntry,
} from "@/lib/tools"
import type { ToolItem } from "@/lib/store"
import { useThreadId } from "@/lib/thread-id-context"
import { useSkillContent } from "@/lib/queries/catalog"
import { cn } from "@/lib/utils"

// ─── Todos ───────────────────────────────────────────────────────────────────

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
  return <TodoChecklist items={todos} />
}

export function TodosDetail({ item }: { item: ToolItem }) {
  const todos = extractTodos(item) ?? []
  return <TodoList todos={todos} />
}

// ─── Questions ───────────────────────────────────────────────────────────────

/**
 * The record of a question the agent asked. The *live* question is a form
 * (`elicitation-form.tsx`); this is what stays in the transcript once it has
 * been answered — and left generic it was a nested JSON dump of the same
 * options the reader had just clicked one of.
 */
export function QuestionsDetail({ item }: { item: ToolItem }) {
  const questions = extractQuestions(item)
  if (!questions) return null
  return (
    <div className="space-y-2">
      {questions.map((question, index) => {
        const answer = question.answer ?? []
        /* An answer that matches no option is the free-text "Other" the
           AskUserQuestion bridges pair with a select field — it has no row of
           its own to mark, so it gets one below the list. */
        const custom = answer.filter(
          (picked) => !question.options.some((option) => option.label === picked)
        )
        const spelled = question.options.length === 0 ? answer : custom
        return (
          <div key={index} className="space-y-1.5">
            <div className="flex items-start gap-1.5 text-sm">
              <MessageCircleQuestionIcon className="mt-1 size-3 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 text-foreground">
                <ProsePreview text={question.question} />
              </span>
              {question.multiSelect && (
                <Badge variant="secondary">multi-select</Badge>
              )}
            </div>
            {question.options.length > 0 && (
              <ul className="ms-5 space-y-1">
                {question.options.map((option, optionIndex) => {
                  const chosen = answer.includes(option.label)
                  return (
                    <li
                      key={optionIndex}
                      className={cn(
                        "flex items-start gap-2 rounded-lg px-2 py-1 text-sm",
                        chosen ? "bg-primary/10" : "bg-muted"
                      )}
                    >
                      {chosen ? (
                        <CheckIcon className="mt-[0.15em] size-3 shrink-0 text-primary" />
                      ) : (
                        <span
                          aria-hidden
                          className="mt-[0.4em] size-1.5 shrink-0 rounded-full bg-muted-foreground/40"
                        />
                      )}
                      <span className="min-w-0">
                        <ProsePreview
                          text={option.label}
                          className="font-medium text-foreground"
                        />
                        {option.description && (
                          <span className="block text-muted-foreground">
                            <ProsePreview text={option.description} />
                          </span>
                        )}
                      </span>
                      {chosen && <span className="sr-only">chosen</span>}
                    </li>
                  )
                })}
              </ul>
            )}
            {/* The answer stated in words as well as marked in the list: with no
                options at all (a free-text question) the mark has nothing to sit
                on, and a long list makes the one tinted row easy to miss. */}
            {(spelled.length > 0 || question.notes) && (
              <div className="ms-5 space-y-0.5 text-sm">
                {spelled.map((picked, pickedIndex) => (
                  <p key={pickedIndex} className="flex items-start gap-1.5">
                    <CheckIcon className="mt-[0.15em] size-3 shrink-0 text-primary" />
                    <span className="min-w-0 text-foreground">
                      <ProsePreview text={picked} />
                    </span>
                  </p>
                ))}
                {question.notes && (
                  <p className="text-muted-foreground">
                    <ProsePreview text={question.notes} />
                  </p>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * What was answered, on the row itself.
 *
 * A question is the one call in the transcript whose *outcome is the reader's
 * own*, and folded away it was the one call you could not read back: the row
 * said "Ask the user a question", and finding out which of four options you had
 * picked a hundred turns ago meant opening the step. Everything else in a
 * collapsed row is a fact about what the agent did; this is a fact about what
 * you said, so it belongs where the sources strip is — in `StepRow`'s `below`
 * slot, drawn open or closed.
 *
 * It is a summary and not a second copy of `QuestionsDetail`: the picks and the
 * note, without the options that were not taken. The unanswered call renders
 * nothing at all, which is what keeps a question that is still on screen as a
 * form from being answered twice over.
 */
export function ToolAnswers({ item }: { item: ToolItem }) {
  const questions = extractQuestions(item)
  if (!questions) return null
  const answered = questions.filter((question) => (question.answer?.length ?? 0) > 0 || question.notes)
  if (answered.length === 0) return null
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {answered.map((question, index) => (
        <div
          key={index}
          className={cn(PANE_PAD, "min-w-0 space-y-1.5")}
        >
          <div className="flex min-w-0 items-start gap-1.5">
            <MessageCircleQuestionIcon className="mt-0.5 size-3.5 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              {question.header && <div className={cn(LABEL, "mb-0.5")}>{question.header}</div>}
              <div className="text-sm text-foreground">
                <ProsePreview text={question.question} />
              </div>
            </div>
          </div>
          {(question.answer?.length ?? 0) > 0 && (
            <div className="flex min-w-0 flex-wrap gap-1.5 ps-5">
              {(question.answer ?? []).map((picked, pickedIndex) => (
                <Badge key={pickedIndex} title={picked} variant="secondary" className="max-w-full">
                  <CheckIcon />
                  <span className="min-w-0 truncate">{picked}</span>
                </Badge>
              ))}
            </div>
          )}
          {question.notes && (
            <div
              className={cn(
                "rounded-md bg-background px-2 py-1.5 text-xs text-muted-foreground",
                (question.answer?.length ?? 0) > 0 && "ms-5"
              )}
            >
              <span className="me-1 font-medium text-foreground">Note</span>
              <span className="break-words">{question.notes}</span>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ─── Findings ────────────────────────────────────────────────────────────────

/** A review's results. They are a table — file, line, what is wrong — and a
    table is exactly what a JSON dump of them was hiding. */
export function FindingsDetail({ item }: { item: ToolItem }) {
  const findings = extractFindings(item)
  if (!findings) return null
  if (findings.length === 0) {
    return <p className="text-xs text-muted-foreground">No findings.</p>
  }
  return (
    <ul className={cn(PANE, "max-h-80 divide-y overflow-auto")}>
      {findings.map((finding, index) => {
        const where = `${shortPath(finding.file, 48)}${finding.line != null ? `:${finding.line}` : ""}`
        return (
          <li key={index} className="space-y-0.5 px-2.5 py-1.5 text-sm">
            <div className="flex items-center gap-1.5">
              <FileWarningIcon className="size-3 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                {where}
              </span>
              {finding.category && (
                <Badge variant="outline">{finding.category}</Badge>
              )}
              {finding.verdict && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {finding.verdict.toLowerCase()}
                </span>
              )}
            </div>
            <p className="text-foreground">{finding.summary}</p>
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
export function PlanProposalDetail({ item }: { item: ToolItem }) {
  const plan = extractPlanProposal(item)
  if (plan === null) {
    // `switch_mode` with no plan on it — a plain mode change. Say which.
    return <SmartBlock text={toolOutputText(item).text} />
  }
  return (
    <div className="space-y-2">
      <div className={cn(PANE_MAX_H, PANE_PAD, "overflow-auto")}>
        <Prose text={plan} />
      </div>
      {/* The same way out of the capped pane the approval card offers, so a
          plan reads the same whether it is still being asked about or already
          answered. */}
      <PlanFullscreen plan={plan} title={item.title} />
    </div>
  )
}

// ─── Skills ──────────────────────────────────────────────────────────────────

/** A skill load: which packaged workflow came in, with what arguments, and —
    when the runtime read the file — the skill's own description and body. A
    skill's whole point is the instructions it brings, so a name on its own made
    the one call that hands the agent a workflow the least readable in the
    transcript. While the call is active, the same view reads as a distinct
    incoming capability rather than an empty generic tool pane. */
export function SkillDetail({ item, active }: { item: ToolItem; active: boolean }) {
  const skill = extractSkill(item)
  if (!skill) return null
  const { text } = toolOutputText(item, 40_000)
  /* Claude's Skill tool answers only "Launching skill", so the body comes from the library. */
  const library = useSkillContent(useThreadId() ?? "", skill.name, !active && !text.includes("\n"))
  const body = skillBody(library || text)
  return (
    <div
      className={cn(
        "relative isolate overflow-hidden rounded-xl border border-purple-500/20 bg-purple-500/[0.035] p-3",
        active && "border-dashed border-purple-500/35 bg-purple-500/[0.06]"
      )}
    >
      {active && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 start-0 w-1 overflow-hidden bg-purple-500/10"
        >
          <span className="skill-load-rail absolute inset-x-0 top-0 h-1/2 rounded-full bg-purple-500/70" />
        </div>
      )}
      <div className="flex items-start gap-2.5">
        <span className="relative mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-purple-500/10 text-purple-600 dark:text-purple-400">
          {active ? (
            <Spinner aria-hidden className="size-3.5" />
          ) : (
            <SparklesIcon aria-hidden className="size-3.5" />
          )}
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className="font-medium text-foreground">{skill.name}</span>
            {active && (
              <Badge variant="secondary" className="bg-purple-500/10 text-purple-700 dark:text-purple-300">Loading</Badge>
            )}
            {skill.args && (
              <Badge variant="outline" className="font-mono">{skill.args}</Badge>
            )}
          </div>
          {skill.description ? (
            <p className="text-xs leading-4 text-muted-foreground">{skill.description}</p>
          ) : active ? (
            <p className="text-xs leading-4 text-muted-foreground">Preparing skill instructions for this turn</p>
          ) : null}
          {body && <ToolProse text={body} />}
        </div>
      </div>
    </div>
  )
}

/** A skill file's YAML frontmatter stripped: the reader wants the instructions,
    not the `name:`/`description:` block that has already been read out of it. */
function skillBody(text: string): string {
  if (!text.startsWith("---")) return text.trim()
  const end = text.indexOf("\n---", 3)
  if (end === -1) return text.trim()
  const after = text.indexOf("\n", end + 1)
  return (after === -1 ? "" : text.slice(after + 1)).trim()
}

// ─── Tool search ─────────────────────────────────────────────────────────────

/** A tool search: the tools it loaded, each under the server it belongs to and
    with what it does, where the runtime said (Claude Code sends names only).
    The query is the row's heading, so it is not repeated here. */
export function ToolSearchDetail({ item }: { item: ToolItem }) {
  const search = extractToolSearch(item)
  if (!search) return null
  if (search.tools.length === 0) {
    if (item.status !== "completed") return null
    return <p className="text-xs text-muted-foreground">No tool matched.</p>
  }
  return <LoadedToolList tools={search.tools} />
}

function LoadedToolList({ tools }: { tools: LoadedTool[] }) {
  return (
    <ul className={cn(PANE, "max-h-80 divide-y overflow-auto")}>
      {tools.map((tool) => {
        const mcp = parseMcpToolName(tool.name)
        return (
          <li key={tool.name} className="space-y-0.5 px-2.5 py-1.5 text-sm">
            <div className="flex min-w-0 items-center gap-1.5">
              <PlugZapIcon className="size-3 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate font-mono text-foreground" title={tool.name}>
                {mcp?.tool ? formatMcpName(mcp.tool) : tool.name}
              </span>
              {mcp && (
                <Badge variant="outline">{formatMcpName(mcp.server)}</Badge>
              )}
            </div>
            {tool.description && <p className="line-clamp-2 text-xs text-muted-foreground">{tool.description}</p>}
          </li>
        )
      })}
    </ul>
  )
}
