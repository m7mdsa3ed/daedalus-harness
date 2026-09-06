// Self-check for the embedded-editor proxy's path parsing and for the status
// the API hands back when no editor is running.
//
// `parseIdePath` is the whole authorization boundary for `/ide/*`: it is what
// turns a URL into a loopback port, and it runs *before* the bearer-token check
// on the WebSocket upgrade path (the key in the path is that request's
// credential — see src/ide.ts). So the cases worth pinning are the ones where a
// sloppy parse would hand out a port: a missing key, a key with a traversal
// segment in it, and the difference between the prefix itself and a request
// underneath it.
// Run: pnpm test:ide
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";

const DATA = process.env.DAEDALUS_DATA_DIR!;
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });

const { parseIdePath } = await import("../src/ide-proxy.js");
const { ideTarget } = await import("../src/ide.js");

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

await test("a path under the prefix splits into key and remainder", () => {
  assert.deepEqual(parseIdePath("/ide/abc123/static/out/vs/workbench.js"), {
    key: "abc123",
    rest: "/static/out/vs/workbench.js",
  });
});

await test("the prefix itself parses with an empty remainder", () => {
  // Which is what the proxy turns into the 308 onto the trailing slash: without
  // it every relative asset resolves one level too high and the key falls off.
  assert.deepEqual(parseIdePath("/ide/abc123"), { key: "abc123", rest: "" });
  assert.deepEqual(parseIdePath("/ide/abc123/"), { key: "abc123", rest: "/" });
});

await test("paths outside the prefix are not ours", () => {
  for (const path of ["/", "/api/health", "/ws", "/idea/x", "/ide", "/ide/"]) {
    assert.equal(parseIdePath(path), null, path);
  }
});

await test("a traversal segment stays inside the key, where it resolves to nothing", () => {
  // `..` cannot climb out of the prefix because the key is a whole path
  // segment, not a string that gets concatenated: the segment IS the lookup,
  // and no instance is ever registered under it.
  const parsed = parseIdePath("/ide/../api/health");
  assert.equal(parsed?.key, "..");
  assert.equal(ideTarget("..") , null, "no instance answers to a traversal key");
});

await test("an unknown key names no editor", () => {
  assert.equal(ideTarget("nope"), null);
});

await test("status for an unknown project is refused, not answered", async () => {
  const { ideStatus } = await import("../src/ide.js");
  assert.throws(() => ideStatus("no-such-project"), /unknown project/);
});

if (failures.length) {
  console.error("ide.test.ts FAILED\n" + failures.join("\n\n"));
  process.exit(1);
}
console.log(`ide: ${passed} passed`);
