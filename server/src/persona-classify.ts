/* ── Which persona answers a new thread's first message ──
 *
 * One question, asked once: the create route (`POST /api/sessions`) calls this
 * before `sessions.create`, because a draft has no row and no agent yet and a
 * persona picked here is a spawn input, not a respawn. Later messages never
 * classify — a follow-up is not a new question.
 *
 * It is a classification with a closed label set, so it is asked of the
 * install's **decision model** (`side-models.ts`, `decide.ts`), not a chat model: one call, a probability per persona, no generation to parse. With no
 * decision model chosen there is no call at all — never a fallback to a chat
 * generation (`docs/plans/persona-decision.md`).
 *
 * Failure is not an error path: a timeout, a refusal (the free tier answers
 * 429), garbage, or a pick that is not clearly ahead all answer `null`, and the
 * thread opens on the persona the draft already had. Never a guess — the same
 * rule a peak schedule follows for a sentence it cannot read.
 */
import { decide, type DecisionQuestion } from "./decide.js";
import { HttpError } from "./http-error.js";
import type { Profile } from "./profiles.js";
import { PERSONA_DECISION_DEFAULTS, sideTarget, type PersonaDecisionThresholds } from "./side-models.js";

export interface PersonaChoice {
  id: string;
  name: string;
  description: string;
}

/** Long enough for a warm decision model, short enough that a first send never
    waits on it noticeably. Unmeasured against a real gateway — see the plan. */
export const CLASSIFY_TIMEOUT_MS = 2_500;
/** The classifier reads this much; the agent still gets the whole message. */
const MAX_TEXT = 2_000;

/** Why a first message is not worth asking about, or null when it is: a shell
    line, a slash command, a message that is only mentions, or one too short to
    say what it is about. Said by name, because three causes in one sentence tell
    the reader none of them. */
export function unworthyReason(text: string): string | null {
  const t = text.trim();
  if (t.startsWith("!")) return "it is a shell command";
  if (t.startsWith("/")) return "it is a slash command";
  if (!t.replace(/@\S+/g, "").trim()) return "it is only mentions";
  if (t.length < 12) return "the message is too short";
  return null;
}

export const worthClassifying = (text: string): boolean => unworthyReason(text) === null;

/** Why a first message was not sent to the model, and whether the reader needs
    to hear it. A switch they turned off and a persona they picked by hand are
    their own doing and stay quiet; everything else is a classification that did
    not run and the thread says so, because a silent skip is indistinguishable
    from a feature that does not work. */
export interface GateSkip {
  reason: string;
  silent: boolean;
}

/** Everything that decides whether the model is asked at all, read before the
    persona library is: null means ask. The global switch is a kill switch: off,
    no project can turn it back on. The hand-pick guard is the draft still
    carrying the project's default — a persona the reader chose is never moved.
    Which model answers is not decided here: the decision lane's, or nothing. */
export function classifyGate(args: {
  text: string | null | undefined;
  globalSwitch: boolean | undefined;
  projectSwitch: boolean | undefined;
  draftPersonaId: string | null | undefined;
  projectPersonaId: string | null | undefined;
}): GateSkip | null {
  if (!args.text) return { reason: "no first message", silent: true };
  if (args.globalSwitch === false || args.projectSwitch === false) {
    return { reason: "turned off", silent: true };
  }
  if ((args.draftPersonaId || null) !== (args.projectPersonaId || null)) {
    return { reason: "persona picked by hand", silent: true };
  }
  const why = unworthyReason(args.text);
  return why ? { reason: why, silent: false } : null;
}

/** The decision lane's (profile, model), or null when none is chosen or it
    cannot be reached — `sideTarget` refuses with an `HttpError`, and "no
    decision model" is the ordinary state of an install, not a failure. */
export async function personaLane(): Promise<{ profile: Profile; model: string } | null> {
  try {
    return await sideTarget("decision", {});
  } catch (err) {
    if (err instanceof HttpError) return null;
    throw err;
  }
}

/** A `choice` answer is a distribution over the labels it was given and sums
    to one, so it cannot say "nothing fits" — with personas as the only labels, a
    single candidate would score 1.0 on every message. The escape is a label. */
export const NONE_LABEL = "none";
export const QUESTION_NAME = "persona";

/** The question, whose `criteria` is the library itself: adding a persona
    teaches the classifier, with no taxonomy kept anywhere else. */
