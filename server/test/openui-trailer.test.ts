/* The openui lane travels as spawn instruction text, not as a variable of our
   own runtime — which is the whole point of it, and the thing worth testing:
   a second runtime on a profile gets asked in its own instructions too.

   What this covers is the kind of claim that breaks silently: that both
   behaviours compose, that the order is the one the client's parser needs
   (the follow-up block last), and that a respawn does not append a trailer it
   already carries. */
import assert from "node:assert/strict";
import {
  OPENUI_FENCE,
  OPENUI_INSTRUCTIONS,
  SUGGEST_FOLLOWUPS_INSTRUCTIONS,
  withInstructionTrailers,
} from "../src/personas.js";

const persona = { id: "p1", prompt: "PERSONA TEXT", thinking: null };

// --- nothing asked for: the persona is returned untouched ---
{
  const out = withInstructionTrailers(persona, {});
  assert.equal(out?.prompt, "PERSONA TEXT", "no trailer means no change");
  assert.equal(withInstructionTrailers(undefined, {}), undefined, "and nothing to instruct");
  console.log("openui-trailer: idle ok");
}

// --- openui alone: asked for, with no persona to hang it on ---
{
  const out = withInstructionTrailers(undefined, { uiBlocks: true });
  assert.ok(out, "a thread with no persona still gets instructions");
  assert.ok(out.prompt.includes(OPENUI_FENCE), "names the fence the client draws");
  assert.ok(!out.prompt.includes(SUGGEST_FOLLOWUPS_INSTRUCTIONS), "and not the other one");
  const withPersona = withInstructionTrailers(persona, { uiBlocks: true });
  assert.ok(withPersona?.prompt.startsWith("PERSONA TEXT"), "appended, never prepended");
  console.log("openui-trailer: openui only ok");
}

// --- both on: composed, and suggestions last ---
{
  const out = withInstructionTrailers(persona, { uiBlocks: true, suggestFollowups: true });
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
  const once = withInstructionTrailers(persona, { uiBlocks: true, suggestFollowups: true });
  const twice = withInstructionTrailers(once, { uiBlocks: true, suggestFollowups: true });
  assert.equal(twice, once, "an already-carrying spawn is returned as it is");
  assert.equal(
    twice!.prompt.split(OPENUI_INSTRUCTIONS).length - 1,
    1,
    "the trailer appears exactly once",
  );
  // A persona that quotes the trailer is not a reason to send it twice either.
  const quoted = { id: "p2", prompt: `instructions\n\n${OPENUI_INSTRUCTIONS}`, thinking: null };
  const out = withInstructionTrailers(quoted, { uiBlocks: true });
  assert.equal(out?.prompt, quoted.prompt, "quoted text is recognized as already present");
  console.log("openui-trailer: idempotent ok");
}

// --- the trailer itself teaches the two failure modes we actually saw ---
{
  assert.ok(/positional/i.test(OPENUI_INSTRUCTIONS), "warns about positional arguments");
  assert.ok(OPENUI_INSTRUCTIONS.includes("root"), "and insists on a root");
  assert.ok(
    /if it has not/i.test(OPENUI_INSTRUCTIONS),
    "and says what to do when the components were not provided",
  );
  console.log("openui-trailer: instructions ok");
}

console.log("openui-trailer.test.ts passed");
