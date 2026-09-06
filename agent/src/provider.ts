import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { AgentEnv } from "./env.js";

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
