import type { AutonomyItem } from "./store"

/*
 * How an auto-answered question is put into words — once, for the two surfaces
 * that say it: the transcript row and the markdown a pasted transcript carries.
 *
 * It exists as one function because the sentence is the whole feature. A row
 * reading "allow" beside a tool name is not an audit trail; "Allowed without
 * asking — the routine's policy permits commands" is. The vocabulary is the
 * harness's own and never the agent's: the optionId that carried the answer
 * belongs to one runtime and means nothing to a reader of another thread.
 */

/** The ACP tool kinds, as a person would say them. Protocol fields, not vendor
    tool names — this is the same union `toolKindOf` reads. A kind missing here
    is one the protocol grew, and falls back to the bare word. */
const KIND_PHRASE: Record<string, string> = {
  read: "read a file",
  edit: "edit a file",
  delete: "delete a file",
  move: "move a file",
  search: "search",
  execute: "run a command",
  think: "think",
  fetch: "fetch a page",
  switch_mode: "switch mode",
  other: "use a tool",
}

export interface AutonomyLine {
  /** The act, headline-style. */
  title: string
  /** Why it was answered that way — the part a bare verdict cannot say. */
  detail: string
  /** Whether this is the state a person should act on: nobody came. */
  attention: boolean
}

export function autonomyLine(item: AutonomyItem): AutonomyLine {
  const what =
    item.request === "elicitation"
      ? "a question"
      : item.toolKind
        ? `permission to ${KIND_PHRASE[item.toolKind] ?? item.toolKind}`
        : "permission"

  /* The timeout is a different sentence from every stance, and deliberately so:
     "the policy allowed this" and "nobody answered in time" are the two things
     a reader most needs told apart, and both end with the agent unblocked. */
  if (item.timedOut) {
    return {
      title: item.title ? `Nobody answered: ${item.title}` : "Nobody answered",
      detail: `The agent asked for ${what} and no one responded before the timeout, so the harness answered ${
        item.answer === "cancel" ? "by cancelling the call" : "no"
      }.`,
      attention: true,
    }
  }

  const verb =
    item.answer === "allow"
      ? "Allowed"
      : item.answer === "deny"
        ? "Denied"
        : item.answer === "decline"
          ? "Skipped"
          : "Cancelled"

  return {
    title: item.title ? `${verb} without asking: ${item.title}` : `${verb} without asking`,
    detail: `The agent asked for ${what}. This thread is running under an autonomy policy, which answered for you.`,
    attention: false,
  }
}
