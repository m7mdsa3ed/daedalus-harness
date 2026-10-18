// Capture provider checks against the local fixture. Needs `pnpm build` and a Chrome (see config.findChrome).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { playwrightCapture } from "../dist/providers/capture/playwright.js";
import { normalizeAction, toPlaywrightSelector } from "../dist/providers/capture/actions.js";
import { importRecorder } from "../dist/recorder-import.js";
import { serveFixture } from "./fixture/serve.mjs";
import { urlRefusal } from "../dist/providers/capture/playwright.js";

// pure: selector translation and both dialects
assert.equal(toPlaywrightSelector('aria/New task[role="button"]'), 'role=button[name="New task"i]');
assert.equal(toPlaywrightSelector("aria/Hello"), 'text="Hello"');
assert.equal(toPlaywrightSelector("xpath//html/body/a"), "xpath=/html/body/a");
assert.equal(toPlaywrightSelector("#x"), "css=#x");
assert.deepEqual(normalizeAction({ type: "click", selectors: [["aria/New task"], ["#new"]] }).loc, ['text="New task"', "css=#new"]);
assert.deepEqual(normalizeAction({ action: "click", selector: "#new" }), { kind: "click", loc: ["css=#new"] });
assert.equal(normalizeAction({ type: "setViewport", width: 1, height: 1 }).kind, "noop");
assert.equal(normalizeAction({ type: "teleport" }).kind, "unknown");

const sb = importRecorder({ title: "Rec", steps: [
  { type: "setViewport", width: 1000, height: 600 },
  { type: "navigate", url: "http://localhost:3000/app?x=1" },
  { type: "click", selectors: [["#go"]] },
] }, "rec");
assert.deepEqual(sb.viewport, { width: 1000, height: 600 });
assert.equal(sb.baseUrl, "http://localhost:3000");
assert.deepEqual(sb.steps.map((s) => s.id), ["s1", "s2"]);
assert.equal(sb.steps[0].do.url, "/app?x=1");
assert.throws(() => importRecorder({ nope: 1 }, "x"), /not a Recorder export/);

// goto targets: http(s) only, link-local never, file: only on request, localhost fine
delete process.env.VIDEO_ALLOW_FILE_URLS;
for (const u of ["file:///etc/hosts", "ftp://x/", "javascript:alert(1)", "http://169.254.169.254/latest", "http://[fe80::1]/", "http://[::ffff:169.254.169.254]/", "http://metadata.google.internal/", "http://2852039166/"]) {
  assert.ok(await urlRefusal(u), `refused: ${u}`);
}
for (const u of ["http://127.0.0.1:3000/", "http://localhost:3000/x", "http://10.0.0.5/", "https://example.com/"]) {
  assert.equal(await urlRefusal(u), undefined, `allowed: ${u}`);
}
process.env.VIDEO_ALLOW_FILE_URLS = "1";
assert.equal(await urlRefusal("file:///etc/hosts"), undefined);
assert.ok(await urlRefusal("http://169.254.169.254/"), "metadata is refused even with file urls on");
delete process.env.VIDEO_ALLOW_FILE_URLS;

