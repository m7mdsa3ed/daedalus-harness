/**
 * First-message persona classification on the decision lane, without a model or
 * a database.
 *
 *     pnpm test:persona-classify   (from server/)
 *
 * The decision call is a stub: the point is what the harness does with whatever
 * comes back — a persona that clears the threshold and the margin is a pick,
 * everything else (none, an unknown label, a near tie, a 429, a timeout, a
 * throw) is no pick.
 */
import assert from "node:assert/strict";
import {
  NONE_LABEL,
  classifyGate,
  classifyPersona,
  personaQuestion,
  personaState,
  judgeChoice,
  worthClassifying,
} from "../src/persona-classify.js";
import type { DecisionResult } from "../src/decide.js";
import { HttpError } from "../src/http-error.js";
import { personaSwitchBlock } from "../src/personas.js";
import type { Profile } from "../src/profiles.js";

const personas = [
  { id: "code-reviewer", name: "Code reviewer", description: "Reviews diffs for bugs" },
  { id: "writer", name: "Writer", description: "" },
];
const ids = personas.map((p) => p.id);

// The prefilter.
for (const text of ["!ls -la", "/review the diff", "@src/a.ts", "@a.ts @b.ts", "ok", "   thanks   "]) {
  assert.equal(worthClassifying(text), false, text);
}
for (const text of ["review this diff for race conditions", "@src/a.ts why does this leak memory?"]) {
  assert.equal(worthClassifying(text), true, text);
}

// The gate: null means ask; otherwise why not, and whether the reader hears it.
const open = {
  text: "review this diff for race conditions",
  globalSwitch: undefined,
  projectSwitch: true,
  draftPersonaId: null,
  projectPersonaId: null,
};
assert.equal(classifyGate(open), null);
assert.equal(classifyGate({ ...open, text: undefined })?.silent, true, "no first message");
assert.equal(classifyGate({ ...open, projectSwitch: false })?.silent, true, "their switch is quiet");
assert.equal(classifyGate({ ...open, globalSwitch: false, projectSwitch: true })?.reason, "turned off", "global off wins");
assert.equal(classifyGate({ ...open, globalSwitch: true, projectSwitch: undefined }), null, "unset is on");
// A command or a too-short message is a skip the thread reports, not one it hides.
for (const text of ["!ls -la", "/review the diff", "@a.ts", "ok"]) {
  const skip = classifyGate({ ...open, text });
  assert.equal(skip?.silent, false, text);
}
assert.equal(classifyGate({ ...open, text: "!ls -la" })?.reason, "it is a shell command");
assert.equal(classifyGate({ ...open, text: "/review the diff" })?.reason, "it is a slash command");
assert.equal(classifyGate({ ...open, text: "@a.ts @b.ts" })?.reason, "it is only mentions");
assert.equal(classifyGate({ ...open, text: "hi" })?.reason, "the message is too short");
// The hand-pick guard is their doing, so quiet: only the project's default (or none) moves.
assert.equal(classifyGate({ ...open, draftPersonaId: "writer" })?.reason, "persona picked by hand");
assert.equal(classifyGate({ ...open, draftPersonaId: "writer", projectPersonaId: "code-reviewer" })?.silent, true);
assert.equal(classifyGate({ ...open, draftPersonaId: "writer", projectPersonaId: "writer" }), null);
assert.equal(classifyGate({ ...open, draftPersonaId: "", projectPersonaId: null }), null, "'' is none");

// The question: the library is the label set, and `none` is a label.
const question = personaQuestion(personas);
assert.equal(question.type, "choice");
const criteria = question.criteria as Record<string, string>;
assert.ok(criteria[NONE_LABEL], "none is offered");
assert.equal(criteria["code-reviewer"], "Code reviewer — Reviews diffs for bugs");
assert.equal(criteria.writer, "Writer", "an empty description is the name alone");
assert.equal(Object.keys(criteria).length, 3);
// A persona that happens to be called `none` cannot shadow the escape.
assert.equal(Object.keys(personaQuestion([{ id: "none", name: "N", description: "" }]).criteria as object).length, 1);
// The state: the project and the message, capped.
assert.ok(personaState("harness", "x".repeat(5000)).startsWith("Project: harness"));
assert.ok(personaState("harness", "x".repeat(5000)).length < 2100);

// The judgement: a pick carries its probability, every non-pick carries a reason.
const judge = (choice: Record<string, number> | undefined, t?: { minProbability: number; margin: number }) =>
  judgeChoice(choice, personas, "jev", t);
