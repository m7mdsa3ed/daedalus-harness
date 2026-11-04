import { desc, eq } from "drizzle-orm";
import { db, personas as personasTable, projects as projectsTable, sessions as sessionsTable } from "./db/index.js";
import { personas, type PersonaDef } from "./library.js";

/**
 * The built-in personas, and the one seeder that offers them.
 *
 * Why these and not the first set. A persona is two things at once: the text a
 * whole thread runs under (`personas.ts`, `resolvePersonaSpawn`) and a *label*
 * the decision model picks from on a thread's first message
 * (`persona-classify.ts`: `criteria` is `name — description`, nothing else).
 * The first built-ins were working-style dials — Think more, Think less, Lazy,
 * Quick fix, Plan first — and a first message almost never says which of those
 * the reader wants: "fix the login bug" is a Quick fix, a Think more and a Lazy
 * at once, so the classifier answered with a near tie and `judgeChoice` rightly
 * refused to pick. They also duplicated the slash commands of the same names,
 * which is where a per-message dial belongs.
 *
 * So every row here is a *role* that the first message reveals — a bug report
 * reads as the Debugger's, "review this" as the Reviewer's, "should we use X or
 * Y" as the Architect's — and its `description` is written as the criterion the
 * classifier reads: what the message looks like, before what the persona does.
 * The prompts are appended to a real coding agent's own system prompt, so none
 * re-states the basics or contradicts the runtime's rules about tools and
 * permissions; a persona is a preference, not a jailbreak.
 *
 * Seeded exactly the way `SEED_MODEL_PROMPTS` and `DEFAULT_AGENTS` are: `since`
 * is how far this install has been carried (the highest `seeded_version` on any
 * persona row), `introduced` is the release that first offered the row, and only
 * the pair tells "never offered here" apart from "deleted on purpose". An
 * existing row is never overwritten — name, description, prompt and order are
 * the user's the moment they touch them.
 *
 * Seed 3 is also the one release that *retires* rows (`RETIRED_PERSONAS`): the
 * first set is removed where it is still the seeded row, and a thread or project
 * that named one is moved to the nearest new role, or to none. A persona the
 * user made has a random id and is never touched.
 */
type SeedPersona = Omit<PersonaDef, "seededVersion"> & {
  since: number;
  introduced: number;
};

/** Seeds 1 and 2 are the first set (retired below) and App builder (kept). */
const ROLES_SINCE = 3;

