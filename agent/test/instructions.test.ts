import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentApp } from "../src/app.js";
import { findInstructionFiles, readInstructions } from "../src/instructions.js";
import { Session } from "../src/session.js";
import { systemPrompt } from "../src/turn.js";
import {
  initialize,
  makeClient,
  promptOf,
  scriptedModel,
  testEnv,
  textScript,
} from "./helpers/scripted.js";

/* A repo with a root AGENTS.md, a package with its own, a home with a global
   CLAUDE.md, and a directory above the repo whose file must NOT be read. */
const outside = mkdtempSync(join(tmpdir(), "daedalus-outside-"));
const repo = join(outside, "repo");
const pkg = join(repo, "packages", "app");
const home = join(outside, "home");
mkdirSync(join(repo, ".git"), { recursive: true });
mkdirSync(pkg, { recursive: true });
mkdirSync(join(home, ".claude"), { recursive: true });
writeFileSync(join(outside, "AGENTS.md"), "ABOVE THE REPO — must not be read");
writeFileSync(join(repo, "AGENTS.md"), "REPO RULE: two-space indent");
writeFileSync(join(pkg, "CLAUDE.md"), "PACKAGE RULE: no default exports");
writeFileSync(join(home, ".claude", "CLAUDE.md"), "USER RULE: be terse");
/* `Session` resolves `~/.claude/CLAUDE.md` through `homedir()`, which reads
   $HOME on POSIX. Pointed at the tree above for the whole file, so the end-to-
   end block below — which cannot reach into the session the agent builds — is
   asserting against a home this test owns rather than against whatever the
   machine's own global CLAUDE.md happens to say (and, if that file were large
   enough, spend the whole instruction budget on). */
process.env.HOME = home;

// --- the walk ---
{
  const found = findInstructionFiles(pkg, home);
  assert.deepEqual(found, [
    join(home, ".claude", "CLAUDE.md"),
    join(repo, "AGENTS.md"),
    join(pkg, "CLAUDE.md"),
  ]);
  // The repo is the ceiling, and the order is weakest first.
  assert.ok(!found.some((p) => p === join(outside, "AGENTS.md")), "stops at the git root");
  console.log("instructions: walk ok");
}

// --- AGENT.md, opencode's singular, is read too ---
{
  const singular = join(outside, "singular");
  mkdirSync(join(singular, ".git"), { recursive: true });
  writeFileSync(join(singular, "AGENT.md"), "SINGULAR RULE: tabs");
  writeFileSync(join(singular, "CLAUDE.md"), "CLAUDE RULE: spaces");
  const found = findInstructionFiles(singular, home).filter((p) => p.startsWith(singular));
  assert.deepEqual(found, [join(singular, "AGENT.md"), join(singular, "CLAUDE.md")]);
  const blocks = readInstructions(found).join("\n");
  assert.ok(blocks.includes("SINGULAR RULE: tabs"));
  console.log("instructions: AGENT.md ok");
}

// --- a file over the per-file cap says what is missing ---
{
  const big = join(outside, "big");
  mkdirSync(join(big, ".git"), { recursive: true });
  writeFileSync(join(big, "AGENTS.md"), "x".repeat(60_000));
  const [block] = readInstructions([join(big, "AGENTS.md")]);
  assert.ok(block.includes("more characters in"), "names what was dropped");
  assert.ok(block.includes(join(big, "AGENTS.md")), "and the file to read for it");
  console.log("instructions: clip notice ok");
}

// --- a symlinked AGENTS.md -> CLAUDE.md is one file, not two ---
{
  const linked = join(outside, "linked");
  mkdirSync(join(linked, ".git"), { recursive: true });
  writeFileSync(join(linked, "CLAUDE.md"), "SHARED RULE");
  symlinkSync(join(linked, "CLAUDE.md"), join(linked, "AGENTS.md"));
  const found = findInstructionFiles(linked, home);
  const inRepo = found.filter((p) => p.startsWith(linked));
  assert.equal(inRepo.length, 1, `deduped by real path, got ${inRepo.join(", ")}`);

  // A copy rather than a symlink is caught on content instead.
  const copied = join(outside, "copied");
  mkdirSync(join(copied, ".git"), { recursive: true });
  writeFileSync(join(copied, "CLAUDE.md"), "SAME TEXT");
  writeFileSync(join(copied, "AGENTS.md"), "SAME TEXT");
  assert.equal(readInstructions(findInstructionFiles(copied, home).filter((p) => p.startsWith(copied))).length, 1);
  console.log("instructions: dedupe ok");
}

