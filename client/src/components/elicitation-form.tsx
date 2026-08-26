import * as React from "react"
import { CreateElicitationRequest } from "@agentclientprotocol/sdk"
import { CheckIcon, ExternalLinkIcon, MessageCircleQuestionIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
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
import { elicitationAnswers, elicitationFields, type ElicitationField } from "@/lib/elicitation"
import type { PendingElicitation } from "@/lib/store"
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
          {prompt}
        </QuestionnaireTitle>
        {chip && (
          <span className="mt-px shrink-0 rounded-full border border-border/50 bg-muted/30 px-2 py-px text-[10px] leading-4 tracking-wide text-muted-foreground">
            {chip}
          </span>
        )}
      </div>
      {/* Two things the user can only learn from the schema: that this one takes
          more than one answer, and that it can't be skipped. */}
      {(field.kind === "multiselect" || field.required) && (
        <QuestionnaireDescription className="-mt-1.5 text-xs">
          {field.kind === "multiselect" ? "Choose as many as apply." : "Required."}
        </QuestionnaireDescription>
      )}
      {choices && (
        <QuestionnaireChoices>
          {field.options.map((option) => (
            <QuestionnaireChoice key={option.value} value={option.value} className="rounded-xl">
              <span className="font-medium">{option.label}</span>
              {option.description && (
                <QuestionnaireChoiceDescription className="text-xs">
                  {option.description}
                </QuestionnaireChoiceDescription>
              )}
              {/* A preview is a mockup or a snippet the option wants compared
                  against its siblings, so every option shows its own rather
                  than revealing one at a time — but capped, since a long one
                  would push the next option off the screen. */}
              {option.preview && (
                <pre className="mt-1.5 max-h-40 overflow-auto rounded-lg border border-border/50 bg-muted/40 px-2.5 py-2 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-foreground/90">
                  {option.preview}
                </pre>
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
          className={cn("rounded-xl text-sm", choices && "-mt-0.5 h-9 min-h-9 bg-transparent")}
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

  /* The SDK's guards, not a `mode === "form"` check: the union's custom/future
     variant carries the same tag shape, and these validate the payload too — a
     malformed form matches nothing and falls through to the can't-render card
     rather than throwing halfway down the schema. */
  const form = CreateElicitationRequest.isForm(request) ? request : null
  const url = CreateElicitationRequest.isUrl(request) ? request : null
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

  const shell = (children: React.ReactNode, message?: string) => (
    <div
      aria-live="polite"
      role="group"
      className="animate-in slide-in-from-bottom-1 fade-in zoom-in-[0.99] overflow-hidden rounded-xl border border-primary/30 bg-card/80 shadow-md shadow-primary/5 backdrop-blur-sm duration-200"
    >
      <div className="flex items-start gap-3 p-3.5 pb-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-primary ring-1 ring-primary/15 ring-inset">
          <MessageCircleQuestionIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="harness-shimmer text-[10px] font-medium tracking-widest text-primary uppercase">
            {eyebrow}
          </p>
          {/* With one question the step's own title says it; repeating the
              message above it would print the same sentence twice. */}
          {message && (
            <p className="mt-1 text-[13px] leading-snug text-pretty break-words text-muted-foreground">
              {message}
            </p>
          )}
        </div>
        {!single && fields.length > 0 && <StepDots total={fields.length} current={current} />}
      </div>
      {children}
    </div>
  )

  /** The bar every variant ends with: the way out on the left, the way forward
      on the right, never adjacent. */
  const bar = (children: React.ReactNode) => (
    <div className="flex flex-wrap items-center gap-1.5 border-t border-border/50 bg-muted/25 px-3.5 py-2.5">
      {children}
    </div>
  )

  /* A URL elicitation has no form: the answer happens on the far side of the
     link, and the agent tells us when (elicitation/complete). All this card
     owes the user is the link and a way out. */
  if (url) {
    return shell(
      bar(
        <>
          <Button
            type="button"
            size="default"
            variant="ghost"
            className="text-muted-foreground"
            onClick={() => settle({ action: "decline" })}
          >
            Dismiss
          </Button>
          <Button
            size="default"
            className="ms-auto font-semibold"
            render={
              <a href={url.url} target="_blank" rel="noreferrer noopener">
                <ExternalLinkIcon data-icon="inline-start" className="size-3.5 opacity-80" />
                Open
              </a>
            }
          />
        </>
      ),
      request.message
    )
  }

  // A form with no readable fields is one we cannot answer honestly — say so
  // rather than showing an empty questionnaire the agent is waiting on.
  if (fields.length === 0) {
    return shell(
      bar(
        <>
          <p className="me-auto min-w-0 flex-1 text-[13px] text-muted-foreground">
            This question arrived in a form this client can't render.
          </p>
          <Button
            type="button"
            size="default"
            variant="secondary"
            onClick={() => settle({ action: "decline" })}
          >
            Skip
          </Button>
        </>
      ),
      request.message
    )
  }

  return shell(
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
      <div className="px-3.5 pb-3.5">
        {fields.map((field) => (
          <ElicitationStep key={field.key} field={field} message={request.message} single={single} />
        ))}
      </div>
      {bar(
        <>
          {/* Grouped rather than pushed apart button by button: any of these can
              hide itself (Previous on the first step, Skip on a required one),
              and an auto margin on a hidden button stops pushing. */}
          <div className="flex items-center gap-1.5">
            <QuestionnairePrevious size="sm" variant="ghost" className="text-muted-foreground" />
            {/* Declining answers the whole thing — "I'm not doing this" — where
                the questionnaire's own Skip passes on one question and carries
                you to the next. */}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-muted-foreground"
              onClick={() => settle({ action: "decline" })}
            >
              {single ? "Don't answer" : "Dismiss"}
            </Button>
          </div>
          <div className="ms-auto flex items-center gap-1.5">
            <QuestionnaireSkip size="sm" variant="ghost" className="text-muted-foreground">
              Skip this
            </QuestionnaireSkip>
            <QuestionnaireNext size="default" />
            <QuestionnaireSubmit size="default" className="font-semibold">
              <CheckIcon data-icon="inline-start" className="size-3.5 opacity-80" />
              {single ? "Answer" : "Submit"}
            </QuestionnaireSubmit>
          </div>
        </>
      )}
    </Questionnaire>,
    /* Only when there are several: then `message` is the form's own framing
       ("Please answer the following questions.") and each step states its own
       question below it. With one question the two would be the same sentence
       printed twice. */
    single ? undefined : request.message
  )
}
