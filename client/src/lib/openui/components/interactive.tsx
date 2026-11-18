/* ── The interactive half of the generated-view library ──
   A drawn answer could already be folded and switched; what it could not do was
   hold state or say something back. These are the components that let it:

   — **a field** (`Input`, `Textarea`, `Select`, `Checkbox`, `Slider`) whose value
     lives in the renderer's own store, either as one of the program's
     `$variables` (a two-way binding) or as form state scoped by name;
   — **`Form`** and **`FormControl`**, which are the name and the label around
     those fields, and own the validation context a submit consults;
   — **`Button`**, the one thing that reaches out — and it reaches out by *filling
     the reader's composer, unsent* (`onAction` → `continue_conversation`). The
     same bargain a suggested follow-up and a `!` completer make: the person still
     presses send, having read it.

   That last part is the whole boundary. No `toolProvider` is passed to the
   `Renderer`, so a `Query`/`Mutation` in a program has no tool to find, and the
   prompt tells the model not to write one. A generated view composes what the
   model already knows and asks for words; every actual tool call stays a normal
   ACP call, with a permission in front of it.

   Two schema details carry the language's own machinery and cannot be guessed:

   — a value prop is wrapped in `reactive(...)`, which is what lets the evaluator
     hand the component a `$variable` binding instead of a value
     (`resolveStateField` turns it into store get/set), and what makes the prompt
     print `$binding<string>`;
   — an action prop is tagged `ActionExpression`, which is what makes the parser
     evaluate `Action([...])` into an `ActionPlan` and what makes the generated
     prompt carry the Action section at all. */
import { z } from "zod/v4"
import { useEffect, useMemo, useRef, useState } from "react"
import { CalendarIcon, X } from "lucide-react"
import {
  FormNameContext,
  FormValidationContext,
  defineComponent,
  isReactiveAssign,
  parseStructuredRules,
  reactive,
  tagSchemaId,
  useCreateFormValidation,
  useFormName,
  useFormValidation,
  useGetFieldValue,
  useIsStreaming,
  useSetDefaultValue,
  useStateField,
  useTriggerAction,
  type ActionPlan,
} from "@openuidev/react-lang"
import { Button as UiButton } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Checkbox as UiCheckbox } from "@/components/ui/checkbox"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { RadioGroup as UiRadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Switch as UiSwitch } from "@/components/ui/switch"
import { Field, FieldDescription, FieldError, FieldTitle } from "@/components/ui/field"
import { Input as UiInput } from "@/components/ui/input"
import { Select as UiSelect, SelectContent, SelectItem as UiSelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider as UiSlider } from "@/components/ui/slider"
import { Textarea as UiTextarea } from "@/components/ui/textarea"
import { BODY, FLOW, META } from "@/lib/openui/kit"
import { cn } from "@/lib/utils"

/* Both are tagged rather than spelled out: a signature carrying
   `Record<string, any>` teaches nothing, and `ActionExpression` is the name the
   generator looks for to switch the Action section on. */
const ActionExpression = z.any()
tagSchemaId(ActionExpression, "ActionExpression")

/** `{required: true, minLength: 3, email: true}` — the builtin validators. */
const Rules = z.record(z.string(), z.any())
tagSchemaId(Rules, "Rules")

const VARIANT = { primary: "default", secondary: "secondary", ghost: "ghost" } as const

/* ── One field ──
   Everything the four field components share: the resolved value (a `$variable`
   when the program bound one, else its own form state), the rules, and the
   registration that makes a form's submit able to say no. `useSetDefaultValue`
   is what puts a literal the model wrote — `Select("role", [items], null, null,
   "engineer")` — into form state; without it a field the reader never touched
   would carry nothing into the message. */
function useField(name: string, binding: unknown, rules?: unknown) {
  const field = useStateField(name, binding)
  const parsed = useMemo(() => parseStructuredRules(rules), [rules])
  const validation = useFormValidation()
  const formName = useFormName()
  const stored = useGetFieldValue()(formName, name)

  useSetDefaultValue({
    formName,
    name,
    existingValue: stored,
    defaultValue: isReactiveAssign(binding) ? undefined : binding,
  })

  /* Read through a ref: the registration is per rules/name, and re-registering
     per keystroke would be one form rebuild per character. */
  const valueRef = useRef(field.value)
  valueRef.current = field.value
  useEffect(() => {
    if (!validation) return
    validation.registerField(name, parsed, () => valueRef.current)
    return () => validation.unregisterField(name)
  }, [validation, name, parsed])

  return {
    value: field.value,
    set: (next: unknown) => field.setValue(next),
    error: validation?.errors[name],
    /* A caller that has just set a value passes it: `valueRef` still holds the
       old one until the next render, so a pick would be checked as the empty
       value it replaced. */
    check: (value: unknown = valueRef.current) => (validation ? validation.validateField(name, value, parsed) : true),
  }
}

