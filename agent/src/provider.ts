import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { AgentEnv } from "./env.js";
import type { SharedV4ProviderOptions } from "@ai-sdk/provider";

export type ModelFactory = (env: AgentEnv, modelId: string) => LanguageModel;

/* `createOpenAICompatible` derives its providerOptions key from this name, and
   anything under that key that is not a known option is spread into the
   /chat/completions body verbatim. It is how this runtime reaches fields the
   AI SDK has no setting for — `prompt_cache_key` among them — so the name is
   named once, here, and read from `turn.ts` rather than typed twice. */
export const PROVIDER_OPTIONS_KEY = "daedalus";

/* OpenAI-compatible only, by design: every profile this agent is pointed at —
   a gateway, a router, OpenAI itself — serves /chat/completions. The API key
   falls back to a placeholder because some local gateways require the header
   to be present while ignoring its value. */
export const makeModel: ModelFactory = (env, modelId) =>
  createOpenAICompatible({
    name: PROVIDER_OPTIONS_KEY,
    baseURL: env.baseUrl ?? "https://api.openai.com/v1",
    apiKey: env.apiKey ?? "daedalus",
    includeUsage: true,
  }).chatModel(modelId);

/* A prefix cache lives on the machine that built it, so a router free to pick
   a different backend per request answers a warm prompt from a cold one. The
   key is the affinity hint that keeps a thread's steps together: OpenAI routes
   on it explicitly, and a gateway that has never heard of it ignores an
   unknown body field. The session id — stable across every step of every turn,
   distinct between threads that share a model — is exactly the grain the cache
   is built at. Env-gated for the strict upstream that rejects what it cannot
   parse rather than ignoring it. */
export function cacheAffinity(env: AgentEnv, sessionId: string): SharedV4ProviderOptions | undefined {
  if (!env.promptCacheKey) return undefined;
  return { [PROVIDER_OPTIONS_KEY]: { prompt_cache_key: sessionId } };
}
