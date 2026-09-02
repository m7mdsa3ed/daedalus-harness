/* ── Elicitation schema reading ──
   An ACP form elicitation carries a JSON Schema of primitive-typed properties.
   Two conventions ride its `_meta` and are quarantined here, the same way
   lib/tools.ts quarantines tool-call shapes:

     - `_askUserQuestionCustomAnswer` — deliberately unnamespaced, shared by the
       Claude and Codex AskUserQuestion bridges: marks a free-text field as the
       "Other" box for a sibling select field (`questionId` points at it). The
       pair renders as ONE question — options plus a type-your-own input — and
       a typed answer submits under the companion's key.
     - `_claude/askUserQuestionOption` — carries an option's `preview` (a
       mockup, a code snippet) that ACP's EnumOption has no slot for.

   Everything else renders from the schema alone: titled enums (`oneOf`), plain
   enums (`enum`), multi-select arrays (`items.anyOf`/`items.enum`), booleans,
   numbers, free text. */
import type * as acp from "@daedalus/acp"

const CUSTOM_ANSWER_META_KEY = "_askUserQuestionCustomAnswer"
const CLAUDE_OPTION_META_KEY = "_claude/askUserQuestionOption"

/* ── Which variant is this? ──
   A bare `mode === "form"` check is wrong, and that is the whole reason these
   exist: the union's custom/future variant is `{ mode: string; [k: string]:
   unknown }`, so it carries the same tag shape and would match. The payload is
   what actually separates them, so each guard checks the fields its variant is
   defined by — a malformed form matches nothing and falls through to the
   can't-render card rather than throwing halfway down the schema.

   These used to be the SDK's own `CreateElicitationRequest.isForm/.isUrl`. The
   SDK is a type-only dependency now (the server speaks ACP), and this is the
   only runtime value the client was using it for. */

export type FormElicitation = acp.ElicitationFormMode & { mode: "form"; message: string }
export type UrlElicitation = acp.ElicitationUrlMode & { mode: "url"; message: string }

export function isFormElicitation(
  request: acp.CreateElicitationRequest
): request is FormElicitation {
  if (request.mode !== "form") return false
  const schema = (request as { requestedSchema?: unknown }).requestedSchema
  return !!schema && typeof schema === "object"
}

export function isUrlElicitation(request: acp.CreateElicitationRequest): request is UrlElicitation {
  if (request.mode !== "url") return false
  const { url, elicitationId } = request as { url?: unknown; elicitationId?: unknown }
  return typeof url === "string" && typeof elicitationId === "string"
}

export interface ElicitationOption {
  value: string
  label: string
  description?: string
  /** Mockup/code shown with the option (Claude's AskUserQuestion previews). */
  preview?: string
}

export interface ElicitationField {
  key: string
  /** The companion free-text field's key — a typed answer submits there. */
  customKey?: string
  title?: string
  description?: string
  kind: "select" | "multiselect" | "text" | "number" | "boolean"
  options: ElicitationOption[]
  required: boolean
  defaultValue?: string
}

function metaRecord(meta: unknown): Record<string, unknown> {
  return meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {}
}

function optionOf(raw: acp.EnumOption): ElicitationOption {
  const claudeMeta = metaRecord(metaRecord(raw._meta)[CLAUDE_OPTION_META_KEY])
  return {
    value: raw.const,
    label: raw.title || raw.const,
    description: raw.description ?? undefined,
    preview: typeof claudeMeta.preview === "string" ? claudeMeta.preview : undefined,
  }
}

/** The companion marker, when this property is one: which field it belongs to. */
function customAnswerTarget(prop: acp.ElicitationPropertySchema): string | null {
  const marker = metaRecord(metaRecord((prop as { _meta?: unknown })._meta)[CUSTOM_ANSWER_META_KEY])
  return marker.isCustomAnswer === true && typeof marker.questionId === "string"
    ? marker.questionId
    : null
}