/* ── The trigger ── */

const Button = defineComponent({
  name: "Button",
  description:
    "A button. Its action asks the assistant for words — the click fills the reader's composer, unsent. It never runs a tool.",
  props: z.object({
    label: z.string(),
    action: ActionExpression.optional(),
    variant: z.enum(["primary", "secondary", "ghost"]).optional(),
  }),
  component: ({ props }) => {
    const trigger = useTriggerAction()
    const streaming = useIsStreaming()
    const formName = useFormName()
    const validation = useFormValidation()
    return (
      <UiButton
        type="button"
        size="sm"
        variant={VARIANT[props.variant ?? "primary"]}
        /* Writing itself is not a thing to click: a half-written program's
           button would send a label from a view that is still arriving. */
        disabled={streaming}
        onClick={() => {
          if (streaming) return
          if (validation && !validation.validateForm()) return
          void trigger(props.label, formName, props.action as ActionPlan | undefined)
        }}
      >
        {props.label}
      </UiButton>
    )
  },
})

/* ── The form ── */

const Form = defineComponent({
  name: "Form",
  description:
    "A set of fields with the button that sends them. The values the reader leaves behind travel with that button's message.",
  props: z.object({
    name: z.string(),
    submit: z.any(),
    children: z.array(z.any()),
  }),
  component: ({ props, renderNode }) => {
    /* Created here and provided down, so every field under it registers into
       the context its own submit consults. */
    const validation = useCreateFormValidation()
    return (
      <FormValidationContext.Provider value={validation}>
        <FormNameContext.Provider value={props.name}>
          {/* Nothing is ever posted: the submit button is an Action in the
              program, not a native submit. */}
          <form className={FLOW} onSubmit={(event) => event.preventDefault()}>
            {renderNode(props.children)}
            {renderNode(props.submit)}
          </form>
        </FormNameContext.Provider>
      </FormValidationContext.Provider>
    )
  },
})

const FormControl = defineComponent({
  name: "FormControl",
  description: "A field's label, the field, and one line of guidance under it.",
  props: z.object({
    label: z.string(),
    children: z.any(),
    hint: z.string().optional(),
  }),
  component: ({ props, renderNode }) => (
    /* Not a `<label>`: a Checkbox draws one of its own, and a label inside a
       label is not a thing HTML has. The field names itself for a screen
       reader with its `name`. */
    <Field className="min-w-0 gap-1.5">
      <FieldTitle className="text-xs leading-snug font-medium text-muted-foreground">{props.label}</FieldTitle>
      {renderNode(props.children)}
      {props.hint && <FieldDescription className="text-xs">{props.hint}</FieldDescription>}
    </Field>
  ),
})

/* ── The fields ── */

const Input = defineComponent({
  name: "Input",
  description: "A one-line text field.",
  props: z.object({
    name: z.string(),
    placeholder: z.string().optional(),
    type: z.enum(["text", "email", "number", "date", "url", "password"]).optional(),
    rules: Rules.optional(),
    value: reactive(z.string().optional()),
  }),
  component: ({ props }) => {
    const field = useField(props.name, props.value, props.rules)
    return (
      <div className="min-w-0 space-y-1">
        <UiInput
          name={props.name}
          aria-label={props.name}
          type={props.type ?? "text"}
          placeholder={props.placeholder}
          value={field.value == null ? "" : String(field.value)}
          aria-invalid={field.error ? true : undefined}
          onChange={(event) => field.set(event.target.value)}
          onBlur={() => field.check()}
        />
        <FieldError>{field.error}</FieldError>
      </div>
    )
  },
})

const Textarea = defineComponent({
  name: "Textarea",
  description: "A multi-line text field.",
  props: z.object({
    name: z.string(),
    placeholder: z.string().optional(),
    rules: Rules.optional(),
    value: reactive(z.string().optional()),
  }),
  component: ({ props }) => {
    const field = useField(props.name, props.value, props.rules)
    return (
      <div className="min-w-0 space-y-1">
        <UiTextarea
          name={props.name}
          aria-label={props.name}
          placeholder={props.placeholder}
          rows={3}
          value={field.value == null ? "" : String(field.value)}
          aria-invalid={field.error ? true : undefined}
          onChange={(event) => field.set(event.target.value)}
          onBlur={() => field.check()}
        />
        <FieldError>{field.error}</FieldError>
      </div>
    )
  },
})

