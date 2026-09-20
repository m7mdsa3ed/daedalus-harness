import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  familyPrompt,
  loadModelPrompts,
  matchModelPrompt,
  modelPromptLayer,
} from "../src/model-prompts.js";
import { Session } from "../src/session.js";
import { systemPrompt } from "../src/turn.js";
import { testEnv } from "./helpers/scripted.js";

const dir = mkdtempSync(join(tmpdir(), "daedalus-model-prompts-"));

// --- matching: exact beats glob, longer glob beats shorter ---
{
  const entries = [
    { match: "qwen*", prompt: "FAMILY" },
    { match: "qwen3-coder*", prompt: "GENERATION" },
    { match: "qwen3-coder-plus", prompt: "EXACT" },
  ];
  assert.equal(matchModelPrompt("qwen3-coder-plus", entries), "EXACT");
  assert.equal(matchModelPrompt("Qwen3-Coder-Flash", entries), "GENERATION", "case-insensitive");
  assert.equal(matchModelPrompt("qwen-max", entries), "FAMILY");
  assert.equal(matchModelPrompt("gemini-2.5-pro", entries), undefined, "no match");
  console.log("model-prompts: matching ok");
}

// --- library load: missing and broken files read as no rows ---
{
  assert.deepEqual(loadModelPrompts(join(dir, "missing.json")), []);
  const broken = join(dir, "broken.json");
  writeFileSync(broken, "{not json");
  assert.deepEqual(loadModelPrompts(broken), []);
  const empty = join(dir, "empty.json");
  writeFileSync(empty, JSON.stringify({ version: 1, entries: [] }));
  assert.deepEqual(loadModelPrompts(empty), []);
  const library = join(dir, "library.json");
  writeFileSync(
    library,
    JSON.stringify({
      version: 1,
      entries: [
        { match: "gemini*", prompt: "GEMINI ROW" },
        { match: "", prompt: "EMPTY MATCH — dropped" },
        { match: "  ", prompt: "BLANK MATCH — dropped" },
        { match: "opus*", prompt: "" },
      ],
    }),
  );
  assert.deepEqual(loadModelPrompts(library), [{ match: "gemini*", prompt: "GEMINI ROW" }]);
  console.log("model-prompts: load ok");
}

// --- built-ins: every family names itself through the detector ---
{
  for (const id of ["gemini-2.5-pro", "claude-opus-4-6", "qwen3-coder-plus", "deepseek-chat", "glm-4.6", "kimi-k2", "gpt-5", "grok-4"]) {
    assert.ok(familyPrompt(id), `${id} has a family calibration`);
  }
  assert.equal(familyPrompt("some-future-model-9"), undefined);
  console.log("model-prompts: families ok");
}

// --- precedence: assigned row beats the built-in; unknown id gets the header alone ---
{
  const entries = [{ match: "qwen*", prompt: "ASSIGNED ROW" }];
  const assigned = modelPromptLayer("qwen3-coder-plus", entries);
  assert.ok(assigned.includes("qwen3-coder-plus"), "the header names the engine");
  assert.ok(assigned.includes("ASSIGNED ROW"));
  assert.ok(!assigned.includes("one tool call per message"), "the built-in yields to the row");
  const builtin = modelPromptLayer("qwen3-coder-plus", []);
  assert.ok(builtin.includes("qwen3-coder-plus"));
  assert.ok(builtin.includes("one tool call per message"), "the built-in applies with no row");
  const unknown = modelPromptLayer("some-future-model-9", []);
  assert.ok(unknown.includes("some-future-model-9"));
  assert.ok(!unknown.includes("undefined"), "no hole where the guidance would go");
  console.log("model-prompts: layer ok");
}

// --- the layer in systemPrompt: before the persona, re-resolved per turn ---
{
  const library = join(dir, "system.json");
  writeFileSync(library, JSON.stringify({ version: 1, entries: [{ match: "gemini*", prompt: "ROW TEXT" }] }));
  const personaFile = join(dir, "persona.md");
  writeFileSync(personaFile, "PERSONA TEXT");
  const env = testEnv({ projectInstructions: false, personaFile, modelPromptsFile: library });
  const session = new Session("s1", dir, env);
  session.modelId = "gemini-2.5-pro";

  const prompt = systemPrompt(session, env);
  assert.ok(prompt.includes("gemini-2.5-pro"), "names the engine");
  assert.ok(prompt.includes("ROW TEXT"), "carries the assigned row");
  assert.ok(prompt.indexOf("ROW TEXT") < prompt.indexOf("PERSONA TEXT"), "identity-adjacent, ahead of the persona");

  // A live model change swaps the guidance with no respawn.
  session.modelId = "qwen3-coder-plus";
  const switched = systemPrompt(session, env);
  assert.ok(!switched.includes("ROW TEXT"), "the gemini row is gone");
  assert.ok(switched.includes("qwen3-coder-plus"), "and the qwen built-in stands in");

  // A session with no model is told nothing.
  session.modelId = "";
  assert.ok(!systemPrompt(session, env).includes("The engine under this agent"));
  console.log("model-prompts: systemPrompt ok");
}

// --- the OpenUI lane is not this runtime's to teach ---
{
  /* The whole trailer, component table included, arrives through the persona
     door like the suggestions one (server/src/personas.ts), so this runtime
     pushes nothing of its own — and every other runtime is told the same. */
  const env = testEnv({ projectInstructions: false, holdOnError: true });
  const session = new Session("s1", dir, env);
  session.modelId = "gemini-2.5-pro";
  const prompt = systemPrompt(session, env, { toolNames: ["bash"] });
  assert.ok(!prompt.includes("## Drawing an answer"), "no private copy of the lane");
  session.personaText = "PERSONA\n\n## Drawing an answer\n\nStack(children";
  assert.ok(systemPrompt(session, env).includes("Stack(children"), "the persona carries it");
  console.log("model-prompts: openui lane ok");
}