export function elicitationFields(schema: acp.ElicitationSchema): ElicitationField[] {
  const properties = Object.entries(schema.properties ?? {})
  const required = new Set(schema.required ?? [])

  // Companion "Other" boxes, keyed by the field they belong to. One per field:
  // the bridges emit exactly one, and a second would have nowhere to render.
  const customKeys = new Map<string, string>()
  for (const [key, prop] of properties) {
    const target = customAnswerTarget(prop)
    if (target && !customKeys.has(target)) customKeys.set(target, key)
  }

  const fields: ElicitationField[] = []
  for (const [key, prop] of properties) {
    // A companion renders inside its field — unless its target doesn't exist,
    // in which case it is just a text field like any other.
    const target = customAnswerTarget(prop)
    if (target && customKeys.get(target) === key && (schema.properties ?? {})[target]) continue

    /* The union's custom/future variant (`type: string` + index signature)
       defeats discriminant narrowing, so read through one loose view. */
    const p = prop as {
      type: string
      title?: string | null
      description?: string | null
      oneOf?: acp.EnumOption[] | null
      enum?: string[] | null
      items?: { anyOf?: acp.EnumOption[]; enum?: unknown } | null
      default?: unknown
    }
    const base = {
      key,
      customKey: customKeys.get(key),
      title: p.title ?? undefined,
      description: p.description ?? undefined,
      required: required.has(key),
    }
    if (p.type === "string") {
      const options =
        p.oneOf?.map(optionOf) ?? p.enum?.map((v) => ({ value: v, label: v })) ?? []
      fields.push({
        ...base,
        kind: options.length > 0 ? "select" : "text",
        options,
        defaultValue: typeof p.default === "string" ? p.default : undefined,
      })
    } else if (p.type === "array") {
      const options = Array.isArray(p.items?.anyOf)
        ? p.items.anyOf.map(optionOf)
        : Array.isArray(p.items?.enum)
          ? (p.items.enum as string[]).map((v) => ({ value: v, label: v }))
          : []
      // An array with no enumerable choices has nothing to render as checkboxes;
      // a text answer is better than no field at all.
      fields.push({ ...base, kind: options.length > 0 ? "multiselect" : "text", options })
    } else if (p.type === "boolean") {
      fields.push({
        ...base,
        kind: "boolean",
        options: [
          { value: "true", label: "Yes" },
          { value: "false", label: "No" },
        ],
        defaultValue: typeof p.default === "boolean" ? String(p.default) : undefined,
      })
    } else if (p.type === "number" || p.type === "integer") {
      fields.push({
        ...base,
        kind: "number",
        options: [],
        defaultValue: typeof p.default === "number" ? String(p.default) : undefined,
      })
    } else {
      fields.push({ ...base, kind: "text", options: [] })
    }
  }
  return fields
}

/**
 * Fold the submitted form back into elicitation content. The questionnaire
 * names every control after its field, and only the active answer control
 * carries the name — so a select field yields either a chosen option value or
 * typed free text, and the free text routes to the companion key (that is what
 * the AskUserQuestion bridges read a custom answer from).
 */
export function elicitationAnswers(
  fields: ElicitationField[],
  form: FormData
): Record<string, acp.ElicitationContentValue> {
  const content: Record<string, acp.ElicitationContentValue> = {}
  for (const field of fields) {
    const raw = form
      .getAll(field.key)
      .map((v) => String(v).trim())
      .filter((v) => v !== "")
    if (raw.length === 0) continue
    switch (field.kind) {
      case "select": {
        const value = raw[raw.length - 1]
        if (field.customKey && !field.options.some((o) => o.value === value)) {
          content[field.customKey] = value
        } else {
          content[field.key] = value
        }
        break
      }
      case "multiselect": {
        const known = new Set(field.options.map((o) => o.value))
        const picked = raw.filter((v) => known.has(v))
        const typed = raw.filter((v) => !known.has(v))
        if (picked.length > 0) content[field.key] = picked
        if (typed.length > 0) {
          if (field.customKey) content[field.customKey] = typed.join(", ")
          else content[field.key] = raw
        }
        break
      }
      case "number": {
        const value = Number(raw[0])
        if (Number.isFinite(value)) content[field.key] = value
        break
      }
      case "boolean":
        content[field.key] = raw[0] === "true"
        break
      default:
        content[field.key] = raw[0]
    }
  }
  return content
}
