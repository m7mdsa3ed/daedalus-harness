import { generateText } from "ai";
import type { AgentEnv } from "./env.js";
import type { CallMetering } from "./metering.js";
import type { ModelFactory } from "./provider.js";

const SYSTEM =
  "Write a title for a coding session from the user's first message: 3 to 7 words, sentence case, " +
  "no quotes, no trailing punctuation. Reply with the title only.";

/* The session's name from its first message, or null when the model says
   nothing usable — the caller keeps the first-line title. The small model, and
   the prompt's head only: this runs beside the turn, not in front of it. */
export async function generateTitle(
  env: AgentEnv,
  makeModel: ModelFactory,
  modelId: string,
  prompt: string,
  signal: AbortSignal,
  onCall?: (call: CallMetering) => void,
): Promise<string | null> {
  try {
    const { text } = await generateText({
      model: makeModel(env, env.smallModel || modelId),
      system: SYSTEM,
      prompt: prompt.slice(0, 1_000),
      maxOutputTokens: 64,
      maxRetries: 0,
      abortSignal: signal,
      onLanguageModelCallEnd: onCall,
    });
    const title = text.trim().split("\n")[0]!.replace(/^["'`]+|["'`.]+$/g, "").trim();
    const words = title.split(/\s+/);
    return words.length >= 3 && words.length <= 7 ? title.slice(0, 80) : null;
  } catch {
    return null; // ponytail: no title is a fine answer; the first-line one stands
  }
}