const hit = judge({ "code-reviewer": 0.8, none: 0.2 });
assert.deepEqual(hit, {
  picked: "code-reviewer",
  probability: 0.8,
  model: "jev",
  reason: "80% match for your first message; next was no persona at 20%",
});
assert.doesNotMatch(hit.picked ? hit.reason : "", /jev/, "the reader's line never names the model");
assert.match(judge({ "code-reviewer": 0.8, writer: 0.15, none: 0.05 }).reason, /next was Writer at 15%/);
const reason = (outcome: ReturnType<typeof judge>) => (outcome.picked === null ? outcome.reason : "");
assert.match(reason(judge({ "code-reviewer": 0.3, writer: 0.2, none: 0.5 })), /no persona fits \(none 50%\)/);
assert.match(reason(judge({ "code-reviewer": 0.45, writer: 0.1, none: 0.4 })), /Code reviewer 45%, under the 50% minimum/);
assert.match(reason(judge({ "code-reviewer": 0.52, writer: 0.46, none: 0.02 })), /too close to Writer 46%/);
assert.match(reason(judge({ "security-auditor": 0.9, none: 0.1 })), /unknown persona \(security-auditor\)/);
assert.match(reason(judge({})), /no scores/);
assert.match(reason(judge(undefined)), /no scores/);
assert.equal(
  judge({ "code-reviewer": 0.52, writer: 0.46 }, { minProbability: 0.5, margin: 0.05 }).picked,
  "code-reviewer",
  "the margin is tunable",
);

// The call: whatever goes wrong is an outcome with a reason, never a throw.
const profile = { id: "p", baseUrl: "http://x" } as Profile;
const args = { profile, model: "jev", projectName: "harness", text: "review this diff", personas };
const answering = (choice: Record<string, number>) => async (): Promise<DecisionResult> => ({
  answers: { persona: { choice } },
  model: "jev-1.13.0",
});
const won = await classifyPersona(args, answering({ "code-reviewer": 0.9, none: 0.1 }));
assert.deepEqual(
  won,
  { picked: "code-reviewer", probability: 0.9, model: "jev-1.13.0", reason: "90% match for your first message; next was no persona at 10%" },
  "reports what answered",
);
assert.match(reason(await classifyPersona(args, answering({ none: 0.9, writer: 0.1 }))), /no persona fits/);
assert.match(reason(await classifyPersona(args, async () => ({ answers: {}, model: "jev" }))), /no scores/);
// The free tier answers 429: said in the thread, not logged.
const logged: unknown[] = [];
const error = console.error;
console.error = (...a: unknown[]) => void logged.push(a);
const refused = await classifyPersona(args, async () => {
  throw new HttpError("429: Free usage limit reached", 502);
});
assert.match(reason(refused), /the decision model failed \(429: Free usage limit reached\)/);
assert.equal(logged.length, 0, "a provider refusal is not logged");
const aborted = await classifyPersona(args, async () => {
  throw Object.assign(new Error("t"), { name: "TimeoutError" });
});
assert.match(reason(aborted), /timed out/);
// A bug of our own is still no pick — logged, and said as an internal error.
const bug = await classifyPersona(args, async () => {
  throw new TypeError("boom");
});
console.error = error;
assert.match(reason(bug), /internal error/);
assert.equal(logged.length, 1, "an unexpected failure is logged");

// The timeout is the caller's signal.
const seen: (number | undefined)[] = [];
await classifyPersona({ ...args, timeoutMs: 50 }, async (_p, call) => {
  seen.push(call.timeoutMs);
  return { answers: {}, model: "jev" };
});
assert.deepEqual(seen, [50]);

/* A mid-thread persona change rides the next prompt. The client folds it out
   of the bubble by these exact delimiters (`dropPersonaSwitch`), so they are
   the contract. */
for (const block of [personaSwitchBlock({ name: "Writer", prompt: "  Write plainly.  " }), personaSwitchBlock(null)]) {
  assert.ok(block.startsWith("\n\n<persona>\n") && block.endsWith("\n</persona>"), block);
}
assert.match(personaSwitchBlock({ name: "Writer", prompt: "Write plainly." }), /"Writer" persona below[\s\S]*\n\nWrite plainly\.\n<\/persona>$/);
assert.match(personaSwitchBlock(null), /no persona applies/);
assert.match(personaSwitchBlock({ name: "Empty", prompt: " " }), /no persona applies/);

console.log("persona-classify: ok");
