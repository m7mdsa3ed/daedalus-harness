import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { AgentEnv } from "./env.js";

export type ModelFactory = (env: AgentEnv, modelId: string) => LanguageModel;

/* OpenAI-compatible only, by design: every profile this agent is pointed at —
   a gateway, a router, OpenAI itself — serves /chat/completions. The API key
   falls back to a placeholder because some local gateways require the header
   to be present while ignoring its value. */
export const makeModel: ModelFactory = (env, modelId) =>
  createOpenAICompatible({
    name: "daedalus",
    baseURL: env.baseUrl ?? "https://api.openai.com/v1",
    apiKey: env.apiKey ?? "daedalus",
    includeUsage: true,
  }).chatModel(modelId);