// real capture
const fx = await serveFixture();
const dir = await mkdtemp(join(tmpdir(), "vm-cap-"));
try {
  const storyboard = { version: 1, title: "t", baseUrl: fx.url, viewport: { width: 960, height: 540 }, steps: [] };
  const wall = Date.now();
  const r = await playwrightCapture.capture({
    storyboard, dir,
    steps: [
      { id: "open", minDurationMs: 1200, actions: [{ action: "goto", url: "/" }] },
      { id: "add", minDurationMs: 2500, zoom: { selector: "#list" }, actions: [
        { type: "click", selectors: [["aria/New task[role=\"button\"]"], ["#new"]] },
        { action: "fill", selector: "#title", value: "Ship the demo" },
        { type: "click", selectors: [["#add"]] },
      ] },
      { id: "missing", minDurationMs: 800, actions: [{ action: "click", selector: "#does-not-exist" }, { type: "teleport" }] },
      { id: "scroll", minDurationMs: 1500, zoom: true, actions: [{ action: "scroll", selector: "#footer-card" }] },
      { id: "flash", minDurationMs: 2500, actions: [{ action: "scroll", y: 0 }, { action: "click", selector: "#flash" }] },
      { id: "after", minDurationMs: 600, actions: [] },
    ],
  });
  const took = Date.now() - wall;
  console.log("took", took, "ms; video", r.durationMs, "ms", r.width + "x" + r.height, "@" + r.fps, "marks", JSON.stringify(r.marks.map((m) => [m.stepId, m.startMs, m.endMs])));
  assert.equal(r.width, 960);
  assert.equal(r.marks.length, 6);
  assert.equal(r.marks[0].startMs, 0);
  r.marks.forEach((m, i) => {
    assert.ok(m.endMs > m.startMs, `${m.stepId} has length`);
    if (i) assert.equal(m.startMs, r.marks[i - 1].endMs, "contiguous");
  });
  assert.ok(r.marks[1].endMs - r.marks[1].startMs >= 2500, "step honours minDurationMs");
  assert.ok(r.marks[5].endMs <= r.durationMs, "marks within the video");
  assert.ok(r.marks[1].targetRect && r.marks[1].targetRect.w > 100, "zoom.selector rect");
  assert.ok(r.marks[3].targetRect === undefined, "scroll sets no zoom target");
  assert.deepEqual(r.marks[0].warnings, []);
  assert.deepEqual(r.marks[1].warnings, []);
  assert.equal(r.marks[2].warnings.length, 2, "missing selector and unknown action warn: " + r.marks[2].warnings);
  assert.match(r.marks[2].warnings[0], /nothing visible matched/);
  // sync: the page turns red when #flash is clicked; that frame must fall inside the flash step
  const red = await new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", ["-v", "error", "-i", r.videoPath, "-vf", "scale=1:1,format=rgb24", "-f", "rawvideo", "-"]);
    const c = [];
    p.stdout.on("data", (d) => c.push(d));
    p.on("error", reject);
    p.on("close", () => resolve(Buffer.concat(c)));
  });
  let f = 0;
  while (f * 3 < red.length && !(red[f * 3] > 200 && red[f * 3 + 1] < 60 && red[f * 3 + 2] < 60)) f++;
  const redMs = (f / r.fps) * 1000;
  const flash = r.marks[4];
  console.log(`red frame at ${redMs}ms; flash step ${flash.startMs}-${flash.endMs}ms (click lands ${Math.round(redMs - flash.startMs)}ms in)`);
  assert.ok(redMs >= flash.startMs + 300 && redMs <= flash.endMs, "click frame sits inside its step, after the cursor glide");
  console.log("ok: capture");

  // a refused goto is a step warning, not a crash
  {
    const rr = await playwrightCapture.capture({
      storyboard, dir: await mkdtemp(join(tmpdir(), "vm-ref-")),
      steps: [
        { id: "file", minDurationMs: 300, actions: [{ action: "goto", url: "file:///etc/hosts" }] },
        { id: "meta", minDurationMs: 300, actions: [{ action: "goto", url: "http://169.254.169.254/" }] },
      ],
    });
    assert.match(rr.marks[0].warnings[0], /refused: file: URLs/);
    assert.match(rr.marks[1].warnings[0], /refused: .*link-local/);
  }

  // file provider: slices a recorded file by "at"; refuses paths outside the video folder
  const { fileCapture } = await import("../dist/providers/capture/file.js");
  const { mkdir, copyFile } = await import("node:fs/promises");
  const vid = join(dir, "vid");
  const scratch = join(vid, ".cache", "capture", "k");
  await mkdir(scratch, { recursive: true });
  await copyFile(r.videoPath, join(vid, "rec.webm"));
  const fsteps = [{ id: "one", minDurationMs: 0, actions: [], at: 500 }, { id: "two", minDurationMs: 0, actions: [], at: 4000 }, { id: "three", minDurationMs: 0, actions: [] }];
  const fr = await fileCapture.capture({ storyboard: { ...storyboard, file: "rec.webm" }, steps: fsteps, dir: scratch, videoDir: vid });
  // "three" has no "at": it shares the span from two's "at" to the file's end with two, instead of starting at the end with zero length
  const mid = Math.round((4000 + fr.durationMs) / 2);
  assert.deepEqual(fr.marks.map((m) => [m.stepId, m.startMs, m.endMs]), [["one", 500, 4000], ["two", 4000, mid], ["three", mid, fr.durationMs]]);
  assert.match(fr.marks[2].warnings[0], /timing inferred/);
  assert.equal(fr.width, 960);
  await assert.rejects(fileCapture.capture({ storyboard: { ...storyboard, file: "../../etc/passwd" }, steps: fsteps, dir: scratch, videoDir: vid }), /escapes/);
  await assert.rejects(fileCapture.capture({ storyboard, steps: fsteps, dir: scratch, videoDir: vid }), /needs a "file"/);
  console.log("ok: file capture");
} finally {
  await fx.close();
  await rm(dir, { recursive: true, force: true });
}
