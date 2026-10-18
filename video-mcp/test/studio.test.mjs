// The studio: composition layout, export ranges, scaffold, render.mjs (protocol + one real still + one tiny real media render)
// and Studio's lifecycle. Run after `pnpm build`. Remotion-backed parts skip with a message when it does not resolve.
// Everything runs on temp dirs and generated media; Studio is bounded and killed in finally.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { buildStudioProps } from "../dist/pipeline.js";
import { exportRange, scaffoldStudio, sceneStills } from "../dist/scaffold.js";
import { startStudio, stopStudio, studioStatus } from "../dist/remotion.js";
import { videoPaths } from "../dist/storyboard.js";
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { spawnRender } from "../dist/remotion.js";
import { makeStudio } from "./studio-fixture.mjs";

const tl = {
  title: "Demo", width: 1280, height: 720, fps: 30, durationMs: 6000, video: { path: "/v/cap.webm" },
  clips: [
    { stepId: "a", startMs: 0, endMs: 2000, chapter: "First", keys: [100, 300], audio: { path: "/t/x.mp3", durationMs: 1500 }, caption: "hi", zoom: { x: 1, y: 2, w: 640, h: 360, scale: 2 } },
    { stepId: "b", startMs: 2000, endMs: 6000 },
  ],
  captions: [{ startMs: 0, endMs: 1500, text: "hi there" }],
};
{
  const { props, stepTimes, assets } = buildStudioProps(tl);
  assert.deepEqual(props.scenes.map((s) => [s.type, s.fromMs, s.durMs, s.stepId]), [["card", 0, 2400, undefined], ["card", 2400, 1800, "a"], ["clip", 4200, 2000, "a"], ["clip", 6200, 4000, "b"]]);
  assert.deepEqual(stepTimes, { a: { startMs: 4200, endMs: 6200 }, b: { startMs: 6200, endMs: 10200 } });
  assert.equal(props.durationMs, 10200);
  assert.equal(props.video, "video.webm");
  assert.equal(props.click, "click.wav");
  assert.deepEqual(props.scenes[2].keys.map((k) => k.t), [100, 300]);
  assert.deepEqual(props.scenes[2].caption, { text: "hi there", endMs: 1500 });
  assert.deepEqual(assets, [{ name: "video.webm", from: "/v/cap.webm" }, { name: "a0.mp3", from: "/t/x.mp3" }]);
  assert.equal(buildStudioProps(tl, { typingSound: false }).props.click, undefined);

  assert.deepEqual(exportRange(props, { scene: "a" }), { from: 72, to: 185 }); // card + clip: 2400..6200 ms
  assert.deepEqual(exportRange(props, { frames: "0-30" }), { from: 0, to: 30 });
  assert.deepEqual(exportRange(props, {}), { from: 0, to: 305 });
  assert.throws(() => exportRange(props, { scene: "zz" }), /no scene/);
  assert.throws(() => exportRange(props, { frames: "0-9999" }), /outside/);
  assert.throws(() => exportRange(props, { frames: "x" }), /must look like/);
  assert.equal(sceneStills(props).length, 4);
}

const root = mkdtempSync(join(tmpdir(), "video-core-"));
let p;
try {
  const videos = join(root, ".daedalus", "videos");
  mkdirSync(videos, { recursive: true });
  symlinkSync("/var/www/daedalus-harness/.daedalus/videos/node_modules", join(videos, "node_modules"));
  p = videoPaths(root, "t1");

  // scaffold: never overwrites, reset restores src/
  mkdirSync(p.dir, { recursive: true });
  writeFileSync(p.gitignore, ".cache/\nout/");
  await scaffoldStudio(p.dir);
  assert.ok(existsSync(join(p.studioDir, "src", "Root.tsx")) && existsSync(join(p.studioDir, "scripts", "render.mjs")));
  assert.equal(JSON.parse(readFileSync(p.propsFile, "utf8")).scenes.length, 0);
  assert.equal(readFileSync(p.gitignore, "utf8"), ".cache/\nout/\nnode_modules/\nstudio/public/\nstudio/props.json\n");
  writeFileSync(join(p.studioDir, "src", "theme.ts"), "// mine\n");
  await scaffoldStudio(p.dir);
  assert.equal(readFileSync(join(p.studioDir, "src", "theme.ts"), "utf8"), "// mine\n");
  await scaffoldStudio(p.dir, { reset: true });
  assert.notEqual(readFileSync(join(p.studioDir, "src", "theme.ts"), "utf8"), "// mine\n");

  // studio: a trivial project is enough to prove start/status/stop and the loopback bind
  writeFileSync(join(p.studioDir, "src", "index.ts"), 'import { registerRoot } from "remotion";\nregisterRoot(() => null);\n');
  assert.equal((await studioStatus(p)).running, false);
  const s = await startStudio(p);
  assert.ok(s.running && s.port >= 3100 && s.port <= 3199, JSON.stringify(s));
  const [again, again2] = await Promise.all([startStudio(p), startStudio(p)]); // concurrent starts must not spawn twice
  assert.equal(again.port, s.port);
  assert.equal(again2.port, s.port);
  assert.equal((await studioStatus(p)).running, true);
  const lan = Object.values(networkInterfaces()).flat().find((i) => i.family === "IPv4" && !i.internal)?.address;
  if (lan) assert.equal(await new Promise((r) => net.connect(s.port, lan).once("connect", () => r(true)).once("error", () => r(false))), false, "Studio must not listen on the LAN");
  assert.deepEqual(await stopStudio(p), { stopped: true });
  assert.equal((await studioStatus(p)).running, false);
  assert.deepEqual(await stopStudio(p), { stopped: false });
} finally {
  if (p) await stopStudio(p).catch(() => {});
  rmSync(root, { recursive: true, force: true });
}


