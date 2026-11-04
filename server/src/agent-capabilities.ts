/**
 * What each runtime's last `initialize` answer said it can do — measured, kept
 * in memory, keyed by the agent row's id.
 *
 * One reader today: `resolveAgentSpawn`, deciding whether a thread's spawn
 * instructions go into the process **env** or wait for the handshake's
 * `systemPrompt` (`AgentDef.personaVia === "acp-system-prompt"`). Env is fixed
 * at spawn, before any `initialize` has answered, so the only honest reading a
 * spawn can take is the last one this runtime gave — never an assumption from
 * its id. Unknown (nothing of this runtime has answered since boot) reads as
 * "not advertised", which is the conservative half: the old door carries the
 * persona, exactly as it did before the capability existed.
 *
 * Recorded by every `AcpConnection` (a thread's process, a shared one, a
 * prewarmed one) and the probe's one-shot client, so a runtime's first
 * handshake after boot — the draft's probe, usually — is what informs the
 * thread's spawn.
 */
import type * as acp from "./acp.js";

const lastCapabilities = new Map<string, acp.AgentCapabilities>();

/** Remember what `agentId`'s runtime advertised. `null`/`undefined` is the
    SDK's default for an agent that said nothing: recorded as empty. */
export function recordAgentCapabilities(agentId: string, capabilities: acp.AgentCapabilities | null | undefined): void {
  lastCapabilities.set(agentId, capabilities ?? {});
}

/** The last `initialize` answer's capabilities for this runtime, or undefined
    when none has answered since boot. */
export function lastAgentCapabilities(agentId: string): acp.AgentCapabilities | undefined {
  return lastCapabilities.get(agentId);
}

/** Whether `sessionCapabilities.systemPrompt` was advertised. The schema says
    `{}` is "supported in `append` mode" and omitted/null is "not advertised",
    so presence is the whole test. */
export function systemPromptAdvertised(capabilities: acp.AgentCapabilities | null | undefined): boolean {
  const cap = capabilities?.sessionCapabilities?.systemPrompt;
  return cap !== null && cap !== undefined;
}

/** `systemPromptAdvertised` over the last measured answer for `agentId`;
    false when nothing has been measured yet. */
export function lastSystemPromptAdvertised(agentId: string): boolean {
  return systemPromptAdvertised(lastCapabilities.get(agentId));
}

/** Test seam: forget every measurement. */
export function resetAgentCapabilities(): void {
  lastCapabilities.clear();
}
