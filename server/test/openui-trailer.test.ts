/* The openui lane travels as spawn instruction text, not as a variable of our
   own runtime — which is the whole point of it, and the thing worth testing:
   a second runtime on a profile gets asked in its own instructions too.

   What this covers is the kind of claim that breaks silently: that both
   behaviours compose, that the order is the one the client's parser needs
   (the follow-up block last), and that a respawn does not append a trailer it
   already carries. */
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { OPENUI_GROUPS } from "../src/openui-prompt.js";
import type { Rule } from "../src/rules.js";
import {
  OPENUI_FENCE,
  OPENUI_INSTRUCTIONS,
  UI_GROUP_IDS,
  normalizeUiGroups,
  openuiInstructions,
  sameUiGroups,
  uiGroupsOf,
  DEFAULT_SUGGEST_KINDS,
  SUGGEST_AGENTS_FENCE,
  SUGGEST_COMMANDS_FENCE,
  SUGGEST_FILES_FENCE,
  SUGGEST_KINDS,
  SUGGEST_REPLIES_FENCE,
  normalizeSuggestKinds,
  sameSuggestKinds,
  suggestKindsOf,
  SUGGEST_FOLLOWUPS_INSTRUCTIONS,
  resolvePersonaSpawn,
  withInstructionTrailers,
} from "../src/personas.js";

const persona = { id: "p1", prompt: "PERSONA TEXT" };

// --- nothing asked for: the persona is returned untouched ---
{
  const out = withInstructionTrailers(persona, {});
  assert.equal(out?.prompt, "PERSONA TEXT", "no trailer means no change");
  assert.equal(withInstructionTrailers(undefined, {}), undefined, "and nothing to instruct");
  console.log("openui-trailer: idle ok");
}

// --- openui alone: asked for, with no persona to hang it on ---
{
  const out = withInstructionTrailers(undefined, { uiGroups: [...UI_GROUP_IDS] });
  assert.ok(out, "a thread with no persona still gets instructions");
  assert.ok(out.prompt.includes(OPENUI_FENCE), "names the fence the client draws");
  assert.ok(!out.prompt.includes(SUGGEST_FOLLOWUPS_INSTRUCTIONS), "and not the other one");
  const withPersona = withInstructionTrailers(persona, { uiGroups: [...UI_GROUP_IDS] });
  assert.ok(withPersona?.prompt.startsWith("PERSONA TEXT"), "appended, never prepended");
  console.log("openui-trailer: openui only ok");
}

// --- both on: composed, and suggestions last ---
{
  const out = withInstructionTrailers(persona, { uiGroups: [...UI_GROUP_IDS], suggestKinds: ["prompts"] });
  const text = out!.prompt;
  assert.ok(text.includes(OPENUI_INSTRUCTIONS), "the openui trailer is there");
  assert.ok(text.includes(SUGGEST_FOLLOWUPS_INSTRUCTIONS), "so is the suggestions trailer");
  assert.ok(
    text.indexOf(OPENUI_INSTRUCTIONS) < text.indexOf(SUGGEST_FOLLOWUPS_INSTRUCTIONS),
    "the follow-up block stays last, which is the end the client parses",
  );
  console.log("openui-trailer: both ok");
}

// --- a respawn must not append what it already carries ---
{
  const once = withInstructionTrailers(persona, { uiGroups: [...UI_GROUP_IDS], suggestKinds: ["prompts"] });
  const twice = withInstructionTrailers(once, { uiGroups: [...UI_GROUP_IDS], suggestKinds: ["prompts"] });
  assert.equal(twice, once, "an already-carrying spawn is returned as it is");
  assert.equal(
    twice!.prompt.split(OPENUI_INSTRUCTIONS).length - 1,
    1,
    "the trailer appears exactly once",
  );
  // A persona that quotes the trailer is not a reason to send it twice either.
  const quoted = { id: "p2", prompt: `instructions\n\n${OPENUI_INSTRUCTIONS}` };
  const out = withInstructionTrailers(quoted, { uiGroups: [...UI_GROUP_IDS] });
  assert.equal(out?.prompt, quoted.prompt, "quoted text is recognized as already present");
  console.log("openui-trailer: idempotent ok");
}