const SelectItem = defineComponent({
  name: "SelectItem",
  description: "One option in a Select: the value it sends and the words the reader sees.",
  props: z.object({ value: z.string(), label: z.string() }),
  component: ({ props }) => <UiSelectItem value={props.value}>{props.label}</UiSelectItem>,
})

/** The selected option's words, read off the node the program wrote — the
    trigger has to say "Last 7 days" where the value is "7d". */
function optionLabel(items: unknown, value: string): string {
  const list = Array.isArray(items) ? items : []
  for (const item of list) {
    const props = (item as { props?: { value?: unknown; label?: unknown } } | null)?.props
    if (props && String(props.value) === value && typeof props.label === "string") return props.label
  }
  return value
}

const Select = defineComponent({
  name: "Select",
  description: "A dropdown of SelectItems — the usual way to filter what this view already draws.",
  props: z.object({
    name: z.string(),
    items: z.array(SelectItem.ref),
    placeholder: z.string().optional(),
    rules: Rules.optional(),
    value: reactive(z.string().optional()),
  }),
  component: ({ props, renderNode }) => {
    const field = useField(props.name, props.value, props.rules)
    const value = field.value == null ? null : String(field.value)
    return (
      <div className="min-w-0 space-y-1">
        <UiSelect
          value={value}
          onValueChange={(next) => {
            field.set(next)
            field.check(next)
          }}
        >
          <SelectTrigger className="w-full min-w-0 data-[size=default]:pointer-coarse:h-11" aria-label={props.name}>
            {/* Explicit children: Base UI's `SelectValue` renders none of its own. */}
            <SelectValue>{value === null ? (props.placeholder ?? "Pick one") : optionLabel(props.items, value)}</SelectValue>
          </SelectTrigger>
          <SelectContent>{renderNode(props.items)}</SelectContent>
        </UiSelect>
        <FieldError>{field.error}</FieldError>
      </div>
    )
  },
})

const Checkbox = defineComponent({
  name: "Checkbox",
  description: "A single on/off choice with its own label.",
  props: z.object({
    name: z.string(),
    label: z.string().optional(),
    value: reactive(z.boolean().optional()),
  }),
  component: ({ props }) => {
    const field = useField(props.name, props.value)
    return (
      <label className="flex min-w-0 items-center gap-2.5 pointer-coarse:min-h-11">
        <UiCheckbox checked={field.value === true} onCheckedChange={(checked) => field.set(checked === true)} />
        <span className={BODY}>{props.label ?? props.name}</span>
      </label>
    )
  },
})

/* ── One of a few, all in view ──
   The options are `SelectItem`s, the same nodes a Select takes, so the model
   learns one way to write a choice. They are read for their value and label,
   never rendered: a SelectItem draws a dropdown row. */
const RadioGroup = defineComponent({
  name: "RadioGroup",
  description: "One choice from a few options, all shown at once — where a Select would hide options the reader should compare.",
  props: z.object({
    name: z.string(),
    items: z.array(SelectItem.ref),
    rules: Rules.optional(),
    value: reactive(z.string().optional()),
  }),
  component: ({ props }) => {
    const field = useField(props.name, props.value, props.rules)
    const options = (Array.isArray(props.items) ? props.items : []).flatMap((item) => {
      const raw = (item as { props?: { value?: unknown; label?: unknown } } | null)?.props
      return raw && raw.value != null ? [{ value: String(raw.value), label: typeof raw.label === "string" ? raw.label : String(raw.value) }] : []
    })
    return (
      <div className="min-w-0 space-y-1">
        <UiRadioGroup
          aria-label={props.name}
          value={field.value == null ? null : String(field.value)}
          onValueChange={(next) => {
            field.set(next)
            field.check(next)
          }}
          className="gap-1 @panel-sm:gap-1.5"
        >
          {options.map((option) => (
            <label key={option.value} className="flex min-w-0 cursor-pointer items-center gap-2.5 py-0.5 pointer-coarse:min-h-11">
              <RadioGroupItem value={option.value} />
              <span className={BODY}>{option.label}</span>
            </label>
          ))}
        </UiRadioGroup>
        <FieldError>{field.error}</FieldError>
      </div>
    )
  },
})

/* ── A setting, on or off ──
   The same value as a Checkbox; the difference is what it says. A checkbox is
   a thing to include, a switch a thing that takes effect — and it is laid out
   like a settings row, its label at the start and the control at the end. */
const Switch = defineComponent({
  name: "Switch",
  description: "An on/off setting, drawn as a toggle with its label before it.",
  props: z.object({
    name: z.string(),
    label: z.string().optional(),
    value: reactive(z.boolean().optional()),
  }),
  component: ({ props }) => {
    const field = useField(props.name, props.value)
    return (
      <label className="flex min-w-0 cursor-pointer items-center justify-between gap-3 pointer-coarse:min-h-11">
        <span className={BODY}>{props.label ?? props.name}</span>
        <UiSwitch checked={field.value === true} onCheckedChange={(checked) => field.set(checked === true)} />
      </label>
    )
  },
})

