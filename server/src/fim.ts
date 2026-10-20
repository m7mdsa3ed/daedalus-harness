import type { ModelDef } from "./db/index.js";
import { HttpError } from "./http-error.js";
import type { Profile } from "./profiles.js";

/* ── Fill-in-the-middle ──
 *
 * The completion lane's *call* (`docs/plans/fim-composer.md`): a
 * `kind: "completion"` model on a profile, asked with `prompt` + `suffix` and
 * answering with the text between them. Nothing here is a turn — no session, no
 * transcript, no permission, no journal — and nothing here reads an agent: a
 * FIM-only profile has no model any runtime could spawn on, which is a perfectly
 * good profile to keep.
 *
 * This file is the call and nothing else: the path, the body, the parse, and the
 * refusals that say a row cannot be called. Which profile and model answer it is
 * `side-models.ts` (`sideDefault("completion")`) — the choice belongs to the
 * install, not the device, and is shared with every other lane.
 */

/** The one wire this lane speaks. A host that wants another path (Mistral's
 *  `/v1/fim/completions`) is a second wire value, which is what the column is
 *  for — never a guess made here from the base URL. */
const WIRE = "openai-completions";

/** Keystroke-scale, so shorter than `ai.ts`'s 60s for a button: a ghost nobody
 *  will look at in fifteen seconds should be abandoned rather than held. */
const TIMEOUT_MS = 15_000;

/** The most one suggestion may cost. A completion is a gap, not an answer. */
const MAX_TOKENS = 256;

export interface FimCall {
  /** The completion model's id on this profile. Falls back to the profile's
      first completable one, so a hand call need not repeat it. */
  model?: string;
  /** What is before the gap. Required — there is nothing to complete without it. */
  prompt: string;
  /** A short recap of the thread the gap belongs to (`lib/thread/recap.ts`),
      put in front of the prompt so the model finishes it as a *reply* and not
      only as a line. A FIM call has one channel — the text — so this is that
      channel's preamble, capped by the route. */
  context?: string;
  /** What is after the gap. Absent means the caret is at the end. */
  suffix?: string;
  maxTokens?: number;
  /** Stop sequences. Defaults to a newline: a lane that finishes a shell
      command wants one line, and prose passes its own. */
  stop?: string[];
  signal?: AbortSignal;
}

export interface FimResult {
  /** Exactly the gap the provider returned, verbatim — not trimmed. Leading
      whitespace is part of a completion ("git" → " status"), so the caller that
      wants a line trims it, and the one inserting mid-word does not. Empty is a
      legitimate answer: nothing to add is not a failure. */
  text: string;
  model: string;
}

/** The first choice, in either envelope — see the parse in `fillMiddle`. */
interface CompletionChoice {
  text?: unknown;
  message?: { content?: unknown };
}

/** A profile's completions endpoint. One path, one try — see `WIRE`. */
function completionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/completions`;
}

/**
 * One completion, or an `HttpError` that says which half failed.
 *
 * The status codes follow `ai.ts`: 400 for a request this lane cannot make (a
 * chat model, a model with no wire, nothing to complete), 409 for "this profile
 * cannot answer" (no endpoint, no model), 502 for what the provider did. A
 * caller's own abort is re-thrown as an abort, because a composer that moved on
 * should not raise an error about the request it cancelled.
 */
export async function fillMiddle(profile: Profile, call: FimCall): Promise<FimResult> {
  const baseUrl = (profile.baseUrl ?? "").trim();
  if (!baseUrl) throw new HttpError("this profile has no endpoint to complete against", 409);

  const modelId =
    call.model?.trim() || profile.models.find((m) => m.kind === "completion" && m.wire === WIRE)?.id || "";
  if (!modelId) throw new HttpError("this profile has no completion model", 409);

  const entry: ModelDef | undefined = profile.models.find((model) => model.id === modelId);
  if (!entry) throw new HttpError(`this profile has no model "${modelId}"`, 409);
  if ((entry.kind ?? "chat") !== "completion") {
    throw new HttpError(`"${modelId}" is a chat model — this lane needs kind: "completion"`, 400);
  }
  if (entry.wire !== WIRE) {
    throw new HttpError(`"${modelId}" has no ${WIRE} wire, so nothing here can call it`, 400);
  }
  if (!call.prompt.trim()) throw new HttpError("there is nothing to complete", 400);

  /* The recap goes first, the text either side of the caret last: a FIM model
     completes from the end of what it was given, so the last thing it reads has
     to be the line being written. */
  const prompt = call.context?.trim() ? `${call.context.trim()}\n\n${call.prompt}` : call.prompt;
  const maxTokens = Math.min(Math.max(1, Math.round(call.maxTokens ?? 64)), MAX_TOKENS);
  const stop = call.stop ?? ["\n"];
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = call.signal ? AbortSignal.any([call.signal, timeout]) : timeout;

  let res: Response;
  try {
    res = await fetch(completionsUrl(baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(profile.apiKey ? { authorization: `Bearer ${profile.apiKey}` } : {}),
        /* A profile's own headers win, last, because that is what they are for. */
        ...Object.fromEntries((profile.headers ?? []).map((h) => [h.name, h.value])),
      },
      body: JSON.stringify({
        model: modelId,
        prompt,
        ...(call.suffix ? { suffix: call.suffix } : {}),
        max_tokens: maxTokens,
        ...(stop.length ? { stop } : {}),
        temperature: 0.2,
      }),
      signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError" && call.signal?.aborted) throw err;
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new HttpError("the completion timed out", 502);
    }
    throw new HttpError(err instanceof Error ? err.message : "the completion failed", 502);
  }

  if (!res.ok) {
    /* The provider answered and the answer was "no": its words are the error,
       the same split `provider-models.ts` and `mcp-check.ts` make. */
    const detail = (await res.text().catch(() => "")).trim().slice(0, 600);
    throw new HttpError(`${res.status}${detail ? `: ${detail}` : ""}`, 502);
  }

  const body = (await res.json().catch(() => null)) as { choices?: CompletionChoice[] } | null;
  const choice = body?.choices?.[0];
  if (!body || !Array.isArray(body.choices) || !choice) {
    throw new HttpError("the completion came back unreadable", 502);
  }
  /* Two spellings of "the text of the first choice", and both are live: the
     legacy completions envelope (`choices[0].text`, which DeepSeek's FIM
     answers) and the chat one Mistral's `/v1/fim/completions` answers in
     (`choices[0].message.content`). The *request* is one wire; the envelope a
     vendor writes its answer in is the vendor's. Reading only `text` made every
     Mistral completion an empty string — a silent nothing, which is the worst
     way for a wrong assumption to fail. */
  const text = typeof choice.text === "string" ? choice.text : choice.message?.content;
  if (typeof text !== "string") throw new HttpError("the completion came back unreadable", 502);
  return { text, model: modelId };
}
