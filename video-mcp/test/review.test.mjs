// The contact sheet from stills (no mp4 needed): a generated studio + a hand-written build.json. Run after `pnpm build`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { reviewVideo, wrap } from "../dist/tools/review.js";
import { makeStudio } from "./studio-fixture.mjs";

assert.deepEqual(wrap("a b c", 10, 2), ["a b c"]);
assert.equal(wrap("word ".repeat(100), 20, 3).length, 3);
assert.match(wrap("word ".repeat(100), 20, 3)[2], /…$/);

const fx = await makeStudio("demo");
try {
  if (!fx.remotion) console.log("SKIP review: Remotion packages do not resolve");
  else {
    const { p, root: cwd, props } = fx;
    const nasty = `it's "quoted": 100% %{pts} \\ ; [x] ${"long ".repeat(60)}`;
    writeFileSync(p.storyboard, JSON.stringify({ version: 1, title: "t", steps: [{ id: "a", say: nasty }, { id: "b" }] }));
    // step timings are the composition's: the intro and chapter cards shift step a to 4.2s
    const clip = (id) => props.scenes.find((s) => s.type === "clip" && s.stepId === id);
    const step = (id, tts, audioMs, warnings = []) => ({ id, tts, audioMs, startMs: clip(id).fromMs, endMs: clip(id).fromMs + clip(id).durMs, warnings });
    writeFileSync(p.buildFile, JSON.stringify({
      startedAtIso: "2026-01-01T00:00:00Z", providers: { capture: "playwright", tts: "silent" },
      perStep: [step("a", "hit", 2500, ["selector not found: #x"]), step("b", "none", 0)],
      capture: "miss", durationMs: props.durationMs, studio: { running: false }, warnings: [],
      totals: { steps: 2, durationMs: props.durationMs, audioMs: 2500, ttsHits: 1, ttsMisses: 0 },
    }));

    const r = await reviewVideo({ cwd, name: "demo" });
    assert.equal(r.contactSheetPath, p.contactSheet);
    assert.ok(statSync(r.contactSheetPath).size > 5000);
    const png = readFileSync(r.contactSheetPath);
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    assert.ok(png.readUInt32BE(16) <= 2000, "sheet width");
    const rep = JSON.parse(readFileSync(r.reportPath, "utf8"));
    assert.equal(rep.durationMs, props.durationMs);
    // one cell per scene: intro, chapter card, clip a, clip b
    assert.deepEqual(rep.scenes.map((s) => [s.type, s.kind, s.stepId]), [["card", "intro", undefined], ["card", "chapter", "a"], ["clip", undefined, "a"], ["clip", undefined, "b"]]);
    assert.deepEqual(rep.steps.map((s) => [s.id, s.startMs, s.stepMs]), [["a", 4200, 1500], ["b", 5700, 1500]]);
    assert.equal(rep.steps[0].audioLongerThanStep, true);
    assert.equal(rep.steps[0].ttsCache, "hit");
    assert.ok(rep.warnings.some((w) => /selector not found/.test(w)));
    assert.ok(rep.warnings.some((w) => /longer than the step/.test(w)));
    assert.equal(rep.firstFrameBlank, false); // testsrc is not flat
    assert.ok(existsSync(p.stillsDir));

    // stepIds filter: that step's chapter card and clip, the intro dropped, real index kept
    const one = await reviewVideo({ cwd, name: "demo", stepIds: ["b"] });
    assert.deepEqual(one.report.scenes.map((s) => s.stepId), ["b"]);
    assert.equal(one.report.steps[0].index, 2);
    await assert.rejects(reviewVideo({ cwd, name: "demo", stepIds: ["nope"] }), /unknown step id/);
    await assert.rejects(reviewVideo({ cwd, name: "missing" }), /no build/);
    // a placeholder props.json (scenes: []) is "no build yet"
    writeFileSync(p.propsFile, JSON.stringify({ ...props, scenes: [] }));
    await assert.rejects(reviewVideo({ cwd, name: "demo" }), /no build/);
    console.log("review ok");
  }
} finally {
  rmSync(fx.root, { recursive: true, force: true });
}
