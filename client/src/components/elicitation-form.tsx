import * as React from "react"
import { CheckIcon, ExternalLinkIcon, MessageCircleQuestionIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  AgentRequestActions,
  AgentRequestBody,
  AgentRequestCard,
  AgentRequestHeader,
  REQUEST_BUTTON,
} from "./agent-request"
import { Kbd } from "@/components/ui/kbd"
import {
  Questionnaire,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireDescription,
  QuestionnaireError,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireSkip,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "@/components/ui/questionnaire"
import {
  elicitationAnswers,
  elicitationFields,
  isFormElicitation,
  isUrlElicitation,
  type ElicitationField,
} from "@/lib/elicitation"
import type { PendingElicitation } from "@/lib/store"
import { Prose, ProsePreview } from "./tool-parts"
import { cn } from "@/lib/utils"

/* The agent asked something, and the turn is stopped until it hears back — so
   this card carries the same weight as the permission card and sits in the same
   place. The shape is different: a permission is one verdict, a question can be
   several, each with its own options, its own "Other" box and its own skip. It
   renders as a questionnaire stepper — one question on screen at a time, so a
   three-question form doesn't bury the transcript under a wall of radios.

   Hierarchy, top to bottom: who is asking and how far in (header), what is
   being asked (the step's title), what you can answer (choices, then the free
   text that overrides them), and how to move (one action bar). Declining is a
   real answer — the AskUserQuestion bridges read a missing field as "the user
   skipped" and let the turn continue — so the way out lives in the bar as a
   peer of the answer, not hidden underneath it. */

/** The step's own question. With one question the prompt is the elicitation's
    `message` and the field title is a short header ("Auth method"); with
    several, `message` is boilerplate and each field carries its own text. */
function fieldPrompt(field: ElicitationField, message: string, single: boolean): string {
  if (single) return message
  return field.description || field.title || field.key
}

/** Step dots: how many questions, which one is open, which are behind you.
    Cheaper to read at a glance than "2 of 3", and it sits in the header where
    the eye already is rather than competing with the actions. */
function StepDots({ total, current }: { total: number; current: number }) {
  return (
    <span aria-hidden className="flex shrink-0 items-center gap-1 pt-0.5">
      {Array.from({ length: total }, (_, index) => (
        <span
          key={index}
          className={cn(
            "size-1.5 rounded-full transition-colors",
            index === current ? "bg-primary" : index < current ? "bg-primary/40" : "bg-border"
          )}
        />
      ))}
    </span>
  )
}

function ElicitationStep({
  field,
  message,
  single,
}: {
  field: ElicitationField
  message: string
  single: boolean
}) {
  const prompt = fieldPrompt(field, message, single)
  // The header is a label for the question, so it belongs beside it as a chip —
  // the same right-hand column the transcript's step rows and the permission
  // card scan on. Dropped when it would only repeat the question.
  const chip = field.title && field.title !== prompt ? field.title : undefined
  const choices = field.options.length > 0

  return (
    <QuestionnaireItem
      name={field.key}
      required={field.required}
      multiple={field.kind === "multiselect"}
      className="gap-3.5"
    >
      <div className="flex items-start justify-between gap-3">
        {/* mb-0! because the wrapper's own margin is set by a `:has(~ …)`
            variant that can't see the description through this row. */}
        <QuestionnaireTitle className="mb-0! flex-1 text-[15px] leading-snug">
          <ProsePreview text={prompt} className="text-[15px] leading-snug" />
        </QuestionnaireTitle>
        {chip && (
          <span className="mt-px shrink-0 rounded-full bg-background/60 px-2 py-0.5 text-[10px] leading-4 tracking-wide text-muted-foreground">
            {chip}
          </span>
        )}
      </div>
      {/* Two things the user can only learn from the schema: that this one takes
          more than one answer, and that it can't be skipped. */}
      {(field.kind === "multiselect" || field.required) && (
        <QuestionnaireDescription className="text-xs">
          {field.kind === "multiselect" ? "Choose as many as apply." : "Required."}
        </QuestionnaireDescription>
      )}
      {choices && (
        <QuestionnaireChoices>
          {field.options.map((option) => (
            <QuestionnaireChoice
              key={option.value}
              value={option.value}
              /* Same material as everything else on this card: no outline, a
                 recess against the tint, and a stronger fill of the accent when
                 chosen. The kit's default is a bordered pill on a page
                 background — correct on a settings form, a foreign object
                 inside a borderless tinted card. The shortcut badge follows,
                 or it is the one outlined thing left in the card. */
              className="rounded-xl border-transparent bg-background/60 hover:bg-background/80 data-checked:border-transparent data-checked:bg-primary/15 [&_[data-slot=questionnaire-choice-shortcut]]:border-transparent [&_[data-slot=questionnaire-choice-shortcut]]:bg-primary/10"
            >
              <ProsePreview text={option.label} className="font-medium" />
              {option.description && (
                <QuestionnaireChoiceDescription className="text-xs">
                  <ProsePreview text={option.description} />
                </QuestionnaireChoiceDescription>
              )}
              {/* A preview is a mockup or a snippet the option wants compared
                  against its siblings, so every option shows its own rather
                  than revealing one at a time — but capped, since a long one
                  would push the next option off the screen. */}
              {option.preview && (
                /* One step further down than the option it sits in — the same
                   `bg-background/60` would make it invisible against its own
                   parent. Prose marks up a markdown preview; a code preview
                   still finds its fenced blocks styled by the same renderer. */
                <div className="mt-1.5 max-h-40 overflow-auto rounded-lg bg-muted/60 px-2.5 py-2 text-[11px] leading-relaxed text-foreground/90">
                  <Prose text={option.preview} />
                </div>
              )}
            </QuestionnaireChoice>
          ))}
        </QuestionnaireChoices>
      )}
      {/* Free text. Alongside options this is the "Other" box: the questionnaire
          hands the field's name to whichever control was actually used, so
          typing here replaces the selection instead of adding to it. */}
      {(!choices || field.customKey) && (
        <QuestionnaireInput
          type={field.kind === "number" ? "number" : "text"}
          defaultValue={choices ? undefined : field.defaultValue}
          placeholder={choices ? "Or type your own answer…" : "Type your answer…"}
          // Squared off to match the choice cards; the "Other" box is quieter
          // than the options it sits under, so it loses the filled background.
          className={cn(
            "rounded-xl border-transparent bg-background/60 text-sm",
            // Under a set of options this is the "Other" box, so it stays
            // quieter than they are — but it keeps their height and material.
            choices && "bg-background/40"
          )}
        />
      )}
      {/* No children: the primitive's own text already distinguishes a required
          question from one you are allowed to skip. */}
      <QuestionnaireError className="mt-0 text-xs" />
    </QuestionnaireItem>
  )
}

export function InlineElicitation({ elicitation }: { elicitation: PendingElicitation }) {
  const { request, resolve } = elicitation
  // The agent is blocked on this request; a resolve that already fired must not
  // fire again when the form's own submit and a peer's answer race.
  const settled = React.useRef(false)
  const settle = (response: Parameters<typeof resolve>[0]) => {
    if (settled.current) return
    settled.current = true
    resolve(response)
  }

  /* The payload guards, not a `mode === "form"` check: the union's custom/future
     variant carries the same tag shape. See lib/elicitation. */
  const form = isFormElicitation(request) ? request : null
  const url = isUrlElicitation(request) ? request : null
  const fields = React.useMemo(() => (form ? elicitationFields(form.requestedSchema) : []), [form])
  const items = React.useMemo(
    () =>
      fields.map((field) => ({
        name: field.key,
        required: field.required,
        choices: field.options.map((option) => ({ value: option.value })),
      })),
    [fields]
  )
  const single = fields.length === 1
  const [step, setStep] = React.useState(fields[0]?.key)

  const eyebrow = url
    ? "Action needed"
    : fields.length > 1
      ? `${fields.length} questions`
      : "Question"
  const current = Math.max(
    0,
    fields.findIndex((field) => field.key === step)
  )

  /* Same shell as the permission card — accent rail, tinted body, tinted action
     bar (components/agent-request). Both are "the turn has stopped and you are
     what it is waiting for"; a reader should not have to learn two objects for
     one situation. Only the contents differ, and they differ because a verdict
     and a questionnaire genuinely are different things. */
  const shell = (children: React.ReactNode, message?: string, actions?: React.ReactNode) => (
    <AgentRequestCard>
      <AgentRequestHeader
        icon={MessageCircleQuestionIcon}
        label={eyebrow}
        aside={
          !single && fields.length > 0 ? (
            <StepDots total={fields.length} current={current} />
          ) : undefined
        }
      >
        {/* With one question the step's own title says it; repeating the
            message above it would print the same sentence twice. */}
        {message}
      </AgentRequestHeader>
      {children}
      {actions && <AgentRequestActions>{actions}</AgentRequestActions>}
    </AgentRequestCard>
  )

  /* A URL elicitation has no form: the answer happens on the far side of the
     link, and the agent tells us when (elicitation/complete). All this card
     owes the user is the link and a way out. */
  if (url) {
    return shell(
      null,
      request.message,
      <>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className={cn(REQUEST_BUTTON, "text-muted-foreground")}
          onClick={() => settle({ action: "decline" })}
        >
          Dismiss
        </Button>
        <Button
          size="sm"
          className={cn(REQUEST_BUTTON, "ms-auto")}
          render={
            <a href={url.url} target="_blank" rel="noreferrer noopener">
              <ExternalLinkIcon aria-hidden className="size-3" />
              Open
            </a>
          }
        />
      </>
    )
  }

  // A form with no readable fields is one we cannot answer honestly — say so
  // rather than showing an empty questionnaire the agent is waiting on.
  if (fields.length === 0) {
    return shell(
      <AgentRequestBody>
        <p className="text-muted-foreground">
          This question arrived in a form this client can't render.
        </p>
      </AgentRequestBody>,
      request.message,
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className={cn(REQUEST_BUTTON, "ms-auto")}
        onClick={() => settle({ action: "decline" })}
      >
        Skip
      </Button>
    )
  }

  /* The form element wraps the whole card, not just its body: the nav lives on
     the header line now, and Next/Submit are form controls — they have to be
     inside the form they submit. */
  return (
    <Questionnaire
      items={items}
      item={step}
      onItemChange={setStep}
      shortcuts="numbers"
      className="gap-0"
      onSubmit={(event) => {
        event.preventDefault()
        settle({
          action: "accept",
          content: elicitationAnswers(fields, new FormData(event.currentTarget)),
        })
      }}
    >
      <AgentRequestCard>
        <AgentRequestHeader
          icon={MessageCircleQuestionIcon}
          label={eyebrow}
          aside={!single ? <StepDots total={fields.length} current={current} /> : undefined}
        >
          {/* Only when there are several: then `message` is the form's own
              framing ("Please answer the following questions.") and each step
              states its own question below it. With one question the two would
              be the same sentence printed twice. */}
          {!single && request.message}
        </AgentRequestHeader>
        <AgentRequestBody>
          {fields.map((field) => (
            <ElicitationStep
              key={field.key}
              field={field}
              message={request.message}
              single={single}
            />
          ))}
        </AgentRequestBody>
        <AgentRequestActions>
          {/* Grouped rather than pushed apart button by button: Previous and
              Skip hide themselves (first step, required question), and an auto
              margin on a hidden button stops pushing. */}
          <div className="flex items-center gap-1.5">
            <QuestionnairePrevious
              size="sm"
              variant="ghost"
              className={cn(REQUEST_BUTTON, "text-muted-foreground")}
            />
            {/* Declining answers the whole thing — "I'm not doing this" — where
                the questionnaire's own Skip passes on one question and carries
                you to the next. */}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className={cn(REQUEST_BUTTON, "text-muted-foreground")}
              onClick={() => settle({ action: "decline" })}
            >
              {single ? "Don't answer" : "Dismiss"}
              {/* Escape does this from anywhere in the thread — including from
                  the composer, where the cursor usually is. */}
              <Kbd className="ms-1 hidden bg-transparent sm:inline-flex">Esc</Kbd>
            </Button>
          </div>
          <div className="ms-auto flex items-center gap-1.5">
            <QuestionnaireSkip
              size="sm"
              variant="ghost"
              className={cn(REQUEST_BUTTON, "text-muted-foreground")}
            >
              Skip this
            </QuestionnaireSkip>
            <QuestionnaireNext size="sm" className={REQUEST_BUTTON} />
            <QuestionnaireSubmit size="sm" className={REQUEST_BUTTON}>
              <CheckIcon aria-hidden className="size-3.5" />
              {single ? "Answer" : "Submit"}
            </QuestionnaireSubmit>
          </div>
        </AgentRequestActions>
      </AgentRequestCard>
    </Questionnaire>
  )
}