const Slider = defineComponent({
  name: "Slider",
  description: "A number picked from a range — for a threshold or a limit.",
  props: z.object({
    name: z.string(),
    min: z.number(),
    max: z.number(),
    step: z.number().optional(),
    value: reactive(z.number().optional()),
  }),
  component: ({ props }) => {
    const field = useField(props.name, props.value)
    const value = typeof field.value === "number" ? field.value : props.min
    return (
      <div className="flex min-w-0 items-center gap-3">
        <UiSlider
          className="min-w-0 flex-1"
          aria-label={props.name}
          min={props.min}
          max={props.max}
          step={props.step}
          value={[value]}
          onValueChange={(next) => field.set(Array.isArray(next) ? next[0] : next)}
        />
        <span className={cn(META, "w-9 shrink-0 text-end tabular-nums")}>{value}</span>
      </div>
    )
  },
})

/* ── A date, or a span of them ──
   The value is a string because a `$variable` is one: `YYYY-MM-DD` for a day,
   ISO 8601's own `start/end` for a range — which is also what the reader's
   message carries, so the model reads back the shape it wrote. A day is read
   at local noon, the same reason `tasks/fields.tsx` does: midnight floats a
   day across a timezone when it is drawn. */
const pad2 = (n: number) => String(n).padStart(2, "0")
const isoDay = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
function readDay(raw: string | undefined): Date | undefined {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) return undefined
  const day = new Date(`${raw.trim()}T12:00:00`)
  return Number.isNaN(day.getTime()) ? undefined : day
}
const DAY_LABEL: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" }

const DatePicker = defineComponent({
  name: "DatePicker",
  description:
    "A calendar for a day, or with `mode` \"range\" a span of days. Its value is `YYYY-MM-DD`, a range `YYYY-MM-DD/YYYY-MM-DD`.",
  props: z.object({
    name: z.string(),
    mode: z.enum(["single", "range"]).optional(),
    placeholder: z.string().optional(),
    rules: Rules.optional(),
    value: reactive(z.string().optional()),
  }),
  component: ({ props }) => {
    const field = useField(props.name, props.value, props.rules)
    const [open, setOpen] = useState(false)
    const range = props.mode === "range"
    const raw = field.value == null ? "" : String(field.value)
    const [fromRaw, toRaw] = raw.split("/")
    const from = readDay(fromRaw)
    const to = range ? readDay(toRaw) : undefined
    const label = !from
      ? (props.placeholder ?? (range ? "Pick dates" : "Pick a date"))
      : range && to && isoDay(to) !== isoDay(from)
        ? `${from.toLocaleDateString(undefined, DAY_LABEL)} – ${to.toLocaleDateString(undefined, DAY_LABEL)}`
        : from.toLocaleDateString(undefined, DAY_LABEL)
    const commit = (next: string) => {
      field.set(next)
      field.check(next)
    }
    return (
      <div className="min-w-0 space-y-1">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={
              <UiButton
                type="button"
                variant="outline"
                aria-label={props.name}
                aria-invalid={field.error ? true : undefined}
                className={cn("w-full min-w-0 justify-start font-normal pointer-coarse:h-11", !from && "text-muted-foreground")}
              />
            }
          >
            <CalendarIcon aria-hidden className="text-muted-foreground" />
            <span className="truncate">{label}</span>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-auto p-0">
            {range ? (
              <Calendar
                mode="range"
                selected={from ? { from, to } : undefined}
                defaultMonth={from}
                /* Stays open: a span is two clicks, and closing on the first
                   would leave a range nobody finished picking. */
                onSelect={(next) => commit(next?.from ? `${isoDay(next.from)}/${isoDay(next.to ?? next.from)}` : "")}
              />
            ) : (
              <Calendar
                mode="single"
                selected={from}
                defaultMonth={from}
                onSelect={(day) => {
                  if (!day) return
                  commit(isoDay(day))
                  setOpen(false)
                }}
              />
            )}
            {from && (
              <div className="border-t border-rule p-1">
                <UiButton
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start text-muted-foreground"
                  onClick={() => {
                    commit("")
                    setOpen(false)
                  }}
                >
                  <X aria-hidden /> Clear
                </UiButton>
              </div>
            )}
          </PopoverContent>
        </Popover>
        <FieldError>{field.error}</FieldError>
      </div>
    )
  },
})

export { Button, Checkbox, DatePicker, Form, FormControl, Input, RadioGroup, Select, SelectItem, Slider, Switch, Textarea, useField }
