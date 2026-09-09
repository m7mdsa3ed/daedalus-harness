/* ── The structured views ──
   Calls whose content is a shape rather than a stream: a checklist, a question
   and its answer, a review's findings, a proposed plan, a skill load. Each of
   these was a JSON dump before it had a view, and most of them carry their
   whole content in the call's *input* — which is why `toolHasDetail` in
   `./index.tsx` cannot just ask whether there was output. */
import {
  CheckIcon,
  FileWarningIcon,
  MessageCircleQuestionIcon,
  SparklesIcon,
} from "lucide-react"
import {
  LABEL,
  PANE,
  PANE_MAX_H,
  PANE_PAD,
  PlanFullscreen,
  Prose,
  ProsePreview,
  SmartBlock,
} from "@/components/tool-parts"
import { useThreadLinks } from "@/lib/workspace/thread-links"
import {
  extractFindings,
  extractPlanProposal,
  extractQuestions,
  extractSkill,
  extractTodos,
  shortPath,
  toolOutputText,
  type TodoEntry,
} from "@/lib/tools"
import type { ToolItem } from "@/lib/store"
import { cn } from "@/lib/utils"

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
            <div className="flex items-start gap-1.5 text-xs">
              <MessageCircleQuestionIcon className="mt-1 size-3 shrink-0 text-muted-foreground/60" />
              <span className="min-w-0 flex-1 text-foreground">
                <ProsePreview text={question.question} />
              </span>
              {question.multiSelect && (
                <span className="shrink-0 rounded-sm bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  multi-select
                </span>
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
                        "flex items-start gap-2 rounded-lg px-2 py-1 text-[11.5px]",
                        chosen ? "bg-primary/10 ring-1 ring-primary/25" : "bg-background/50"
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
                          className={cn("font-medium", chosen ? "text-foreground" : "text-foreground/90")}
                        />
                        {option.description && (
                          <span className="block text-muted-foreground/70">
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
              <div className="ms-5 space-y-0.5 text-[11.5px]">
                {spelled.map((picked, pickedIndex) => (
                  <p key={pickedIndex} className="flex items-start gap-1.5">
                    <CheckIcon className="mt-[0.15em] size-3 shrink-0 text-primary" />
                    <span className="min-w-0 text-foreground">
                      <ProsePreview text={picked} />
                    </span>
                  </p>
                ))}
                {question.notes && (
                  <p className="text-muted-foreground/80">
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
    <div className="flex min-w-0 flex-col gap-1">
      {answered.map((question, index) => (
        <div key={index} className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
          {/* The header, not the question: a question is a sentence and this is
              a strip. With no header the chips stand alone — which reads fine,
              because the row above them is the question. */}
          {question.header && (
            <span className={cn(LABEL, "shrink-0")}>
              {question.header}
            </span>
          )}
          {(question.answer ?? []).map((picked, pickedIndex) => (
            <span
              key={pickedIndex}
              title={picked}
              className="flex min-w-0 items-center gap-1 rounded-pill bg-primary/10 px-1.5 py-0.5 text-[11px] leading-4 text-primary"
            >
              <CheckIcon className="size-2.5 shrink-0" />
              <span className="min-w-0 max-w-[16rem] truncate">{picked}</span>
            </span>
          ))}
          {question.notes && (
            <span
              title={question.notes}
              className="min-w-0 max-w-[20rem] truncate text-[11px] leading-4 text-muted-foreground/70"
            >
              {question.notes}
            </span>
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
                <span className="shrink-0 rounded-sm border border-border/60 px-1 text-[10px] text-muted-foreground/70">
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

/** A skill load: which packaged workflow came in, and with what arguments. The
    call returns nothing, so the name is the whole story. */
export function SkillDetail({ item }: { item: ToolItem }) {
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