// --- the prompt layer, and its order against the persona ---
{
  const personaFile = join(outside, "persona.md");
  writeFileSync(personaFile, "PERSONA: think it through");
  const env = testEnv({ projectInstructions: true, personaFile });
  const session = new Session("s1", pkg, env);
  // The scan runs per turn off the session's own home; point it at ours.
  session.instructionsHome = home;

  const prompt = systemPrompt(session, env);
  for (const rule of ["USER RULE: be terse", "REPO RULE: two-space indent", "PACKAGE RULE: no default exports"]) {
    assert.ok(prompt.includes(rule), `prompt carries ${rule}`);
  }
  assert.ok(!prompt.includes("ABOVE THE REPO"));
  // Each block says where it came from, so a rule can be traced and edited.
  assert.ok(prompt.includes(`Instructions from ${join(repo, "AGENTS.md")}:`));
  // Weakest first, and the persona has the last word of the three.
  assert.ok(prompt.indexOf("USER RULE") < prompt.indexOf("REPO RULE"));
  assert.ok(prompt.indexOf("REPO RULE") < prompt.indexOf("PACKAGE RULE"));
  assert.ok(prompt.indexOf("PACKAGE RULE") < prompt.indexOf("PERSONA:"));
  console.log("instructions: prompt layer ok");
}

/* --- the prompt names the tools the turn actually built ---

   The failure this is written against: plan mode strips every writing tool,
   and the prompt went on telling the model to "use Bash ONLY for read-only
   operations" over a tool set with no bash in it. The model obeyed and got a
   NoSuchToolError. A prompt may not name a tool the loop did not build. */
{
  const env = testEnv({ projectInstructions: false });
  const planning = new Session("plan-1", pkg, env);
  planning.mode = "plan";
  const readOnly = ["read_file", "glob", "grep", "write_todos"];
  const prompt = systemPrompt(planning, env, { toolNames: readOnly });
  for (const name of readOnly) assert.ok(prompt.includes(`- ${name}`), `plan prompt lists ${name}`);
  for (const gone of ["bash", "edit_file", "write_file"]) {
    assert.ok(!prompt.includes(`- ${gone}\n`), `plan prompt does not offer ${gone}`);
  }
  assert.ok(prompt.includes("PLAN MODE"), "plan mode is stated");
  assert.ok(!/use Bash/i.test(prompt), "plan mode never sends the model to a tool it does not have");

  // A full turn gets the whole set, and the rules that keep its arguments whole.
  const working = new Session("plan-2", pkg, env);
  const full = systemPrompt(working, env, { toolNames: [...readOnly, "bash", "edit_file", "write_file", "task"] });
  assert.ok(full.includes("- bash"), "a default turn lists bash");
  assert.ok(full.includes("use the task tool"), "the task tool is recommended when it exists");
  assert.ok(!systemPrompt(working, env, { toolNames: readOnly }).includes("use the task tool"));
  assert.ok(full.includes("its own complete JSON arguments object"), "argument discipline is stated");
  // Cruft from another product: a tool that has never existed here.
  assert.ok(!full.includes("WebFetch"), "no tool from another harness is named");
  console.log("instructions: prompt names the live tool set ok");
}

// --- off by env, and edits land without a respawn ---
{
  const env = testEnv({ projectInstructions: false });
  const session = new Session("s2", pkg, env);
  assert.equal(session.projectInstructions, false);
  assert.ok(!systemPrompt(session, env).includes("PACKAGE RULE"));

  const live = testEnv({ projectInstructions: true });
  const s3 = new Session("s3", pkg, live);
  s3.instructionsHome = home;
  writeFileSync(join(pkg, "CLAUDE.md"), "PACKAGE RULE: rewritten mid-session");
  assert.ok(systemPrompt(s3, live).includes("rewritten mid-session"), "re-read every turn");

  /* A file that did not exist when the session opened. The walk runs per turn,
     so an `/init` that writes a CLAUDE.md applies from the next turn rather
     than from the next respawn. */
  const fresh = join(outside, "fresh");
  mkdirSync(join(fresh, ".git"), { recursive: true });
  const s4 = new Session("s4", fresh, live);
  s4.instructionsHome = home;
  assert.ok(!systemPrompt(s4, live).includes("WRITTEN LATER"));
  writeFileSync(join(fresh, "CLAUDE.md"), "WRITTEN LATER: a rule the agent wrote");
  assert.ok(systemPrompt(s4, live).includes("WRITTEN LATER"), "a file created mid-session is found");
  console.log("instructions: switch + freshness ok");
}

// --- end to end: it actually reaches the model ---
{
  let sawSystem = "";
  const env = testEnv({ projectInstructions: true });
  const agent = buildAgentApp({
    env,
    makeModel: (e, id) => {
      const model = scriptedModel([textScript("Noted. ")])(e, id);
      return new Proxy(model as object, {
        get(target, prop, receiver) {
          if (prop === "doStream") {
            return async (options: { prompt: { role: string; content: unknown }[] }) => {
              const system = options.prompt.find((m) => m.role === "system");
              sawSystem = JSON.stringify(system?.content ?? "");
              return (target as { doStream: (o: unknown) => unknown }).doStream(options);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as never;
    },
  });
  const { app: client } = makeClient();
  await client.connectWith(agent, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd: pkg, mcpServers: [] });
    await ctx.request("session/prompt", { sessionId, prompt: promptOf("hello") });
  });
  assert.ok(sawSystem.includes("PACKAGE RULE"), "the repo's rules reached the request");
  console.log("instructions: end to end ok");
}

console.log("instructions.test.ts passed");
