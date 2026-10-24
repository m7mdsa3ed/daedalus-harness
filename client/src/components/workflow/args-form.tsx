/* A form generated from a saved workflow's `meta.inputs` — a JSON Schema for
   its `args`. Deliberately the small honest subset: an object of scalar
   properties (string, number/integer, boolean, enum), `required`, `default`,
   `description`, `title`. Anything the subset cannot draw (nested objects,
   arrays, oneOf…) falls to one JSON field for that property, and a schema that
   is not an object at all is one JSON field for the whole of `args`. The form
   never validates beyond "required is filled and JSON parses" — the server
   owns the schema check and its refusal is shown as the answer it is. */
import * as React from "react"

import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { Field } from "@/components/settings/primitives"

type Schema = Record<string, unknown>

type Kind = "string" | "number" | "integer" | "boolean" | "enum" | "json"

interface FieldSpec {
  name: string
  kind: Kind
  label: string
  hint?: string
  required: boolean
  options?: string[]
  initial: string | boolean
}

const asSchema = (value: unknown): Schema | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Schema) : null

function specOf(name: string, raw: unknown, required: boolean): FieldSpec {
  const schema = asSchema(raw) ?? {}
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type
  const enumValues = Array.isArray(schema.enum) ? schema.enum.filter((v) => typeof v === "string") : []
  const kind: Kind =
    enumValues.length > 0 && enumValues.length === (schema.enum as unknown[]).length
      ? "enum"
      : type === "string" || type === "number" || type === "integer" || type === "boolean"
        ? type
        : "json"
  const def = schema.default
  return {
    name,
    kind,
    label: typeof schema.title === "string" ? schema.title : name,
    hint: typeof schema.description === "string" ? schema.description : undefined,
    required,
    options: kind === "enum" ? (enumValues as string[]) : undefined,
    initial:
      kind === "boolean"
        ? def === true
        : def === undefined
          ? ""
          : typeof def === "string" || typeof def === "number"
            ? String(def)
            : JSON.stringify(def),
  }
}

/** The fields of a schema; null when it is not an object with properties, which
    the dialog draws as a single JSON box for the whole value. */
export function fieldsOf(inputs: Schema | null): FieldSpec[] | null {
  const props = asSchema(inputs?.properties)
  if (!props || Object.keys(props).length === 0) return null
  const required = new Set(Array.isArray(inputs?.required) ? (inputs.required as string[]) : [])
  return Object.entries(props).map(([name, schema]) => specOf(name, schema, required.has(name)))
}

export type ArgsDraft = Record<string, string | boolean>

export const draftOf = (fields: FieldSpec[] | null): ArgsDraft =>
  fields ? Object.fromEntries(fields.map((f) => [f.name, f.initial])) : { "": "" }

/** The `args` a draft stands for, or the sentence for what is wrong with it. */
export function argsOf(
  fields: FieldSpec[] | null,
  draft: ArgsDraft
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (!fields) {
    const raw = String(draft[""] ?? "").trim()
    if (!raw) return { ok: true, value: undefined }
    try {
      return { ok: true, value: JSON.parse(raw) }
    } catch {
      return { ok: false, error: "The arguments are not valid JSON." }
    }
  }
  const out: Record<string, unknown> = {}
  for (const f of fields) {
    const v = draft[f.name]
    if (f.kind === "boolean") {
      out[f.name] = v === true
      continue
    }
    const text = String(v ?? "")
    if (text.trim() === "") {
      if (f.required) return { ok: false, error: `“${f.label}” is required.` }
      continue
    }
    if (f.kind === "number" || f.kind === "integer") {
      const n = Number(text)
      if (!Number.isFinite(n) || (f.kind === "integer" && !Number.isInteger(n)))
        return { ok: false, error: `“${f.label}” must be ${f.kind === "integer" ? "a whole number" : "a number"}.` }
      out[f.name] = n
    } else if (f.kind === "json") {
      try {
        out[f.name] = JSON.parse(text)
      } catch {
        return { ok: false, error: `“${f.label}” is not valid JSON.` }
      }
    } else out[f.name] = text
  }
  return { ok: true, value: out }
}

export function ArgsForm({
  fields,
  draft,
  onChange,
}: {
  fields: FieldSpec[] | null
  draft: ArgsDraft
  onChange: (draft: ArgsDraft) => void
}) {
  const id = React.useId()
  const set = (name: string, value: string | boolean) => onChange({ ...draft, [name]: value })
  if (!fields)
    return (
      <Field label="Arguments" hint="JSON, passed to the workflow as its args. Leave empty for none." htmlFor={`${id}-args`}>
        <Textarea
          id={`${id}-args`}
          value={String(draft[""] ?? "")}
          onChange={(e) => set("", e.target.value)}
          spellCheck={false}
          className="font-mono text-xs"
          placeholder="{}"
        />
      </Field>
    )
  return (
    <div className="flex flex-col gap-4">
      {fields.map((f) => {
        const fid = `${id}-${f.name}`
        const label = f.required ? `${f.label} *` : f.label
        if (f.kind === "boolean")
          return (
            <label key={f.name} htmlFor={fid} className="flex items-start gap-2 text-sm">
              <Checkbox
                id={fid}
                checked={draft[f.name] === true}
                onCheckedChange={(checked) => set(f.name, checked === true)}
                className="mt-0.5"
              />
              <span className="min-w-0">
                <span className="font-medium">{label}</span>
                {f.hint && <span className="block text-muted-foreground">{f.hint}</span>}
              </span>
            </label>
          )
        return (
          <Field key={f.name} label={label} hint={f.hint} htmlFor={fid}>
            {f.kind === "enum" ? (
              <Select
                value={String(draft[f.name] ?? "") || undefined}
                onValueChange={(value) => value !== null && set(f.name, value)}
              >
                <SelectTrigger id={fid} className="w-full">
                  <SelectValue>{String(draft[f.name] ?? "") || "Pick one"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {f.options!.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : f.kind === "json" ? (
              <Textarea
                id={fid}
                value={String(draft[f.name] ?? "")}
                onChange={(e) => set(f.name, e.target.value)}
                spellCheck={false}
                className="font-mono text-xs"
                placeholder="JSON"
              />
            ) : (
              <Input
                id={fid}
                type={f.kind === "string" ? "text" : "number"}
                step={f.kind === "integer" ? 1 : "any"}
                value={String(draft[f.name] ?? "")}
                onChange={(e) => set(f.name, e.target.value)}
              />
            )}
          </Field>
        )
      })}
    </div>
  )
}
