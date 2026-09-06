/* ── Reading the agent's session settings ──
   ACP hands the client one flat list of `configOptions` plus, on older agents, a
   separate `modes` state. Which of those is "the model", which is "how hard to
   think", and which is some agent's own switch is answered by `category` — a
   field the spec reserves for exactly this and then hedges: it is "UX only", it
   "MUST NOT be required for correctness", and clients "MUST handle missing or
   unknown categories gracefully".

   So this is a partition, not a lookup table. The two selectors we can place
   confidently get promoted into the Session group; everything else — including
   every category we have never heard of — falls through to the generic list and
   is rendered from the schema. Nothing is ever dropped: an option that matches
   no rule still reaches the user.

   Model and effort are the agent's business now. The profile catalog in
   settings only says how a thread *starts*; once it is running, these are what
   the menus read. */
import type * as acp from "@daedalus/acp"

export interface SessionOptions {
  /** The agent's model selector, if it advertises one. */
  model?: acp.SessionConfigOption
  /** The agent's reasoning-effort selector, if it advertises one. */
  effort?: acp.SessionConfigOption
  /** Everything else, in the order the agent sent it. */
  rest: acp.SessionConfigOption[]
}

const isSelect = (option: acp.SessionConfigOption) => option.type === "select"

/**
 * Split the agent's config options into the ones with a home in the Session
 * group and the ones that stay generic.
 *
 * Only the first selector of each category is promoted: an agent that sends two
 * model selectors gets one in the Session group and the other under Agent
 * options, which beats silently hiding it.
 */
export function partitionSessionOptions(
  options: acp.SessionConfigOption[],
  /** Mode ids from the legacy `modes` channel, so its config-option twin can be
      folded away rather than shown twice — see `isModeTwin`. */
  modeIds?: ReadonlySet<string>
): SessionOptions {
  const result: SessionOptions = { rest: [] }
  for (const option of options) {
    if (!result.model && option.category === "model" && isSelect(option)) {
      result.model = option
    } else if (!result.effort && option.category === "thought_level" && isSelect(option)) {
      result.effort = option
    } else if (!isModeTwin(option, modeIds)) {
      result.rest.push(option)
    }
  }
  return result
}

/**
 * Is this option the same knob as the session's permission mode?
 *
 * Agents may advertise the mode twice — once as `modes`, once as a select config
 * option — and claude-agent-acp does exactly that. `category: "mode"` says so
 * outright; for agents that omit the category, an identical value set is the
 * only signal, and two selectors offering the same choices are the same knob.
 */
export function isModeTwin(
  option: acp.SessionConfigOption,
  modeIds: ReadonlySet<string> | undefined
): boolean {
  if (!modeIds || modeIds.size === 0 || option.type !== "select") return false
  if (option.category === "mode") return true
  const values = flattenSelectOptions(option.options).map((choice) => choice.value)
  return values.length === modeIds.size && values.every((value) => modeIds.has(value))
}

/** Select options may arrive grouped; the menus render one flat list. */
export function flattenSelectOptions(options: acp.SessionConfigSelectOptions) {
  return options.flatMap((entry) => ("options" in entry ? entry.options : [entry]))
}

/** The label to show for a selector's current value, falling back to the raw
    value when the agent offers a choice it did not describe. */
export function currentChoiceLabel(option: acp.SessionConfigOption): string {
  if (option.type !== "select") return option.currentValue ? "On" : "Off"
  const choice = flattenSelectOptions(option.options).find((c) => c.value === option.currentValue)
  return choice?.name ?? option.currentValue
}
