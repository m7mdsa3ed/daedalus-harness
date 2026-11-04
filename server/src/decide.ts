import { HttpError } from "./http-error.js";
import type { Profile } from "./profiles.js";

/* ── Decisions: System One ──
 *
 * The decision lane's *call* (`docs/plans/model-kinds.md`,
 * `docs/plans/persona-decision.md`): a `kind: "decision"` model on a profile,
 * asked a state and a map of typed questions, answering with a probability per
 * label and generating no text. Nothing here is a turn — no session, no
 * transcript, no journal. Which profile and model answer is `side-models.ts`.
 *
 * Nothing outside this file spells a vendor's path or payload, as `fim.ts` does
 * for the completion lane.
 */

export type DecisionWire = "systemone" | "systemone-gateway";

const TIMEOUT_MS = 5_000;

export interface DecisionQuestion {
  type: "noul" | "choice" | "score";
  instructions: string;
  criteria?: string[] | Record<string, string>;
}

/** One question's answer, whatever envelope it arrived in. */
export interface DecisionAnswer {
  /** noul: the probability the statement holds. */
  probability?: number;
  /** choice: a probability per label. */
  choice?: Record<string, number>;
  /** score: a continuous reading. */
  score?: number;
  confidence?: number;
}

export interface DecisionCall {
  model: string;
  /** What is being decided about. Text, or JSON the model reads as structure. */
  state: unknown;
  questions: Record<string, DecisionQuestion>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface DecisionResult {
  answers: Record<string, DecisionAnswer>;
  /** What actually answered, which an alias (`jev-latest`) does not promise to be the model asked for. */
  model: string;
}

/**
 * Where a wire lives. The path is the `wire` column, never a guess from the
 * host (a gateway in the URL says nothing about which of the two it speaks), but
 * the *root* is: a base already ending in `/v1` takes the tail alone, any other
 * gets the version — `https://api.typesafe.ai` and `http://localhost:20128/v1`
 * are both real profiles, and appending `/v1/systemone` to the second doubles it.
 */
export function decisionUrl(baseUrl: string, wire: DecisionWire): string {
  const root = baseUrl.trim().replace(/\/+$/, "");
  const tail = wire === "systemone" ? "systemone" : "decisions";
  return /\/v\d+$/.test(root) ? `${root}/${tail}` : `${root}/v1/${tail}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const probability = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

function readAnswer(raw: unknown): DecisionAnswer | null {
  if (!isRecord(raw)) return null;
  const out: DecisionAnswer = {};
  // `noul` is the probability itself on both envelopes.
  const noul = probability(raw.noul) ?? probability(raw.probability);
  if (noul !== undefined) out.probability = noul;
  /* The distribution is `choice` on the documented envelope; the gateway (measured
     2026-11-03) puts the winning label in `choice` and the distribution in
     `probabilities`. */
  const dist = isRecord(raw.choice) ? raw.choice : isRecord(raw.probabilities) ? raw.probabilities : null;
  if (dist) {
    const labels: Record<string, number> = {};
    for (const [label, p] of Object.entries(dist)) {
      const n = probability(p);
      if (n !== undefined) labels[label] = n;
    }
    if (Object.keys(labels).length) out.choice = labels;
  }
  const score = probability(raw.score);
  if (score !== undefined) out.score = score;
  const confidence = probability(raw.confidence);
  if (confidence !== undefined) out.confidence = confidence;
  return Object.keys(out).length ? out : null;
}

/**
 * The two envelopes both live: the hosted API and Kev put each question's block
 * at the top level beside `model`; the 9router gateway measured on this install
 * wraps them in `answers`. An `answers` object wins when present.
 */
export function readDecision(body: unknown, asked: string[], fallbackModel: string): DecisionResult {
  if (!isRecord(body)) throw new HttpError("the decision came back unreadable", 502);
  const source = isRecord(body.answers) ? body.answers : body;
  const answers: Record<string, DecisionAnswer> = {};
  for (const name of asked) {
    const answer = readAnswer(source[name]);
    if (answer) answers[name] = answer;
  }
  if (!Object.keys(answers).length) throw new HttpError("the decision came back unreadable", 502);
  return { answers, model: typeof body.model === "string" && body.model ? body.model : fallbackModel };
}

/**
 * One decision, or an `HttpError` that says which half failed: 400 for a request
 * this lane cannot make, 409 for "this profile cannot answer", 502 for what the
 * provider did. A caller's own abort is re-thrown as an abort.
 */
export async function decide(profile: Profile, call: DecisionCall): Promise<DecisionResult> {
  const baseUrl = (profile.baseUrl ?? "").trim();
  if (!baseUrl) throw new HttpError("this profile has no endpoint to decide against", 409);

  const entry = profile.models.find((model) => model.id === call.model);
  if (!entry) throw new HttpError(`this profile has no model "${call.model}"`, 409);
  if ((entry.kind ?? "chat") !== "decision") {
    throw new HttpError(`"${call.model}" is a chat model — this lane needs kind: "decision"`, 400);
  }
  if (entry.wire !== "systemone" && entry.wire !== "systemone-gateway") {
    throw new HttpError(`"${call.model}" has no systemone wire, so nothing here can call it`, 400);
  }
  const asked = Object.keys(call.questions);
  if (!asked.length) throw new HttpError("there is nothing to decide", 400);
  if (call.state === undefined || call.state === null || call.state === "") {
    throw new HttpError("there is no state to decide about", 400);
  }

  const timeout = AbortSignal.timeout(call.timeoutMs ?? TIMEOUT_MS);
  const signal = call.signal ? AbortSignal.any([call.signal, timeout]) : timeout;

  let res: Response;
  try {
    res = await fetch(decisionUrl(baseUrl, entry.wire), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(profile.apiKey ? { authorization: `Bearer ${profile.apiKey}` } : {}),
        /* A profile's own headers win, last, because that is what they are for. */
        ...Object.fromEntries((profile.headers ?? []).map((h) => [h.name, h.value])),
      },
      body: JSON.stringify({ model: call.model, state: call.state, questions: call.questions }),
      signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError" && call.signal?.aborted) throw err;
    if (err instanceof Error && err.name === "TimeoutError") throw new HttpError("the decision timed out", 502);
    throw new HttpError(err instanceof Error ? err.message : "the decision failed", 502);
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).trim().slice(0, 600);
    throw new HttpError(`${res.status}${detail ? `: ${detail}` : ""}`, 502);
  }
  return readDecision(await res.json().catch(() => null), asked, call.model);
}