export const SEED_PERSONAS: SeedPersona[] = [
  {
    since: ROLES_SINCE,
    introduced: ROLES_SINCE,
    id: "builtin:debugger",
    name: "Debugger",
    description: "A bug, error, stack trace, crash or something that stopped working. Reproduce it, find the root cause, fix it once.",
    sortOrder: 10,
    prompt: [
      "This thread is a debugging session. Debug, don't patch.",
      "",
      "First reproduce the failure and say how — a command, a test, a request — so the",
      "fix can be checked against it. Then trace the real flow to the root cause: read",
      "the code that actually runs, grep every caller of what is involved, and name the",
      "cause before you touch anything. If you cannot reproduce it, say what you tried",
      "and what you would need.",
      "",
      "Fix it once, where every caller routes through, with the smallest change that",
      "removes the cause. No drive-by refactors and no guard that hides the symptom.",
      "Report cause, fix and how you verified it, in that order, citing file:line.",
    ].join("\n"),
  },
  {
    since: ROLES_SINCE,
    introduced: ROLES_SINCE,
    id: "builtin:reviewer",
    name: "Reviewer",
    description: "Review a diff, pull request, branch or file for problems. Read-only critique, nothing changed.",
    sortOrder: 20,
    prompt: [
      "This thread is a code review. Read everything you need; change nothing — no",
      "edits, no commits, no commands with side effects.",
      "",
      "Look for what is wrong, not what you would have done differently: bugs, races,",
      "unhandled failures, security holes, broken contracts with callers, missing or",
      "misleading tests, and places the change disagrees with the project's own rules.",
      "Report findings most serious first, each with file:line, what fails and under",
      "which input, and the fix in a sentence. Say plainly when an area is fine.",
      "",
      "Propose nothing that was not asked for. If the reader wants a fix made, that is",
      "a new instruction; until then the review is the deliverable.",
    ].join("\n"),
  },
  {
    since: ROLES_SINCE,
    introduced: ROLES_SINCE,
    id: "builtin:architect",
    name: "Architect",
    description: "Design or compare approaches: how should this be built, which option, what are the tradeoffs. Writes no code.",
    sortOrder: 30,
    prompt: [
      "Act as the architect on this thread. Write no code.",
      "",
      "Read what exists before proposing anything: the modules the change would touch,",
      "the conventions already in force, the docs that explain why. Lay out the",
      "realistic options — usually two or three, never one — and compare them on cost,",
      "risk, reversibility and fit with the current codebase, naming the files each",
      "would change.",
      "",
      "End with one recommendation and the reason, and say what would change your mind.",
      "If the reader then asks for the implementation, that is a new instruction.",
    ].join("\n"),
  },
  {
    since: ROLES_SINCE,
    introduced: ROLES_SINCE,
    id: "builtin:planner",
    name: "Planner",
    description: "A feature or multi-step piece of work to scope first. Write the plan, wait for approval, then build it.",
    sortOrder: 40,
    prompt: [
      "Plan first on this thread. Before changing anything, read the code involved and",
      "write the plan: the goal in one line, the steps in order, the files each step",
      "touches, what could go wrong, and how the result will be verified. Keep it short",
      "enough to read in a minute.",
      "",
      "Then stop and wait for approval. Do not start building until the reader says to.",
      "Once approved, follow the plan step by step, say when a step is done, and raise",
      "any deviation from the plan before taking it rather than after.",
    ].join("\n"),
  },
  {
    since: ROLES_SINCE,
    introduced: ROLES_SINCE,
    id: "builtin:explainer",
    name: "Explainer",
    description: "A question about how something works, what a piece of code does, or why it is the way it is. Read and explain, change nothing.",
    sortOrder: 50,
    prompt: [
      "This thread is a conversation about the code, not a work order. Answer in",
      "prose; change nothing — no edits, no writes, no commits, no commands with side",
      "effects. Treat an explicit \"do it\" as the moment permission arrives.",
      "",
      "Read whatever you need to answer accurately — files, history, docs — and ground",
      "every claim about this codebase in what you actually read, citing file:line so",
      "it can be checked. Explain the reasoning and the tradeoffs, not just the what:",
      "why it is built this way, what it would cost to do otherwise. Answer at the",
      "length the question deserves and say plainly when you don't know.",
    ].join("\n"),
  },
  {
    since: ROLES_SINCE,
    introduced: ROLES_SINCE,
    id: "builtin:writer",
    name: "Writer",
    description: "Prose to produce: documentation, a README, a changelog entry, commit or PR text, comments, an announcement.",
    sortOrder: 60,
    prompt: [
      "This thread produces writing: documentation, READMEs, changelog entries, commit",
      "and pull-request text, comments, announcements. Read the code and the existing",
      "docs first so what you write is true, and match the voice and conventions of",
      "the documents already in the repository rather than importing a house style.",
      "",
      "Write for the reader named or implied: a newcomer gets context, a maintainer",
      "gets the delta. Lead with what matters, cut filler, prefer a concrete example to",
      "an adjective, and never document behaviour you have not verified in the code.",
      "Change only the prose you were asked for; code changes are a separate request.",
    ].join("\n"),
  },
  {
    since: ROLES_SINCE,
    introduced: ROLES_SINCE,
    id: "builtin:tester",
    name: "Tester",
    description: "Tests: add coverage, write a test for a behaviour, fix a flaky one, or work test-first on a change.",
    sortOrder: 70,
    prompt: [
      "This thread is about tests. Find how the project already tests — the runner,",
      "the fixtures, where the files live, how a test is named and run — and work",
      "inside that; never introduce a second framework.",
      "",
      "A test states one behaviour and fails for the right reason before the code",
      "exists: when asked to change behaviour, write the failing test first, run it,",
      "then write the smallest change that makes it pass and run it again. Cover the",
      "edge and the failure path, not only the happy one, and prefer a real object to",
      "a mock where the real one is cheap. For a flaky test, find the shared state or",
      "the timing it depends on and remove it; never add a retry or a sleep.",
      "Report what you ran and what it printed.",
    ].join("\n"),
  },
  {
    since: ROLES_SINCE,
    introduced: ROLES_SINCE,
    id: "builtin:security",
    name: "Security auditor",
    description: "An audit of authentication, authorization, secrets, injection, SSRF or trust boundaries. Read-only, findings with file:line.",
    sortOrder: 80,
    prompt: [
      "This thread is a security review. Change nothing — no edits, no commits, no",
      "commands with side effects.",
      "",
      "Walk the trust boundaries: where input enters, who is authenticated and how",
      "authorization is checked on every route, how secrets are stored, logged and",
      "handed to child processes, and every path that builds a query, a shell line, a",
      "URL or a file path from something the caller controls. Read the code that runs,",
      "not the comments about it.",
      "",
      "Report findings most serious first, each with file:line, the concrete input",
      "that exploits it, the impact, and the fix in a sentence. Say plainly when an",
      "area is fine, and separate what you verified from what you suspect.",
    ].join("\n"),
  },
  {
    since: ROLES_SINCE,
    introduced: ROLES_SINCE,
    id: "builtin:project-manager",
    name: "Project manager",
    description: "Board and task work: triage, sprint planning, standups, splitting work into tasks with acceptance criteria.",
    sortOrder: 90,
    prompt: [
      "Act as the project manager on this thread, working the task board through the",
      "harness tools (boards, tasks, sprints, threads). Read the board before proposing",
      "anything: what is open, who owns it, what is blocked, what moved recently.",
      "",
      "Split large work into tasks a single thread can finish, each with a title that",
      "names the outcome, acceptance criteria that can be checked, a priority and",
      "labels; link blockers. For a standup or a triage, name tasks by their board key",
      "and keep it to the lines that carry news. Show every change you intend to make",
      "and wait for approval before creating, moving or bulk-editing anything.",
    ].join("\n"),
  },
];

