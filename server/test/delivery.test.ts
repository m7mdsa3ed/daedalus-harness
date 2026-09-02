// Self-check for the pure half of the attachment story (src/delivery.ts), plus
// the composer's own paste expansion — both run in the browser and on the
// server, and both are the kind of thing whose bugs are invisible until a turn
// has already been spent.
//
//   - resolveDelivery's four vetoes, in order, and the no-catalog carve-out.
//   - the case the whole phase exists for: an agent saying `promptCapabilities:
//     {}` against a catalog claiming ["text","image"] — the agent's no wins.
//   - expandPastes: the token is replaced in place, a computed fence, a deleted
//     token drops its body, numbering is stable.
// Run: pnpm test:delivery
import assert from "node:assert/strict";

const { resolveDelivery, isTextish } = await import("../src/delivery.js");
/* The client's own module, imported across the package boundary: it is pure and
   has no DOM in the paths under test, and duplicating the fence rule into a
   fixture here is exactly how the two would drift. The path is built rather
   than written literally because tsconfig forbids a `.ts` specifier. */
const pastes = (await import(
  new URL("../../client/src/lib/pastes.ts", import.meta.url).href
)) as typeof import("../../client/src/lib/pastes.js");
const { expandPastes, isLongPaste, mintPaste, pasteToken, livePastes, dropPaste } = pastes;

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  ✗ ${name}\n    ${error instanceof Error ? error.message : String(error)}`);
  }
}

const IMAGE_AGENT = { image: true, audio: true, embeddedContext: true };
const base = {
  caps: IMAGE_AGENT,
  modalities: ["text", "image"],
  hasCatalog: true,
  inlineBudgetLeft: 10_000_000,
};

console.log("delivery");

test("an image reaches the model as an image when both halves agree", () => {
  assert.equal(resolveDelivery("image/png", 1000, base).delivery, "image");
});

test("forceLink wins over everything", () => {
  const out = resolveDelivery("image/png", 1000, { ...base, forceLink: true });
  assert.equal(out.delivery, "link");
  assert.match(out.reason, /you asked for paths/);
});

test("the budget degrades to a path rather than refusing", () => {
  const out = resolveDelivery("image/png", 5000, { ...base, inlineBudgetLeft: 100 });
  assert.equal(out.delivery, "link");
  assert.match(out.reason, /too large to inline/);
});

test("the agent's no is authoritative, whatever the model claims", () => {
  // The case this phase was written around: claude-agent-acp says `image: true`
  // because the runtime can carry the block; an agent that says nothing must
  // not have an image base64'd into its stdin on the model's say-so.
  const out = resolveDelivery("image/png", 1000, { ...base, caps: {} });
  assert.equal(out.delivery, "link");
  assert.match(out.reason, /agent can't carry images/);
});

test("unknown capabilities read as no", () => {
  assert.equal(resolveDelivery("image/png", 1000, { ...base, caps: undefined }).delivery, "link");
});

test("a catalog that lists no image modality is a positive no", () => {
  const out = resolveDelivery("image/png", 1000, { ...base, modalities: ["text"] });
  assert.equal(out.delivery, "link");
  assert.match(out.reason, /model can't read images/);
});

test("a catalog with no modalities at all is read the same conservative way", () => {
  assert.equal(
    resolveDelivery("image/png", 1000, { ...base, modalities: undefined }).delivery,
    "link",
  );
});

test("a profile with NO catalog defers to the agent — the carve-out", () => {
  // Claude Code on its own login is the most capable image path there is, and
  // `defaultProfileFor` ships no catalog precisely to mean "defer to the agent".
  assert.equal(
    resolveDelivery("image/png", 1000, { ...base, modalities: undefined, hasCatalog: false })
      .delivery,
    "image",
  );
});

test("audio follows the same shape", () => {
  assert.equal(resolveDelivery("audio/wav", 1000, base).delivery, "audio");
  assert.equal(
    resolveDelivery("audio/wav", 1000, { ...base, caps: { image: true } }).delivery,
    "link",
  );
});

test("text-ish content is embedded when the agent takes embedded context", () => {
  assert.equal(resolveDelivery("text/plain", 100, base).delivery, "resource");
  assert.equal(resolveDelivery("application/json", 100, base).delivery, "resource");
  assert.equal(
    resolveDelivery("text/plain", 100, { ...base, caps: { image: true } }).delivery,
    "link",
  );
});

test("a PDF always lands on the link branch", () => {
  // ACP has no `document` content block, and a path is what an agent with a
  // Read tool actually wants.
  assert.equal(resolveDelivery("application/pdf", 100, base).delivery, "link");
});

test("isTextish takes the suffixes and refuses a binary type", () => {
  assert.equal(isTextish("application/ld+json"), true);
  assert.equal(isTextish("image/svg+xml"), false);
  assert.equal(isTextish("application/octet-stream"), false);
});

console.log("pastes");

test("the threshold is either/or", () => {
  assert.equal(isLongPaste("https://example.com/a/fairly/long/url"), false);
  assert.equal(isLongPaste("x".repeat(1200)), true);
  assert.equal(isLongPaste("line\n".repeat(12)), true);
  assert.equal(isLongPaste("line\n".repeat(5)), false);
});

test("a body is expanded where its token sits", () => {
  const paste = mintPaste([], "hello\nworld");
  const text = `look at ${pasteToken(paste.n)} please`;
  const out = expandPastes(text, [paste]);
  assert.equal(out, "look at \n```\nhello\nworld\n```\n please");
});

test("the fence is computed so a pasted fence cannot close it early", () => {
  const paste = mintPaste([], "```\ncode\n```");
  const out = expandPastes(pasteToken(paste.n), [paste]);
  assert.match(out, /````\n```\ncode\n```\n````/);
});

test("a token the user deleted drops its body", () => {
  const paste = mintPaste([], "x".repeat(2000));
  assert.equal(expandPastes("nothing here", [paste]), "nothing here");
  assert.deepEqual(livePastes("nothing here", [paste]), []);
});

test("numbering is stable, not positional", () => {
  const one = mintPaste([], "a".repeat(2000));
  const two = mintPaste([one], "b".repeat(2000));
  const three = mintPaste([one, two], "c".repeat(2000));
  const text = `${pasteToken(1)} ${pasteToken(2)} ${pasteToken(3)}`;
  const after = dropPaste(text, [one, two, three], 2);
  assert.deepEqual(after.pastes.map((p) => p.n), [1, 3]);
  assert.equal(after.text.includes(pasteToken(2)), false);
  assert.equal(after.text.includes(pasteToken(3)), true);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