// --- the trailer itself teaches the two failure modes we actually saw ---
{
  assert.ok(/positional/i.test(OPENUI_INSTRUCTIONS), "warns about positional arguments");
  assert.ok(OPENUI_INSTRUCTIONS.includes("root = Stack([...])"), "requires valid root assignment syntax");
  assert.ok(OPENUI_INSTRUCTIONS.includes("exactly one fenced code block tagged `openui-lang`"), "requires the client-recognized fence");
  assert.ok(OPENUI_INSTRUCTIONS.includes("never emit OpenUI statements as unfenced prose"), "prevents raw OpenUI output");
  assert.ok(
    OPENUI_INSTRUCTIONS.includes("Stat(") &&
      OPENUI_INSTRUCTIONS.includes("Chart(") &&
      OPENUI_INSTRUCTIONS.includes("Flowchart("),
    "and carries the generated component table, so every runtime gets the same one",
  );
  /* The lane is opt-in per thread, so once it is on the default has to be
     drawing — the wording that said "reach for a fence only when…" was read as
     permission to answer in markdown, and a reader who picked components got
     pipe tables back. */
  assert.ok(OPENUI_INSTRUCTIONS.includes("Drawn answers are ON for this thread"), "states that the lane is the default, not an option");
  assert.ok(/Prose is right for exactly/.test(OPENUI_INSTRUCTIONS), "names the narrow cases where prose still wins");
  assert.ok(!/Reach for a fenced block ONLY/i.test(OPENUI_INSTRUCTIONS), "no leftover hedging that reads as permission to skip the lane");
  /* The library's stock preamble and inline-mode section were written for a
     chat over one dashboard: "your ENTIRE response must be openui-lang", a
     question gets "NO code", a change is "ONLY the changed statements". Each
     contradicts the lane, and the preamble claims an identity. */
  assert.ok(!OPENUI_INSTRUCTIONS.includes("ENTIRE response"), "no stock preamble demanding an all-openui reply");
  assert.ok(!OPENUI_INSTRUCTIONS.includes("You are an AI assistant"), "and no identity claim inside another runtime's prompt");
  assert.ok(!OPENUI_INSTRUCTIONS.includes("## Inline Mode") && !OPENUI_INSTRUCTIONS.includes("RootComp"), "no stock inline-mode section");
  assert.ok(OPENUI_INSTRUCTIONS.includes("Every string is double-quoted"), "teaches escaping, the parse failure the syntax rules omit");
  assert.ok(OPENUI_INSTRUCTIONS.includes("Write the values you know as literals"), "overrides the stock 'never hardcode computed values' for a lane with no queries");
  console.log("openui-trailer: instructions ok");
}

