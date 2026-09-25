// Self-check for attributing a turn's files when two threads share a
// repository (turn-changes.ts, `annotate`): a turn nobody overlapped is left
// alone; a path seen while only its owner ran is its own; a path written while
// a peer ran — or never seen at all — is `shared` with the peers.
// Run: pnpm test:turn-attribution
import "./require-temp-data.js";
import assert from "node:assert/strict";

const { annotate } = await import("../src/turn-changes.js");

const file = (path: string) => ({ path, status: "modified" as const, additions: 1, deletions: 0, binary: false });
const files = [file("a.ts"), file("b.ts"), file("c.ts")];

// Alone: untouched, even with nothing seen.
assert.deepEqual(annotate(files, { peers: new Set(), mine: new Set(), shared: new Map() }), files);

// Overlapped by thread "t2": a.ts written alone, b.ts while t2 ran, c.ts unseen.
const out = annotate(files, {
  peers: new Set(["t2"]),
  mine: new Set(["a.ts"]),
  shared: new Map([["b.ts", new Set(["t2"])]]),
});
assert.equal(out[0].shared, undefined);
assert.deepEqual(out[1].shared, ["t2"]);
assert.deepEqual(out[2].shared, ["t2"]);

// Overflow: everything is shared.
const flood = annotate(files, { peers: new Set(["t2"]), mine: new Set(["a.ts"]), shared: new Map([["*", new Set(["t2"])]]) });
assert.ok(flood.every((f) => f.shared?.[0] === "t2"));

console.log("turn-attribution ok");
process.exit(0);
