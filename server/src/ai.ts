/* ── The AI SDK, in one file ──
 *
 * Every model call the *harness itself* makes goes through here: the prompt
 * enhancer, the commit-message draft, the branch namer, and whatever is next.
 * They are all the same call — one side-effect-free chat completion against a
 * profile's own OpenAI-compatible endpoint — and they were on their way to
 * being three copies of the same forty lines of provider construction, timeout
 * arithmetic and error mapping, each with its own idea of what a timeout says
 * and whether an empty answer is a failure.
 *
 * This is the same rule the ACP SDK already lives under (`server/src/acp.ts`,
 * `agent/src/acp.ts`): **the SDK is named in one file per half**. Callers name
 * a profile, a system prompt and a prompt; they never see `ai` or
 * `@ai-sdk/openai-compatible`, so swapping the provider, adding a retry or
 * putting a budget on these calls is one file's edit.
 *
 * What it is deliberately NOT: a turn on a thread's agent. A turn journals into
 * the conversation, touches queue and turn state, and costs a full agent run
 * for what is a button. These calls are invisible to the transcript, and the
 * profile's API key never leaves this process — the client only ever sees
 * `hasApiKey`.
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";

import { HttpError } from "./http-error.js";
import type { Profile } from "./profiles.js";

const PROVIDER_KEY = "daedalus-harness";

/** These are all short answers, not documents. */
const MAX_OUTPUT_TOKENS = 2_048;

/** Long enough for a cold gateway, short enough that a wedged one does not hold
    a button open. `claude -p /usage` measures ~2.3s; these are one model call
    of the same shape. */
const TIMEOUT_MS = 60_000;

export interface ModelCall {
  /** The house style — what kind of answer this is. */
  system: string;
  prompt: string;
  /** Explicit model; falls back to the profile default, then its first model. */
  model?: string;
  signal?: AbortSignal;
  maxOutputTokens?: number;
  /** What this call is called in an error the user will read ("the … timed
      out"). The caller names it because only the caller knows what button was
      pressed. */
  label?: string;
}

/**
 * One completion, or an `HttpError` that says which half failed.
 *
 * The status codes matter to the surfaces that draw these: 409 is "this profile
 * cannot do it" (no endpoint, no model — a configuration answer the user can
 * act on), 502 is "upstream did not answer". A caller's own abort is re-thrown
 * as an abort, never dressed up as a failure, because a composer that moved on
 * should not raise an error about the request it cancelled.
 */
export async function generate(profile: Profile, call: ModelCall): Promise<string> {
  const label = call.label ?? "request";
  /* The profile's SHARED base URL — the OpenAI-compatible endpoint the presets
     document as chat-completions shaped — never the per-agent override, which
     serves Claude Code at an Anthropic-messages path that would 404 a
     chat-completions call. A virtual Default carries no endpoint at all, so
     upstream is uncallable there. */
  const baseURL = (profile.baseUrl || "").trim();
  if (!baseURL) throw new HttpError(`this profile has no endpoint for the ${label}`, 409);
  const modelId = call.model?.trim() || profile.defaultModel || profile.models[0]?.id || "";
  if (!modelId) throw new HttpError(`this profile has no model for the ${label}`, 409);

  const provider = createOpenAICompatible({
    name: PROVIDER_KEY,
    // Some local gateways require the header present while ignoring its value.
    baseURL,
    apiKey: profile.apiKey || "daedalus",
  });
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = call.signal ? AbortSignal.any([call.signal, timeout]) : timeout;

  let text: string;
  try {
    const result = await generateText({
      model: provider.chatModel(modelId),
      system: call.system,
      prompt: call.prompt,
      maxOutputTokens: call.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
      abortSignal: signal,
    });
    text = result.text.trim();
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError" && call.signal?.aborted) throw err;
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new HttpError(`the ${label} timed out`, 502);
    }
    throw new HttpError(err instanceof Error ? err.message : `the ${label} failed`, 502);
  }
  if (!text) throw new HttpError(`the ${label} came back empty`, 502);
  return text;
}
