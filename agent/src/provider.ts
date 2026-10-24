import { createAnthropic } from "@ai-sdk/anthropic";
import { getModelCapabilities } from "@ai-sdk/anthropic/internal";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { AgentEnv, Effort } from "./env.js";
import type { SharedV4ProviderOptions } from "@ai-sdk/provider";

export type ModelFactory = (env: AgentEnv, modelId: string) => LanguageModel;

/* `createOpenAICompatible` derives its providerOptions key from this name, and
   anything under that key that is not a known option is spread into the
   /chat/completions body verbatim. It is how this runtime reaches fields the
   AI SDK has no setting for — `prompt_cache_key` among them — so the name is
   named once, here, and read from `turn.ts` rather than typed twice. */
export const PROVIDER_OPTIONS_KEY = "daedalus";

/* Two wire protocols, chosen by the profile's per-agent link
   (`DAEDALUS_AGENT_PROTOCOL`): OpenAI-compatible /chat/completions — what a
   gateway, a router or OpenAI itself serves — and Anthropic /messages. The API
   key falls back to a placeholder because some local gateways require the
   header to be present while ignoring its value. */
export const makeModel: ModelFactory = (env, modelId) => {
  if (env.protocol === "anthropic") {
    return createAnthropic({
      baseURL: env.baseUrl ?? "https://api.anthropic.com/v1",
      apiKey: env.apiKey ?? "daedalus",
    })(modelId);
  }
  return createOpenAICompatible({
    name: PROVIDER_OPTIONS_KEY,
    baseURL: env.baseUrl ?? "https://api.openai.com/v1",
    apiKey: env.apiKey ?? "daedalus",
    includeUsage: true,
  }).chatModel(modelId);
};

/* A prefix cache lives on the machine that built it, so a router free to pick
   a different backend per request answers a warm prompt from a cold one. The
   key is the affinity hint that keeps a thread's steps together: OpenAI routes
   on it explicitly, and a gateway that has never heard of it ignores an
   unknown body field. The session id — stable across every step of every turn,
   distinct between threads that share a model — is exactly the grain the cache
   is built at. Env-gated for the strict upstream that rejects what it cannot
   parse rather than ignoring it. */
export function cacheAffinity(env: AgentEnv, sessionId: string): SharedV4ProviderOptions | undefined {
  // `prompt_cache_key` is an OpenAI body field; Anthropic's messages API has none.
  if (!env.promptCacheKey || env.protocol !== "openai") return undefined;
  return { [PROVIDER_OPTIONS_KEY]: { prompt_cache_key: sessionId } };
}

/* An adaptive-thinking Claude model (Opus 4.7 and newer) returns its thinking
   blocks with the text left out unless the request asks for `display`. The AI
   SDK asks for it only when it is given an effort, so a thread on "Default"
   effort drew a thought with nothing in it. This asks for the summary in that
   one case and leaves the effort to the model. The capability test is the
   SDK's own, so a model that cannot take adaptive thinking is sent nothing. */
function thinkingDisplay(env: AgentEnv, modelId: string, effort: Effort | null): SharedV4ProviderOptions | undefined {
  if (env.protocol !== "anthropic" || effort !== null) return undefined;
  if (!getModelCapabilities(modelId).supportsAdaptiveThinking) return undefined;
  return { anthropic: { thinking: { type: "adaptive", display: "summarized" } } };
}

/** The providerOptions of a model step: cache affinity and thinking display. */
export function stepOptions(
  env: AgentEnv,
  sessionId: string,
  modelId: string,
  effort: Effort | null,
): SharedV4ProviderOptions | undefined {
  const options = { ...cacheAffinity(env, sessionId), ...thinkingDisplay(env, modelId, effort) };
  return Object.keys(options).length > 0 ? options : undefined;
}