// --- groups narrow what the lane teaches, and only that ---
{
  assert.equal(openuiInstructions(), OPENUI_INSTRUCTIONS, "no set = every group");
  assert.equal(openuiInstructions(null), OPENUI_INSTRUCTIONS, "null = every group");
  assert.equal(openuiInstructions([...UI_GROUP_IDS]), OPENUI_INSTRUCTIONS, "the whole registry is the full lane");

  const narrow = openuiInstructions(["numbers"]);
  assert.ok(narrow.includes("Chart(") && narrow.includes("Stat("), "the chosen group is taught");
  assert.ok(narrow.includes("### Layout") && narrow.includes("Stack("), "layout is forced in: root lives there");
  assert.ok(!narrow.includes("Image(") && !narrow.includes("Flowchart("), "an unselected group's text is absent");
  assert.ok(!narrow.includes("### Media") && !narrow.includes("### Diagrams"), "and so are its headings");
  assert.ok(/positional/i.test(narrow) && narrow.includes("Final Verification"), "the frame around the groups is unchanged");
  assert.ok(narrow.length < OPENUI_INSTRUCTIONS.length, "narrowing costs fewer tokens");

  // A group's notes may only name its own components (or layout's): a rule that
  // names an unselected one teaches a model that was told it does not exist.
  const names = Object.fromEntries(Object.entries(OPENUI_GROUPS).map(([id, text]) => [id, [...text.matchAll(/^(\w+)\(/gm)].map((m) => m[1]!)]));
  for (const id of UI_GROUP_IDS) {
    const text = OPENUI_GROUPS[id]!;
    for (const other of UI_GROUP_IDS)
      if (other !== id && other !== "layout")
        for (const name of names[other]!) assert.ok(!new RegExp(`\\b${name}\\b`).test(text), `${id} alone must not name ${other}'s ${name}`);
  }

  const heads = [...openuiInstructions(["media", "text", "layout"]).split("## Hoisting")[0]!.matchAll(/^### (\w+)$/gm)].map((m) => m[1]);
  assert.deepEqual(heads, ["Layout", "Text", "Media"], "taught in registry order, whatever order they were picked in");

  const out = withInstructionTrailers(persona, { uiGroups: ["media"] });
  assert.ok(out!.prompt.includes("Image(") && !out!.prompt.includes("Chart("), "the behaviour carries the set into the trailer");
  assert.equal(withInstructionTrailers(persona, { uiGroups: [] })!.prompt, "PERSONA TEXT", "an empty set asks for nothing");
  assert.equal(withInstructionTrailers(persona, {})!.prompt, "PERSONA TEXT", "and so does no set");
  assert.ok(out!.prompt.includes("### Layout") && out!.prompt.includes("Stack("), "layout is forced in for a set that omits it");
  console.log("openui-trailer: groups ok");
}

// --- the group set is read one way ---
{
  assert.equal(UI_GROUP_IDS[0], "layout", "layout leads the registry");
  assert.deepEqual(normalizeUiGroups([]), [], "an empty set stays empty: drawn answers off");
  assert.deepEqual(normalizeUiGroups("text"), [], "anything but an array is empty");
  assert.deepEqual(normalizeUiGroups(["media"]), ["layout", "media"], "layout is forced into a non-empty set");
  assert.deepEqual(normalizeUiGroups(["media", "nope", "text", "text"]), ["layout", "text", "media"], "known ids, deduped, registry order");
  assert.deepEqual(uiGroupsOf(null, false), [], "legacy: the switch off reads as none");
  assert.deepEqual(uiGroupsOf(null, true), [...UI_GROUP_IDS], "legacy: the switch on reads as every group");
  assert.deepEqual(uiGroupsOf(null, null), [...UI_GROUP_IDS], "legacy: never asked reads as every group");
  assert.deepEqual(uiGroupsOf(undefined), [...UI_GROUP_IDS]);
  assert.deepEqual(uiGroupsOf(["dev"], false), ["layout", "dev"], "a stored set outranks the legacy switch");
  assert.deepEqual(uiGroupsOf([], true), [], "and so does a stored empty one");
  assert.ok(sameUiGroups([], []) && !sameUiGroups([], ["dev"]), "empty is a set of its own");
  assert.ok(sameUiGroups(["dev", "text"], ["text", "dev", "layout"]), "order and the implied layout are not differences");
  assert.ok(!sameUiGroups(["dev"], ["text"]));
  console.log("openui-trailer: group set ok");
}

// --- a task: named, with its column ids, ahead of the other trailers, once ---
{
  const task = {
    id: "t1",
    key: "WEB-12",
    title: "Fix login",
    status: "To do",
    columns: [
      { id: "todo", name: "To do", category: "todo" },
      { id: "done", name: "Done", category: "done" },
    ],
  };
  const out = withInstructionTrailers(persona, { task, uiGroups: [...UI_GROUP_IDS] });
  assert.ok(out!.prompt.includes("WEB-12") && out!.prompt.includes("Done (done) = done"), "names the task and its columns");
  assert.ok(out!.prompt.indexOf("WEB-12") < out!.prompt.indexOf(OPENUI_INSTRUCTIONS), "the task comes first");
  assert.equal(withInstructionTrailers(out, { task, uiGroups: [...UI_GROUP_IDS] })!.prompt, out!.prompt, "and a respawn does not repeat it");
  console.log("openui-trailer: task ok");
}

// --- project commands: listed, recommend-only, ahead of the follow-ups ---
{
  const commands = [
    { name: "Build", command: "pnpm build" },
    { name: "Test", command: "pnpm test" },
  ];
  const out = withInstructionTrailers(persona, { suggestKinds: ["prompts", "commands"], suggestData: { commands } });
  const text = out!.prompt;
  assert.ok(text.includes(SUGGEST_COMMANDS_FENCE), "names the commands fence");
  assert.ok(
    text.includes("`pnpm build`") && text.includes("`pnpm test`"),
    "lists the project's own lines for the model to pick from",
  );
  assert.ok(
    text.indexOf(SUGGEST_COMMANDS_FENCE) < text.indexOf(SUGGEST_FOLLOWUPS_INSTRUCTIONS),
    "the commands trailer sits ahead of the follow-up block, which stays last",
  );
  assert.ok(
    /only ever name a command from the list/i.test(text),
    "the list is the constraint: the model is told to invent nothing",
  );

  // No project commands: the follow-ups still go out, and nothing names a fence
  // the model was handed no list for.
  const bare = withInstructionTrailers(persona, { suggestKinds: ["prompts"] });
  assert.ok(bare!.prompt.includes(SUGGEST_FOLLOWUPS_INSTRUCTIONS), "follow-ups still there");
  assert.ok(!bare!.prompt.includes(SUGGEST_COMMANDS_FENCE), "and no commands fence without a list");

  // The commands trailer rides the suggestions toggle, not a lane of its own.
  const off = withInstructionTrailers(persona, { suggestData: { commands } });
  assert.equal(off?.prompt, "PERSONA TEXT", "commands alone instruct nothing");

  // Idempotent across a respawn, like the others.
  const twice = withInstructionTrailers(out, { suggestKinds: ["prompts", "commands"], suggestData: { commands } });
  assert.equal(twice!.prompt, out!.prompt, "a respawn does not repeat the commands trailer");
  console.log("openui-trailer: commands ok");
}

// --- the kind set: normalised, legacy-aware, and driven by the registry ---
{
  assert.deepEqual(normalizeSuggestKinds(["files", "nope", "prompts", "files"]), ["prompts", "files"], "known ids, deduped, registry order");
  assert.deepEqual(normalizeSuggestKinds("prompts"), [], "anything but an array is empty");
  assert.deepEqual(suggestKindsOf(null, true), [...DEFAULT_SUGGEST_KINDS], "a row with no set reads the old flag: on");
  assert.deepEqual(suggestKindsOf(null, false), [], "and off");
  assert.deepEqual(suggestKindsOf(["agents"], false), ["agents"], "a stored set outranks the flag");
  assert.ok(sameSuggestKinds(["files", "prompts"], ["prompts", "files"]), "order is not a difference");

  // Every kind on, with the data its loader would read: one trailer each,
  // follow-ups last.
  const data = { commands: [{ name: "Build", command: "pnpm build" }], agents: [{ profile: "OpenAI", agent: "Codex" }] };
  const text = withInstructionTrailers(persona, { suggestKinds: [...SUGGEST_KINDS], suggestData: data })!.prompt;
  for (const fence of [SUGGEST_COMMANDS_FENCE, SUGGEST_REPLIES_FENCE, SUGGEST_FILES_FENCE, SUGGEST_AGENTS_FENCE])
    assert.ok(text.includes(`\`${fence}\``), `${fence} is asked for`);
  assert.ok(text.includes("Codex / OpenAI"), "the agents trailer lists the pairs it may name");
  assert.ok(text.lastIndexOf("suggest-prompts") > text.lastIndexOf(SUGGEST_AGENTS_FENCE), "follow-ups stay last");

  // A kind that must name something real says nothing without it.
  const bare = withInstructionTrailers(persona, { suggestKinds: ["commands", "agents"] });
  assert.equal(bare?.prompt, "PERSONA TEXT", "no commands and no other agent: nothing to ask");

  // Only what was picked.
  const just = withInstructionTrailers(persona, { suggestKinds: ["replies"] })!.prompt;
  assert.ok(just.includes(SUGGEST_REPLIES_FENCE) && !just.includes("suggest-prompts"), "an unpicked kind is not asked for");
  console.log("openui-trailer: kinds ok");
}

{
  // The persona heads the spawn text, the rules sit beneath it, trailers after.
  const rule = { content: "RULE TEXT" } as Rule;
  const spawn = await resolvePersonaSpawn("t1", undefined, { suggestKinds: ["prompts"] }, [rule], { id: "p1", prompt: "PERSONA TEXT\n" });
  assert.equal(spawn?.id, "p1");
  const text = spawn!.prompt;
  assert.ok(text.startsWith("PERSONA TEXT\n\nRULE TEXT"), "persona first, then the rules");
  assert.ok(text.indexOf("suggest-prompts") > text.indexOf("RULE TEXT"), "trailers after both");
  assert.equal((await resolvePersonaSpawn("t1", undefined, {}, [rule]))?.id, "rules", "no persona: the rules alone");
  console.log("openui-trailer: persona ok");
}

console.log("openui-trailer.test.ts passed");
