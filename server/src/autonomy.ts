import type * as acp from "@agentclientprotocol/sdk";

/*
 * How a thread answers the agent for the user.
 *
 * The harness does NOT ask the agent to be autonomous. Every runtime spells
 * that differently — Claude Code has permission modes, codex has sandbox and
 * approval policies, opencode has its own — and all of them reach us only as
 * opaque `session/set_config_option` ids we must never enumerate, which is the
 * standing rule that the client hardcodes no per-agent knowledge. So the
 * harness answers instead, at the one place every ACP agent's question already
 * funnels through: `AcpBridge.park()`. That is a protocol-level choke point,
 * identical for every agent that will ever speak ACP, which is the entire
 * reason this works for all of them and needs no adapter for the next one.
 *
 * Setting the agent's own mode stays available and stays generic — it is an
 * ordinary `configChoices` entry picked from the agent's advertised selectors.
 * It is an optimisation (fewer round trips), never the mechanism.
 *
 * This module holds the policy type and the two pure selectors that read it, so
 * the bridge and whatever sets a policy (a routine run, an unattended scheduled
 * delivery) share one copy and neither has to import the other.
 */

/** What the harness answers with when the agent asks. `"ask"` is today's
    behaviour exactly: park the promise, tell the peers, wait for a human. */
export type Stance = "allow" | "deny" | "ask";

export interface AutonomyPolicy {
  /** Keyed by the ACP tool kind the request is about — a protocol field, the
      same one the client's own `toolKindOf` already reads, so keying on it
      hardcodes nothing about any agent. Deliberately not one verb for
      everything: "read whatever you like, ask before you run a command" is what
      almost every unattended run actually wants, and a blanket `allow` is the
      only alternative on offer if this is one setting. */
  permissions: { default: Stance } & Partial<Record<acp.ToolKind, Stance>>;
  /** `"decline"` is a real ACP answer (`{action:"decline"}`) that the bridges
      read as "the user skipped", after which the turn carries on; `"cancel"`
      aborts the tool call and is what a dying process already sends. Declining
      is the right one for an unattended run — it should continue and say so. */
  elicitations: "decline" | "ask";
  /** How long an `ask` waits for a human before `askFallback` answers it. A run
      that parks until its deadline is a run that dies half an hour later having
      done nothing and reported nothing; the fallback is what turns that into an
      answer the transcript can explain. Zero or less disables the timer, which
      is a park that waits forever — today's behaviour. */
  askTimeoutSeconds: number;
  askFallback: "deny" | "cancel";
  /** Wall-clock ceiling for the whole run. Armed on the SESSION, never on one
      prompt: a queue drain starts a second turn on the same run, and a deadline
      that reset with it would not be a deadline. Zero or less means none. */
  maxRunSeconds: number;
  /** Ceilings a later phase reads — a run spends more than wall-clock, and the
      failure you discover the next morning is the overnight routine that ate a
      five-hour plan window. Declared here because they are one policy the form
      edits together; nothing in Phase 1 enforces them. */
  maxRunTokens?: number;
  minQuotaPercent?: number;
}

/** The default for anything that has to name a policy, and what an ordinary
    thread has (none — an absent policy is this, without the timers). */
export const ASK_EVERYTHING: AutonomyPolicy = {
  permissions: { default: "ask" },
  elicitations: "ask",
  askTimeoutSeconds: 300,
  askFallback: "deny",
  maxRunSeconds: 30 * 60,
};

/** The stance for one request. An absent or unknown `kind` is the protocol
    saying nothing, which falls back to `default` — exactly how the client's
    `toolKindOf` already treats it, rather than inventing a meaning for silence. */
export function stanceFor(policy: AutonomyPolicy, kind: acp.ToolKind | null | undefined): Stance {
  const named = kind ? policy.permissions[kind] : undefined;
  return named ?? policy.permissions.default;
}

/**
 * The agent's OWN option for this stance, or null when it offered none.
 *
 * Nothing is invented and no vendor name is ever read — only ACP's `kind`, so
 * an agent that labels its buttons "Yes, and don't ask again" is understood
 * exactly as one that labels them "Approve". `allow_once` is preferred over
 * `allow_always` because an automated grant must not write a standing rule into
 * the agent's own config, where it would outlive the run that made it and apply
 * to the human threads afterwards.
 *
 * A null answer is not a failure: the caller falls through to a real park, and
 * the ask timeout is what eventually answers it. An agent that offers no
 * reject-shaped option cannot be told "no" in its own vocabulary, and inventing
 * one would mean sending an optionId it never advertised.
 */
export function optionFor(
  options: readonly acp.PermissionOption[] | undefined,
  stance: "allow" | "deny",
): acp.PermissionOption | null {
  const order: acp.PermissionOptionKind[] =
    stance === "allow" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const kind of order) {
    const hit = options?.find((o) => o.kind === kind);
    if (hit) return hit;
  }
  return null;
}
