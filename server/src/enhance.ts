import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { HttpError } from "./http-error.js";
import type { Profile } from "./profiles.js";

/* ── Prompt enhancer ──
 *
 * Rewrites the composer's draft into a sharper prompt for a coding agent, using
 * the AI SDK against the chosen profile's own OpenAI-compatible endpoint. The
 * one place the SDK is named on this half of the harness (see `server/src/acp.ts`
 * for the ACP equivalent) — routes call `enhancePrompt`, never the SDK.
 *
 * Deliberately NOT a turn on a thread's agent: a turn would journal into the
 * conversation, touch queue/turn state, and cost a full agent run for a button.
 * This is one side-effect-free chat completion, and the profile's key never
 * leaves this process (the client only ever sees `hasApiKey`).
 */

const ENHANCE_PROVIDER_KEY = "daedalus-enhance";

/** A rewrite is one short answer, not a document — cap the output. */
const MAX_OUTPUT_TOKENS = 2_048;

/** Long enough for a cold gateway, short enough that a wedged one does not
    hold the composer open. `claude -p /usage` measures ~2.3s; a rewrite is one
    model call of the same shape. */
const ENHANCE_TIMEOUT_MS = 60_000;

/** Past this the draft is a document, not a prompt — refuse rather than bill a
    rewrite of something the user pasted wholesale. */
const MAX_INPUT_CHARS = 12_000;

const ENHANCE_SYSTEM = `Rewrite this draft into a clear, specific prompt for an AI coding agent. Keep the user's intent exactly — do not add new requirements, do not answer it, do not explain your changes. Prefer concrete verbs, file paths and constraints over vague asks; structure with short sections or bullets when the draft has more than one ask. Return only the rewritten prompt, no preamble.

Preserve verbatim, never reword: @file mentions, /slash commands, code fences, and [pasted text #n] tokens.`;

/**
 * The commit-message half, which is a different question from the prompt half
 * and therefore a different system prompt: a commit message describes work that
 * has already happened, in a house style, rather than instructing anyone.
 *
 * It is still one `enhancePrompt` call — the endpoint resolution, the timeout,
 * the key handling and the "not a turn on a thread" bargain are all identical,
 * and the only thing that actually differs is what the model is asked to write.
 */
const COMMIT_SYSTEM = `Write a commit message for the changes shown. Follow the conventional-commit style: a subject line of at most 72 characters ("feat: …", "fix: …", "refactor: …"), then a blank line and, only where the change needs it, a short body saying why rather than what.

Describe what the diff actually does — read it, do not invent work that is not there. The file list is a summary of the diff, not a substitute for reading it. Return only the commit message, no preamble and no code fences.`;

export interface EnhanceInput {
  text: string;
  /** Explicit model; falls back to the profile default, then its first model. */
  model?: string;
  signal?: AbortSignal;
  /** Which house style to write in. Defaults to the prompt rewrite. */
  kind?: "prompt" | "commit";
}

export async function enhancePrompt(profile: Profile, input: EnhanceInput): Promise<string> {
  const text = input.text.trim();
  if (!text) throw new HttpError("nothing to enhance", 400);
  if (text.length > MAX_INPUT_CHARS) {
    throw new HttpError(`prompt is too long to enhance (${text.length} of ${MAX_INPUT_CHARS} characters)`, 400);
  }
  /* The profile's SHARED base URL — the OpenAI-compatible endpoint the presets
     document as chat-completions shaped — never the per-agent override, which
     serves Claude Code at an Anthropic-messages path that would 404 a
     chat-completions call. A virtual Default carries no endpoint at all, so
     upstream is uncallable there. */
  const baseURL = (profile.baseUrl || "").trim();
  if (!baseURL) throw new HttpError("this profile has no endpoint to enhance with", 409);
  const modelId = input.model?.trim() || profile.defaultModel || profile.models[0]?.id || "";
  if (!modelId) throw new HttpError("this profile has no model to enhance with", 409);

  const provider = createOpenAICompatible({
    name: ENHANCE_PROVIDER_KEY,
    // Some local gateways require the header present while ignoring its value.
    baseURL,
    apiKey: profile.apiKey || "daedalus",
  });
  const timeout = AbortSignal.timeout(ENHANCE_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  let enhanced: string;
  try {
    const result = await generateText({
      model: provider.chatModel(modelId),
      system: input.kind === "commit" ? COMMIT_SYSTEM : ENHANCE_SYSTEM,
      prompt: text,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      abortSignal: signal,
    });
    enhanced = result.text.trim();
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError" && input.signal?.aborted) throw err;
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new HttpError("the enhance request timed out", 502);
    }
    throw new HttpError(err instanceof Error ? err.message : "the enhance request failed", 502);
  }
  if (!enhanced) throw new HttpError("the enhancer returned an empty rewrite", 502);
  return enhanced;
}