// ---- more layout: no title, no chapter, captions only inside their clip, typing ticks off ----
{
  const { props } = buildStudioProps({ ...tl, title: "", clips: [{ stepId: "b", startMs: 0, endMs: 1000, keys: [10] }, { stepId: "c", startMs: 1000, endMs: 2000, caption: "x" }], captions: [{ startMs: 1000, endMs: 1800, text: "late" }] });
  assert.deepEqual(props.scenes.map((s) => [s.type, s.fromMs]), [["clip", 0], ["clip", 1000]]);
  assert.equal(props.scenes[0].caption, undefined);
  assert.deepEqual(props.scenes[1].caption, { text: "late", endMs: 800 });
  assert.equal(props.scenes[0].keys.length, 1);
  assert.ok(props.scenes[0].keys[0].rate > 0 && props.scenes[0].keys[0].vol > 0);
  assert.equal(props.scenes[0].srcMs, 0);
  assert.equal(props.scenes[1].srcMs, 1000);
  assert.equal(buildStudioProps({ ...tl, clips: [{ stepId: "k", startMs: 0, endMs: 500, keys: [5] }] }, { typingSound: false }).props.scenes[1].keys, undefined);
}

// ---- render.mjs: protocol, errors, one real still, one tiny real media render ----
const fx = await makeStudio();
try {
  const render = (extra) => spawnSync(process.execPath, [join("scripts", "render.mjs"), ...extra], { cwd: fx.p.studioDir, encoding: "utf8" });
  const lines = (r) => r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l)); // every stdout line is one JSON object
  if (!fx.remotion) {
    console.log("SKIP render tests: Remotion packages do not resolve from the studio dir (see notInstalledMessage)");
  } else {
    // bad usage: one {"error"} line, exit 1, no env values
    process.env.STUDIO_TEST_SECRET = "sk-should-never-show-123456";
    const bad = render(["--mode", "nope"]);
    assert.equal(bad.status, 1);
    assert.deepEqual(Object.keys(lines(bad).at(-1)), ["error"]);
    assert.match(lines(bad).at(-1).error, /usage/);
    assert.ok(!bad.stdout.includes("sk-should-never-show") && !bad.stderr.includes("sk-should-never-show"));
    delete process.env.STUDIO_TEST_SECRET;
    await assert.rejects(spawnRender({ studioDir: fx.p.studioDir, mode: "still", propsFile: join(fx.root, "missing.json"), out: fx.p.stillsDir, frame: [0] }), /render failed: /);

    // still: one bundle, many frames; <out>/<frame>.png; frames past the end clamp to the last one
    mkdirSync(fx.p.stillsDir, { recursive: true });
    const seen = [];
    const total = fx.props.durationMs / 100; // fps 10
    const r = await spawnRender({ studioDir: fx.p.studioDir, mode: "still", propsFile: fx.p.propsFile, out: fx.p.stillsDir, frame: [5, 9999] }, (f) => seen.push(f));
    assert.equal(r.out, fx.p.stillsDir);
    assert.deepEqual(readdirSync(fx.p.stillsDir).sort(), [`${total - 1}.png`, "5.png"].sort());
    assert.equal(readFileSync(join(fx.p.stillsDir, "5.png")).subarray(1, 4).toString(), "PNG");
    assert.ok(seen.length >= 2 && seen.every((f, i) => f >= 0 && f <= 1 && (i === 0 || f >= seen[i - 1])) && seen.at(-1) === 1, `progress ${seen}`);

    // media: a short range, draft; h264 + aac from the composition's own narration (the clip starts after intro + chapter card = 42 frames)
    const out = join(fx.p.outDir, "t.mp4");
    mkdirSync(fx.p.outDir, { recursive: true });
    await spawnRender({ studioDir: fx.p.studioDir, mode: "media", propsFile: fx.p.propsFile, out, frames: { from: 45, to: 60 }, quality: "draft" });
    const pr = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,codec_type,width,height:format=duration", "-of", "json", out]).toString());
    const v = pr.streams.find((s) => s.codec_type === "video");
    assert.deepEqual([v.codec_name, v.width, v.height], ["h264", 320, 180]);
    assert.ok(pr.streams.some((s) => s.codec_type === "audio"), "narration is mixed in");
    assert.ok(Math.abs(Number(pr.format.duration) - 1.6) < 0.3, `duration ${pr.format.duration}`);
    assert.ok(statSync(out).size > 0);
  }
} finally {
  rmSync(fx.root, { recursive: true, force: true });
}
console.log("studio ok");
