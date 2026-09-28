// Self-check for the hook gate (pause-hooks.ts): an open thread's hook is
// answered at once, a paused one's is answered only on resume — and always with
// `{}`, never a refusal, because a refused step hook ends the turn — and a
// wrong key is a 404.
// Run: pnpm test:pause-hooks
import assert from "node:assert/strict";
import test from "node:test";
import { configurePauseHooks, handlePauseHook, pauseHookUrlFor, setPauseGate } from "../src/pause-hooks.js";

configurePauseHooks({ port: 1 });
const call = (url: string) => handlePauseHook(new Request(url, { method: "POST", body: "{}" }));

test("an open thread's hook answers at once", async () => {
  const res = await call(pauseHookUrlFor("t1"));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {});
});

test("a paused thread's hook waits for the resume", async () => {
  setPauseGate("t2", true);
  let answered = false;
  const pending = call(pauseHookUrlFor("t2")).then((r) => ((answered = true), r));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(answered, false);
  setPauseGate("t2", false);
  assert.deepEqual(await (await pending).json(), {});
  // Other threads were never held.
  assert.equal((await call(pauseHookUrlFor("t3"))).status, 200);
});

test("a wrong key is not ours", async () => {
  const url = pauseHookUrlFor("t1").replace(/\/ph\/[^/]+/, "/ph/nope");
  assert.equal((await call(url)).status, 404);
});