export function personaQuestion(personas: readonly PersonaChoice[]): DecisionQuestion {
  const criteria: Record<string, string> = { [NONE_LABEL]: "A general request, or no persona clearly fits" };
  for (const p of personas) {
    if (p.id === NONE_LABEL) continue;
    criteria[p.id] = p.description ? `${p.name} — ${p.description}` : p.name;
  }
  return {
    type: "choice",
    instructions: "Which of these personas should answer this message? Pick none when it is general or none clearly fits.",
    criteria,
  };
}

/** What the decision is about: the project and the message, capped. */
export function personaState(projectName: string, text: string): string {
  return `Project: ${projectName}\n\n${text.trim().slice(0, MAX_TEXT)}`;
}

const pct = (p: number) => `${Math.round(p * 100)}%`;

/** What a classification came to: a persona, or the reason there is none. The
    reason is the reader's — it goes into the thread as a line. */
export type PersonaOutcome =
  | { picked: string; probability: number; model: string; reason: string }
  | { picked: null; reason: string };

/**
 * Reads a distribution. The top label must be a persona in the library, clear
 * `minProbability`, and lead the runner-up by `margin` — "is it sure" and "is it
 * sure of *this* one" are different questions, and a near tie is the pick that
 * costs most to get wrong. `none` and an unknown label are no pick, and each
 * says which it was.
 */
export function judgeChoice(
  choice: Record<string, number> | undefined,
  personas: readonly PersonaChoice[],
  model: string,
  thresholds: PersonaDecisionThresholds = PERSONA_DECISION_DEFAULTS,
): PersonaOutcome {
  const name = (id: string) => personas.find((p) => p.id === id)?.name ?? id;
  const ranked = Object.entries(choice ?? {}).sort((a, b) => b[1] - a[1]);
  const [top, second] = ranked;
  if (!top) return { picked: null, reason: "the model answered with no scores" };
  if (top[0] === NONE_LABEL) return { picked: null, reason: `no persona fits (none ${pct(top[1])})` };
  if (!personas.some((p) => p.id === top[0])) return { picked: null, reason: `the model named an unknown persona (${top[0]})` };
  if (top[1] < thresholds.minProbability) {
    return { picked: null, reason: `best match ${name(top[0])} ${pct(top[1])}, under the ${pct(thresholds.minProbability)} minimum` };
  }
  if (second && top[1] - second[1] < thresholds.margin) {
    return {
      picked: null,
      reason: `${name(top[0])} ${pct(top[1])} was too close to ${name(second[0])} ${pct(second[1])} (needs a ${pct(thresholds.margin)} lead)`,
    };
  }
  /* The reader's line names the confidence and what it beat, never the model:
     which model answered is the lane's setting, not news about this thread. */
  const next = second ? `; next was ${second[0] === NONE_LABEL ? "no persona" : name(second[0])} at ${pct(second[1])}` : "";
  return { picked: top[0], probability: top[1], model, reason: `${pct(top[1])} match for your first message${next}` };
}

/** The outcome of asking, with a reason for every way it can come to nothing.
    Never throws. */
export async function classifyPersona(
  args: {
    profile: Profile;
    model: string;
    projectName: string;
    text: string;
    personas: readonly PersonaChoice[];
    thresholds?: PersonaDecisionThresholds;
    timeoutMs?: number;
  },
  call: typeof decide = decide,
): Promise<PersonaOutcome> {
  try {
    const result = await call(args.profile, {
      model: args.model,
      state: personaState(args.projectName, args.text),
      questions: { [QUESTION_NAME]: personaQuestion(args.personas) },
      timeoutMs: args.timeoutMs ?? CLASSIFY_TIMEOUT_MS,
    });
    return judgeChoice(result.answers[QUESTION_NAME]?.choice, args.personas, result.model, args.thresholds);
  } catch (err) {
    /* A provider that refused (the free tier's 429), timed out or answered
       nothing is `decide`'s HttpError, and our own abort is an
       AbortError/TimeoutError: all expected, and said in the thread rather than
       logged. Anything else is a bug here, and it still never costs the send. */
    if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
      return { picked: null, reason: "the decision model timed out" };
    }
    if (err instanceof HttpError) {
      return { picked: null, reason: `the decision model failed (${err.message.slice(0, 120)})` };
    }
    console.error("[persona-classify] unexpected failure", err);
    return { picked: null, reason: "classification hit an internal error" };
  }
}