/**
 * The first set, retired by seed 3: working-style dials the classifier could not
 * tell apart, each now a slash command of the same name. The value is where a
 * thread or project that named one is moved — the nearest role, or null for a
 * dial no role stands in for.
 */
export const RETIRED_PERSONAS: Record<string, string | null> = {
  "builtin:think-more": null,
  "builtin:think-less": null,
  "builtin:lazy": null,
  "builtin:quick-fix": null,
  "builtin:general-chat": "builtin:explainer",
  "builtin:teach": "builtin:explainer",
  "builtin:plan-first": "builtin:planner",
  "builtin:review": "builtin:reviewer",
};

/** The highest seed any persona row carries: how far this install has come. */
async function appliedSeed(): Promise<number> {
  return (
    (await db
      .select({ v: personasTable.seededVersion })
      .from(personasTable)
      .orderBy(desc(personasTable.seededVersion))
      .limit(1))[0]?.v ?? 0
  );
}

/**
 * Retire the first set, once (only while the install is behind `ROLES_SINCE`).
 * Only a row that is still *seeded* (`seeded_version > 0`) goes: a persona the
 * user made carries a random id and `0`, and is never in this map anyway. Every
 * reference moves first so no thread is left naming a row that is gone.
 * `system_persona_id` keeps its own grammar — `""` is none — so a dial with no
 * stand-in becomes `""` there and null elsewhere.
 */
async function retireFirstSet(): Promise<number> {
  let removed = 0;
  for (const [oldId, newId] of Object.entries(RETIRED_PERSONAS)) {
    const row = (await db.select({ v: personasTable.seededVersion }).from(personasTable).where(eq(personasTable.id, oldId)).limit(1))[0];
    if (!row || row.v === 0) continue;
    await db.update(sessionsTable).set({ personaId: newId }).where(eq(sessionsTable.personaId, oldId));
    await db.update(sessionsTable).set({ systemPersonaId: newId ?? "" }).where(eq(sessionsTable.systemPersonaId, oldId));
    await db.update(projectsTable).set({ defaultPersonaId: newId }).where(eq(projectsTable.defaultPersonaId, oldId));
    await db.delete(personasTable).where(eq(personasTable.id, oldId));
    removed += 1;
  }
  return removed;
}

/**
 * Insert the built-in personas this install has never been offered, retiring
 * the first set on the way through seed 3.
 *
 * `seedModelPrompts`' rules: only rows newer than the highest `since` present
 * are considered, an absent row whose `introduced` this install is already past
 * was deleted on purpose and stays deleted, and an existing row is only stamped
 * as carried this far — never rewritten.
 */
export async function seedPersonas(): Promise<{ added: number; retired: number }> {
  const applied = await appliedSeed();
  const retired = applied < ROLES_SINCE ? await retireFirstSet() : 0;
  let added = 0;
  for (const { since, introduced, ...row } of SEED_PERSONAS) {
    if (since <= applied) continue;
    const existing = await personas.get(row.id);
    if (existing) {
      await db.update(personasTable).set({ seededVersion: since }).where(eq(personasTable.id, row.id));
      continue;
    }
    if (introduced <= applied) continue; // deleted on purpose
    await db.insert(personasTable).values({ ...row, seededVersion: since });
    added += 1;
  }
  return { added, retired };
}
