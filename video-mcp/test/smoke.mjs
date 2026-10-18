// Fast checks on the pure parts. Run after `pnpm build` (npm test builds nothing).
import assert from "node:assert/strict";
import { inside, parseStoryboard, validateName } from "../dist/storyboard.js";
import { buildTimeline } from "../dist/timeline.js";
import { childEnv, redact, run } from "../dist/exec.js";
import { readFileSync as readSync, mkdtempSync as mkTmp, writeFileSync as writeSync } from "node:fs";
import { tmpdir as tmp } from "node:os";
import { join as pjoin } from "node:path";

const sb = parseStoryboard({
  version: 1,
  title: "t",
  steps: [
    { id: "a", say: "hello there", do: [{ type: "navigate", url: "/" }, { type: "click", selectors: [["#x"]], target: "main" }, { action: "wait", ms: 5 }], zoom: { scale: 2 } },
    { id: "b", overlay: { text: "hi" } },
  ],
});
assert.deepEqual(sb.viewport, { width: 1280, height: 720 });
assert.throws(() => parseStoryboard({ version: 1, title: "t", steps: [{ id: "a" }, { id: "a" }] }), /duplicate step id/);
assert.throws(() => parseStoryboard({ version: 1, title: "t", steps: [{ id: "a", do: { action: "clik", selector: "x" } }] }), /invalid action/);
assert.throws(() => validateName("../x"));
assert.throws(() => inside("/tmp/x", "../y"), /escapes/);

const { timeline, warnings } = buildTimeline(
  { videoPath: "/v.webm", width: 1280, height: 720, fps: 25, durationMs: 5000, warnings: [], marks: [
    { stepId: "a", startMs: 0, endMs: 2000, targetRect: { x: 1200, y: 10, w: 50, h: 20 }, warnings: [] },
    { stepId: "b", startMs: 2000, endMs: 5000, warnings: [] },
  ] },
  [
    { step: sb.steps[0], audio: { path: "/a.mp3", durationMs: 2500, words: [{ text: "hello", startMs: 0, endMs: 300 }, { text: "there", startMs: 300, endMs: 600 }] } },
    { step: sb.steps[1] },
  ],
);
assert.deepEqual(timeline.clips[0].zoom, { x: 640, y: 0, w: 640, h: 360, scale: 2 }); // clamped to the frame
assert.deepEqual(timeline.captions, [{ startMs: 0, endMs: 600, text: "hello there" }]);
assert.match(warnings.a[0], /longer than the step/);
assert.equal(timeline.clips[1].overlay.position, "bottom");

// ---- exec: credentials never reach a child, nor a message ----
{
  const saved = { ...process.env };
  Object.assign(process.env, { HARNESS_URL: "http://127.0.0.1:1/hm/loopkey-123456/sess1", VIDEO_TTS_API_KEY: "tts-key-abcdef", ELEVENLABS_API_KEY: "el-key-abcdef", VIDEO_TTS_BASE_URL: "https://user:pw-secret-1@tts.example/v1?token=qtoken-123456" });
  assert.deepEqual(Object.keys(childEnv()).filter((k) => /^(HARNESS_URL|VIDEO_TTS_API_KEY|ELEVENLABS_API_KEY|VIDEO_TTS_BASE_URL)$/.test(k)), []);
  const printed = await run("sh", ["-c", "env"]);
  assert.ok(!/loopkey|tts-key|el-key|qtoken|pw-secret/.test(printed.stdout), "no credential in a child's env");
  for (const leak of ["see http://x/hm/loopkey-123456/sess1/api", "HARNESS_URL=http://127.0.0.1:1/hm/loopkey-123456/sess1", "pw-secret-1@tts.example", "?token=qtoken-123456", "tts-key-abcdef"]) {
    assert.ok(!/loopkey|pw-secret|qtoken|tts-key/.test(redact(leak)), `redacted: ${leak}`);
  }
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
}

// ---- exec: a timeout or abort takes the whole process group, even a grandchild that ignores SIGTERM ----
{
  const dir = mkTmp(pjoin(tmp(), "exec-"));
  const alive = (pid) => {
    try { return !/^\d+ \(.*\) Z/.test(readSync(`/proc/${pid}/stat`, "utf8")); } catch { return false; }
  };
  const spawnTree = async (name, opts) => {
    const pidFile = pjoin(dir, name);
    // the sleep inherits the ignored SIGTERM, so only the group SIGKILL can stop it
    const p = run("sh", ["-c", `trap '' TERM; sleep 300 & echo $! > ${pidFile}; wait`], { killGraceMs: 300, ...opts.run });
    opts.after?.();
    await assert.rejects(p, opts.err);
    const pid = Number(readSync(pidFile, "utf8"));
    for (let i = 0; i < 20 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(!alive(pid), `${name}: grandchild ${pid} is gone`);
  };
  await spawnTree("timeout", { run: { timeoutMs: 400 }, err: /timed out/ });
  const ac = new AbortController();
  await spawnTree("abort", { run: { signal: ac.signal }, after: () => setTimeout(() => ac.abort(), 400), err: /aborted/ });
  await assert.rejects(run("sleep", ["1"], { signal: ac.signal }), /aborted/, "an already-aborted signal never spawns");
}


// ---- pipeline internals: locks, cache keys, jobs, assets, file capture (no browser) -------------------------------
{
  const { enforceLocks, captureKey, chromeIdentity, build: buildVideo } = await import("../dist/pipeline.js");
  const { acquireBuildLock } = await import("../dist/cache.js");
  const { startJob, getJob } = await import("../dist/jobs.js");
  const { videoPaths } = await import("../dist/storyboard.js");
  const { CAPTURE } = await import("../dist/providers/registry.js");
  const { GITIGNORE } = await import("../dist/storyboard.js");
  const { fileCapture } = await import("../dist/providers/capture/file.js");
  const { captureOffsetMs } = await import("../dist/config.js");
  const { mkdirSync, writeFileSync: wf, readFileSync: rf, readdirSync: ls, mkdtempSync: mkt, rmSync: rm } = await import("node:fs");
  const { spawnSync } = await import("node:child_process");
  const tmp = mkt(join(tmpdir(), "vmcp-pipe-"));
  try {
    const mkSb = (steps, extra = {}) => parseStoryboard({ version: 1, title: "t", steps, ...extra });

    // 4. locked step ids that collide with Object.prototype members
    const lp = videoPaths(tmp, "locks");
    mkdirSync(lp.cacheDir, { recursive: true });
    await enforceLocks(lp, mkSb([{ id: "constructor", say: "one", locked: true }])); // used to be "already recorded" and never stored
    assert.deepEqual(Object.keys(JSON.parse(rf(lp.lockedFile, "utf8"))), ["constructor"]);
    await assert.rejects(enforceLocks(lp, mkSb([{ id: "constructor", say: "two", locked: true }])), /"constructor" was edited/);
    await enforceLocks(lp, mkSb([{ id: "__proto__", say: "one", locked: true }, { id: "constructor", say: "one", locked: true }]));
    assert.ok(Object.hasOwn(JSON.parse(rf(lp.lockedFile, "utf8")), "__proto__"), "__proto__ id is recorded as data");
    await assert.rejects(enforceLocks(lp, mkSb([{ id: "__proto__", say: "edited", locked: true }, { id: "constructor", say: "one", locked: true }])), /"__proto__" was edited/);
    await assert.rejects(enforceLocks(lp, mkSb([{ id: "constructor", say: "one", locked: true }])), /"__proto__" was removed/);

    // 3. one build per video across processes
    const bp = videoPaths(tmp, "busy");
    const holder = (pid, jobId) => ({ pid, jobId, startedAtIso: "2026-01-01T00:00:00Z" });
    const rel1 = acquireBuildLock(bp, holder(process.pid, "job-one-aaaa"));
    assert.throws(() => acquireBuildLock(bp, holder(process.pid, "job-two-bbbb")), /already running.*job-one-aaaa/);
    assert.throws(() => startJob(bp, "build", "2026-01-01T00:00:00Z", async () => ({})), /job-one-aaaa/); // the video_build door
    // jobs are per kind: an export neither takes nor waits on the build lock, a second of its own kind is refused
    let finish;
    const exp = startJob(bp, "export", "2026-01-01T00:00:00Z", (progress) => { progress("export", 0.5); return new Promise((r) => (finish = r)); }, "draft");
    assert.throws(() => startJob(bp, "export", "2026-01-01T00:00:00Z", async () => ({})), /export of "busy" is already running/);
    const running = await getJob(tmp, exp);
    assert.deepEqual([running.kind, running.quality, running.status, running.stage, running.progress], ["export", "draft", "running", "export", 0.5]);
    finish({ path: "x.mp4" });
    for (let i = 0; i < 50 && (await getJob(tmp, exp)).status === "running"; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual([(await getJob(tmp, exp)).status, (await getJob(tmp, exp)).result], ["done", { path: "x.mp4" }]);
    const failed = startJob(bp, "export", "2026-01-01T00:00:00Z", async () => { throw new Error("boom http://127.0.0.1:9/hm/LOOPKEY123/s"); });
    for (let i = 0; i < 50 && (await getJob(tmp, failed)).status === "running"; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal((await getJob(tmp, failed)).status, "failed");
    assert.ok(!(await getJob(tmp, failed)).error.includes("LOOPKEY123"), "job errors are redacted");
    assert.ok(ls(bp.cacheDir).includes("build.lock"), "the build lock is still the build's");
    rel1();
    const rel2 = acquireBuildLock(bp, holder(process.pid, "job-two-bbbb")); // released, so free again
    rel2();
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout; // exited: its pid is dead
    wf(join(bp.cacheDir, "build.lock"), JSON.stringify(holder(Number(dead), "job-dead-cccc")));
    const rel3 = acquireBuildLock(bp, holder(process.pid, "job-three-dd")); // dead holder: taken over
    assert.equal(JSON.parse(rf(join(bp.cacheDir, "build.lock"), "utf8")).jobId, "job-three-dd");
    rel3();
    assert.ok(!ls(bp.cacheDir).includes("build.lock"));

    // 5. capture cache key
    const base = { providerId: "playwright", quality: "draft", sb: { viewport: { width: 1280, height: 720 }, baseUrl: "http://x" }, offsetMs: 0, chrome: "/c:1:2",
      steps: [{ id: "a", minDurationMs: 1000, actions: [], zoom: { scale: 2 } }, { id: "b", minDurationMs: 1000, actions: [] }] };
    const k0 = captureKey(base);
    const withZoom = (z) => ({ ...base, steps: [{ ...base.steps[0], zoom: z }, base.steps[1]] });
    assert.equal(captureKey(withZoom({ scale: 3 })), k0, "zoom.scale is applied in the timeline, not at capture");
    assert.equal(captureKey(withZoom(true)), k0);
    assert.notEqual(captureKey(withZoom({ selector: "#x", scale: 2 })), k0, "the selector decides targetRect");
    assert.notEqual(captureKey(withZoom(undefined)), k0, "zoom presence");
    assert.notEqual(captureKey({ ...base, offsetMs: 40 }), k0);
    assert.notEqual(captureKey({ ...base, chrome: "/c:1:3" }), k0);
    assert.notEqual(captureKey({ ...base, quality: "final" }), k0);
    const was = process.env.VIDEO_CAPTURE_OFFSET_MS;
    process.env.VIDEO_CAPTURE_OFFSET_MS = "40";
    assert.notEqual(captureKey({ ...base, offsetMs: captureOffsetMs(Number.NaN) }), captureKey({ ...base, offsetMs: 0 }));
    if (was === undefined) delete process.env.VIDEO_CAPTURE_OFFSET_MS;
    else process.env.VIDEO_CAPTURE_OFFSET_MS = was;
    assert.equal(typeof chromeIdentity(), "string");
    // ...and a zoom.scale change does show up at the render stage: same capture, different crop window
    const cap = { videoPath: "/v.webm", width: 1280, height: 720, fps: 25, durationMs: 4000, warnings: [], marks: [{ stepId: "a", startMs: 0, endMs: 4000, targetRect: { x: 600, y: 300, w: 50, h: 20 }, warnings: [] }] };
    const zoomOf = (z) => buildTimeline(cap, [{ step: mkSb([{ id: "a", zoom: z }]).steps[0] }]).timeline.clips[0].zoom;
    assert.notDeepEqual(zoomOf({ scale: 2 }), zoomOf({ scale: 3 }));

    // 6. file capture: a 10 s file and three steps with no "at" share it evenly instead of piling up at the end
    const fp = videoPaths(tmp, "filecap");
    mkdirSync(fp.dir, { recursive: true });
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:size=160x90:rate=10", "-t", "10", "-c:v", "libvpx", join(fp.dir, "rec.webm")]);
    const fsb = mkSb([{ id: "a" }, { id: "b" }, { id: "c" }], { file: "rec.webm" });
    const spec = (ids) => ids.map((id) => ({ id, minDurationMs: 0, actions: [] }));
    const fr = await fileCapture.capture({ storyboard: fsb, steps: spec(["a", "b", "c"]), dir: fp.captureDir, videoDir: fp.dir });
    assert.ok(fr.durationMs >= 9900);
    assert.deepEqual(fr.marks.map((m) => m.endMs - m.startMs > 3000), [true, true, true]);
    assert.equal(fr.marks[0].startMs, 0);
    assert.equal(fr.marks[1].startMs, fr.marks[0].endMs);
    assert.equal(fr.marks[2].startMs, fr.marks[1].endMs);
    assert.equal(fr.marks[2].endMs, fr.durationMs);
    assert.match(fr.marks[1].warnings.join(" "), /timing inferred/);
    assert.match(fr.warnings.join(" "), /inferred/);
    const fr2 = await fileCapture.capture({ storyboard: fsb, steps: [{ ...spec(["a"])[0], at: 2000 }, ...spec(["b", "c"])], dir: fp.captureDir, videoDir: fp.dir });
    assert.deepEqual(fr2.marks.map((m) => m.startMs), [2000, 2000 + Math.round((fr2.durationMs - 2000) / 3), 2000 + Math.round(((fr2.durationMs - 2000) * 2) / 3)]);

    // 2. build() without Remotion installed (tmp has no node_modules): assets + props are written, Studio is a warning not a failure,
    //    and no mp4 is rendered. A failed capture leaves the last good props.json alone.
    const ap = videoPaths(tmp, "assets");
    mkdirSync(ap.dir, { recursive: true });
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=10", "-t", "2", "-c:v", "libvpx", join(ap.dir, "rec.webm")]);
    const asb = (say, extra = {}) => wf(ap.storyboard, JSON.stringify({ version: 1, title: "t", file: "rec.webm", providers: { capture: "file", tts: "silent" }, steps: [{ id: "a", say }], ...extra }));
    asb("first");
    const args = { cwd: tmp, name: "assets", startedAtIso: "2026-01-01T00:00:00Z" };
    const good = await buildVideo(args);
    assert.equal(good.studio.running, false);
    assert.match(good.warnings.join("\n"), /Studio is not running/);
    const props = JSON.parse(rf(ap.propsFile, "utf8"));
    assert.deepEqual(props.scenes.map((x) => [x.type, x.fromMs]), [["card", 0], ["clip", 2400]]);
    assert.equal(good.perStep[0].startMs, 2400, "step timings are the composition's");
    assert.ok(ls(ap.publicDir).includes(props.video), "the capture is under public/");
    assert.ok(ls(ap.studioDir).includes("package.json"), "studio scaffolded");
    assert.deepEqual(ls(ap.outDir).filter((f) => f.endsWith(".mp4")), [], "a build renders no mp4");
    assert.equal(rf(ap.gitignore, "utf8"), GITIGNORE);
    assert.deepEqual(JSON.parse(rf(ap.buildFile, "utf8")).totals, good.totals);
    const goodProps = rf(ap.propsFile, "utf8");
    asb("second", { file: "gone.webm" });
    await assert.rejects(buildVideo(args));
    assert.equal(rf(ap.propsFile, "utf8"), goodProps, "a failed build keeps the last good props");

    // 3. build.json is scrubbed: a provider warning that quotes the loopback URL does not reach the report
    process.env.HARNESS_URL = "http://127.0.0.1:9/hm/LOOPKEY123/sess";
    const realCap = CAPTURE.file;
    CAPTURE.file = { ...realCap, capture: async (i) => ({ ...(await realCap.capture(i)), warnings: ["upload via http://127.0.0.1:9/hm/LOOPKEY123/sess failed"] }) };
    try {
      asb("third");
      const scrubbed = await buildVideo(args);
      assert.ok(scrubbed.warnings.length && !JSON.stringify(scrubbed).includes("LOOPKEY123") && !rf(ap.buildFile, "utf8").includes("LOOPKEY123"));
    } finally {
      CAPTURE.file = realCap;
      delete process.env.HARNESS_URL;
    }
  } finally {
    rm(tmp, { recursive: true, force: true });
  }
}
console.log("smoke ok");

// ---- end to end, through the MCP server over stdio ---------------------------------------------
// Real Chromium (the local fixture page), real Remotion (stills, one scene export, Studio) when it resolves, silent + mocked
// openai-compatible TTS, mocked Files routes. A build starts Studio: it is stopped through the tool and again in finally.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { serveFixture } from "./fixture/serve.mjs";
import { missingRemotionPackages, stopStudio } from "../dist/remotion.js";
import { videoPaths } from "../dist/storyboard.js";
import { GITIGNORE } from "../dist/storyboard.js";
import { SHARED_MODULES } from "./studio-fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");
const SECRETS = ["sk-secret-test-key-123456", "el-secret-test-key-654321"];
const cwd = mkdtempSync(join(tmpdir(), "video-mcp-e2e-"));
// Remotion resolves by the upward node_modules search; the project gets the shared install.
mkdirSync(join(cwd, ".daedalus", "videos"), { recursive: true });
symlinkSync(SHARED_MODULES, join(cwd, ".daedalus", "videos", "node_modules"));
const REMOTION = missingRemotionPackages(join(cwd, ".daedalus", "videos")).length === 0;
if (!REMOTION) {
  console.log("SKIP e2e: Remotion packages do not resolve from the project (video_init refuses without them)");
  rmSync(cwd, { recursive: true, force: true });
  process.exit(0);
}
const seen = []; // every tool result, scanned for secrets at the end
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mock Files routes, behind the same /hm/<key>/<session> prefix the harness loopback uses.
const rows = [];
const uploads = [];
let seq = 0;
const files = createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const send = (code, o) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(o));
  const path = u.pathname.replace(/^\/hm\/k\/s/, "");
  const parent = u.searchParams.get("parent") || null;
  if (req.method === "GET" && path === "/api/files") return send(200, { items: rows.filter((r) => r.parentId === parent) });
  if (req.method === "POST" && path === "/api/files/folder") {
    const b = JSON.parse(body.toString());
    const row = { id: `f${++seq}`, parentId: b.parentId, kind: "folder", name: b.name };
    rows.push(row);
    return send(201, row);
  }
  if (req.method === "POST" && path === "/api/files") {
    const row = { id: `f${++seq}`, parentId: parent, kind: "file", name: decodeURIComponent(req.headers["x-filename"]) };
    rows.push(row);
    uploads.push({ body, type: req.headers["content-type"], row });
    return send(201, row);
  }
  send(404, { error: "no such route" });
});
const harnessUrl = `http://127.0.0.1:${await listen(files)}/hm/k/s`;

// Mock OpenAI /v1/audio/speech: a real 1.5 s mp3; "FAIL" lines get a 500 that echoes the Authorization header.
const mp3 = join(cwd, "tone.mp3");
execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1.5", "-y", mp3]);
const speech = [];
const tts = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const b = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  speech.push({ url: req.url, auth: req.headers.authorization, body: b });
  if (/FAIL/.test(b.input)) return void res.writeHead(500).end(`upstream said no to ${req.headers.authorization}`);
  res.writeHead(200, { "content-type": "audio/mpeg" }).end(readFileSync(mp3));
});
const ttsUrl = `http://127.0.0.1:${await listen(tts)}`;
const fx = await serveFixture();

async function connect(extra = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}),
    VIDEO_TTS: "silent",
    VIDEO_TTS_API_KEY: SECRETS[0],
    ELEVENLABS_API_KEY: SECRETS[1],
    HARNESS_URL: harnessUrl,
    ...extra,
  };
  const client = new Client({ name: "smoke", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [ENTRY], cwd, env, stderr: "ignore" }));
  return client;
}

/** Calls a tool; returns { isError, text, json?, content }. */
async function tool(client, name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.find((c) => c.type === "text")?.text ?? "";
  seen.push(text);
  let json;
  try { json = JSON.parse(text); } catch {}
  return { isError: !!r.isError, text, json, content: r.content };
}

async function build(client, name, args = {}) {
  const started = await tool(client, "video_build", { name, ...args });
  assert.ok(!started.isError, started.text);
  for (let i = 0; i < 600; i++) {
    const j = (await tool(client, "video_job", { jobId: started.json.jobId })).json;
    if (j.status !== "running") return j;
    await sleep(500);
  }
  assert.fail("build did not finish in 300s");
}

const dirOf = (n) => join(cwd, ".daedalus", "videos", n);
const readSb = (n) => JSON.parse(readFileSync(join(dirOf(n), "storyboard.json"), "utf8"));
const editSb = (n, f) => { const sb = readSb(n); f(sb); writeFileSync(join(dirOf(n), "storyboard.json"), JSON.stringify(sb, null, 2)); };
const probe = (p) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "json", p]).toString());
const ttsOf = (j) => Object.fromEntries(j.result.perStep.map((s) => [s.id, s.tts]));

let client, client2;
try {
  client = await connect();
  const tools = (await client.listTools()).tools.map((t) => t.name);
  for (const t of ["video_init", "video_list", "video_import_recorder", "video_build", "video_job", "video_review", "video_providers", "video_publish", "video_studio", "video_export"]) assert.ok(tools.includes(t), `tool ${t}`);

  // providers: readiness without keys
  const prov = (await tool(client, "video_providers")).json;
  const conf = (kind, id) => prov[kind].find((p) => p.id === id);
  assert.equal(conf("capture", "playwright").configured, true, "playwright needs a Chrome");
  assert.equal(conf("tts", "silent").default, true);
  assert.equal(conf("tts", "elevenlabs").configured, true); // key present in env, value never shown
  assert.equal(conf("tts", "openai-compatible").configured, false);
  assert.equal(prov.render, undefined, "no render seam any more");
  assert.equal(prov.remotion.installed, true);
  assert.match(prov.remotion.version, /^\d+\.\d+/);
  assert.equal(prov.harness, "connected");

  // a name is a folder, never a path
  for (const bad of ["../x", "a/b", "A", ".."]) {
    assert.equal((await tool(client, "video_init", { name: bad })).isError, true, `init ${bad}`);
    assert.equal((await tool(client, "video_build", { name: bad })).isError, true, `build ${bad}`);
  }
  assert.ok(!existsSync(join(cwd, "x")) && !existsSync(join(cwd, ".daedalus", "x")), "traversal created nothing");

  // recorder import reads only inside the project, never echoes file content, and caps the size
  {
    const outside = mkdtempSync(join(tmpdir(), "video-mcp-outside-"));
    const secret = join(outside, "secret.json");
    writeFileSync(secret, "TOP-SECRET-CONTENT");
    symlinkSync(secret, join(cwd, "link.json"));
    writeFileSync(join(cwd, "bad.json"), '{"title": "TOP-SECRET-CONTENT" oops}');
    writeFileSync(join(cwd, "big.json"), Buffer.alloc(5 * 1024 * 1024 + 10, 32));
    writeFileSync(join(cwd, "rec.json"), JSON.stringify({ title: "R", steps: [{ type: "navigate", url: "http://localhost:3000/" }] }));
    for (const path of [secret, "/etc/passwd", "link.json", "../" + outside.split("/").pop() + "/secret.json"]) {
      const r = await tool(client, "video_import_recorder", { name: "imp", path });
      assert.equal(r.isError, true, `refused ${path}`);
      assert.match(r.text, /outside the project|cannot read/);
      assert.ok(!r.text.includes("TOP-SECRET"));
    }
    const bad = await tool(client, "video_import_recorder", { name: "imp", path: "bad.json" });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /not valid JSON/);
    assert.ok(!bad.text.includes("TOP-SECRET"), "parse error does not quote the file: " + bad.text);
    assert.match((await tool(client, "video_import_recorder", { name: "imp", path: "big.json" })).text, /larger than 5 MB/);
    assert.equal((await tool(client, "video_import_recorder", { name: "imp", path: "rec.json" })).isError, false);
    assert.equal((await tool(client, "video_import_recorder", { name: "imp2", recorderJson: { title: "R", steps: [{ type: "navigate", url: "http://localhost:3000/" }] } })).isError, false);
    rmSync(outside, { recursive: true, force: true });
    for (const n of ["imp", "imp2"]) rmSync(dirOf(n), { recursive: true, force: true });
  }

  // init + author the storyboard on disk (three steps: navigate, click, fill)
  const init = await tool(client, "video_init", { name: "demo", title: "Demo", baseUrl: fx.url });
  assert.equal(init.json.created, true);
  assert.equal(readFileSync(join(dirOf("demo"), ".gitignore"), "utf8"), GITIGNORE);
  assert.ok(existsSync(join(dirOf("demo"), "studio", "src", "Demo.tsx")) && existsSync(join(dirOf("demo"), "studio", "scripts", "render.mjs")), "studio scaffolded");
  assert.deepEqual(JSON.parse(readFileSync(join(dirOf("demo"), "studio", "props.json"), "utf8")).scenes, [], "placeholder props");
  assert.equal((await tool(client, "video_init", { name: "demo" })).json.created, false);
  editSb("demo", (sb) => {
    sb.steps = [
      { id: "open", say: "Here is the task list", do: { action: "goto", url: "/" } },
      { id: "new", say: "Press new task to start", do: { type: "click", selectors: [["#new"]] }, zoom: true },
      { id: "title", say: "Type a title for it", do: { action: "fill", selector: "#title", value: "Ship the demo" }, overlay: { text: "Just type" } },
    ];
  });
  assert.deepEqual((await tool(client, "video_list")).json.map((v) => [v.name, v.steps, v.studio.running, v.exports]), [["demo", 3, false, {}]]);

  // 1. first build: every narration is a miss, capture is a miss
  let j = await build(client, "demo");
  assert.equal(j.status, "done", j.error);
  assert.deepEqual(ttsOf(j), { open: "miss", new: "miss", title: "miss" });
  assert.equal(j.result.capture, "miss");
  assert.deepEqual(j.result.providers, { capture: "playwright", tts: "silent" });
  // no render: assets + props + a running Studio instead
  const D = dirOf("demo");
  const props = () => JSON.parse(readFileSync(join(D, "studio", "props.json"), "utf8"));
  const mp4s = () => readdirSync(join(D, "out")).filter((f) => f.endsWith(".mp4"));
  assert.deepEqual(mp4s(), [], "a build renders nothing");
  assert.equal(props().scenes.filter((x) => x.type === "clip").length, 3);
  assert.deepEqual(props().scenes[0], { type: "card", kind: "intro", fromMs: 0, durMs: 2400, text: "Demo" });
  assert.ok(existsSync(join(D, "studio", "public", props().video)), "the capture is under public/");
  for (const sc of props().scenes) if (sc.audio) assert.ok(existsSync(join(D, "studio", "public", sc.audio.file)), "narration is under public/");
  assert.ok(existsSync(join(D, "studio", "public", "click.wav")), "the fill typed, so the tick exists");
  assert.ok(props().scenes.some((x) => x.keys?.length), "typing ticks on the filling step");
  assert.equal(j.result.studio.running, true, JSON.stringify(j.result.warnings));
  assert.match(j.result.studio.url, /^http:\/\/(localhost|127\.0\.0\.1):31\d\d/);
  const onDisk = JSON.parse(readFileSync(join(D, ".cache", "build.json"), "utf8"));
  assert.deepEqual(onDisk.perStep.map((s) => s.tts), ["miss", "miss", "miss"]);
  assert.ok(onDisk.perStep.every((s, i, a) => s.audioMs > 0 && s.endMs > s.startMs && s.startMs >= 2400 && (i === 0 || s.startMs >= a[i - 1].endMs)), "composition clock, in order");
  assert.ok(readdirSync(join(D, ".cache", "jobs")).length >= 1, "job mirrored to disk");

  // studio: status answers on the url the build reported, stop/start round-trips, the port is stable per video
  const st = (await tool(client, "video_studio", { name: "demo", action: "status" })).json;
  assert.deepEqual([st.running, st.url, st.port], [true, j.result.studio.url, j.result.studio.port]);
  assert.equal((await fetch(st.url)).status, 200);
  assert.equal((await tool(client, "video_list")).json[0].studio.running, true);
  assert.equal((await tool(client, "video_studio", { name: "demo", action: "stop" })).json.running, false);
  assert.equal((await tool(client, "video_studio", { name: "demo", action: "status" })).json.running, false);
  assert.equal((await tool(client, "video_studio", { name: "demo", action: "start" })).json.port, st.port);
  assert.equal((await tool(client, "video_studio", { name: "demo", action: "start" })).json.port, st.port, "start is idempotent");
  assert.equal((await tool(client, "video_studio", { name: "nope-none", action: "start" })).isError, true);

  // review: stills for every scene, no mp4 needed
  const rv = await tool(client, "video_review", { name: "demo" });
  assert.ok(!rv.isError, rv.text);
  assert.deepEqual(mp4s(), [], "review renders stills only");
  assert.ok(existsSync(join(D, "out", "contact-sheet.png")) && existsSync(join(D, "out", "report.json")));
  assert.ok(rv.content.some((c) => c.type === "image"), "contact sheet returned inline");
  assert.equal(rv.json.report.steps.length, 3);
  assert.equal(rv.json.report.scenes.length, 4, "intro card + three clips");
  assert.ok(rv.json.report.steps.every((s) => s.audioMs > 0 && s.stepMs >= s.audioMs), "each step fits its narration");
  assert.equal(rv.json.report.steps[0].startMs, 2400, "timings are the composition's");
  assert.deepEqual((await tool(client, "video_review", { name: "demo", stepIds: ["new"] })).json.report.steps.map((s) => s.id), ["new"]);

  // 2. change ONE narration (same word count => same length => capture inputs unchanged)
  editSb("demo", (sb) => { sb.steps[0].say = "Here is the task board"; });
  j = await build(client, "demo");
  assert.equal(j.status, "done", j.error);
  assert.deepEqual(ttsOf(j), { open: "miss", new: "hit", title: "hit" });
  assert.equal(j.result.capture, "hit");

  // 3. insert a step in the middle: old narration is reused, the flow is re-recorded
  editSb("demo", (sb) => { sb.steps.splice(1, 0, { id: "hover", say: "Look at the flash button", do: { action: "hover", selector: "#flash" } }); });
  j = await build(client, "demo");
  assert.equal(j.status, "done", j.error);
  assert.deepEqual(ttsOf(j), { open: "hit", hover: "miss", new: "hit", title: "hit" });
  assert.equal(j.result.capture, "miss");

  // 4. overlay text: only props.json changes (Studio hot-reloads it); narration and capture come from cache
  const propsBefore = readFileSync(join(D, "studio", "props.json"), "utf8");
  editSb("demo", (sb) => { sb.steps[3].overlay.text = "Then just type"; });
  j = await build(client, "demo");
  assert.equal(j.status, "done", j.error);
  assert.ok(Object.values(ttsOf(j)).every((t) => t === "hit"));
  assert.equal(j.result.capture, "hit");
  assert.notEqual(readFileSync(join(D, "studio", "props.json"), "utf8"), propsBefore);
  assert.equal(props().scenes.find((x) => x.overlay)?.overlay.text, "Then just type");
  assert.deepEqual(mp4s(), []);

  // 5. an unknown provider fails the job with a clear message
  editSb("demo", (sb) => { sb.providers = { capture: "nope" }; });
  j = await build(client, "demo");
  assert.equal(j.status, "failed");
  assert.match(j.error, /unknown capture provider "nope"; registered: .*playwright/);
  editSb("demo", (sb) => { delete sb.providers; });

  // 6. a locked step: recorded on the first build, then frozen
  editSb("demo", (sb) => { sb.steps[0].locked = true; });
  j = await build(client, "demo");
  assert.equal(j.status, "done", j.error);
  editSb("demo", (sb) => { sb.steps[0].say = "Something completely different now"; });
  j = await build(client, "demo");
  assert.equal(j.status, "failed");
  assert.match(j.error, /locked step "open" was edited/);
  assert.match(j.error, /remove "locked"/);
  editSb("demo", (sb) => { delete sb.steps[0].locked; });
  j = await build(client, "demo");
  assert.equal(j.status, "done", "unlocking lets the edit through: " + j.error);

  // a hand edit of the composition survives a build; resetStudio puts the template back
  const theme = join(D, "studio", "src", "theme.ts");
  writeFileSync(theme, readFileSync(theme, "utf8") + "\n// mine\n");
  j = await build(client, "demo");
  assert.equal(j.status, "done", j.error);
  assert.ok(readFileSync(theme, "utf8").includes("// mine"), "the person's edit is kept");
  j = await build(client, "demo", { resetStudio: true });
  assert.equal(j.status, "done", j.error);
  assert.ok(!readFileSync(theme, "utf8").includes("// mine"), "resetStudio restored src/");

  // export: publish needs the full file; a fragment never takes its name
  const noFile = await tool(client, "video_publish", { name: "demo" });
  assert.match(noFile.text, /video_export/);
  assert.equal(uploads.length, 0);
  assert.equal((await tool(client, "video_export", { name: "demo", scene: "nope" })).isError, true);
  assert.equal((await tool(client, "video_export", { name: "demo", scene: "new", frames: "0-5" })).isError, true);
  assert.equal((await tool(client, "video_export", { name: "demo", frames: "0-999999" })).isError, true);
  const ex = await tool(client, "video_export", { name: "demo", scene: "new" });
  assert.ok(!ex.isError, ex.text);
  assert.equal((await tool(client, "video_export", { name: "demo", scene: "new" })).isError, true, "one export per video at a time");
  let e;
  for (let i = 0; i < 240; i++) {
    e = (await tool(client, "video_job", { jobId: ex.json.jobId })).json;
    if (e.status !== "running") break;
    await sleep(500);
  }
  assert.equal(e.status, "done", e.error);
  assert.equal(e.kind, "export");
  assert.equal(e.result.partial, true);
  const part = join(D, "out", "demo-draft-part.mp4");
  assert.equal(e.result.path, part);
  assert.deepEqual(mp4s(), ["demo-draft-part.mp4"], "no temp file, no full export");
  const sc = props().scenes.filter((x) => x.stepId === "new");
  const pr = probe(part);
  assert.ok(pr.streams.some((s) => s.codec_type === "video") && pr.streams.some((s) => s.codec_type === "audio"), "video and narration");
  assert.ok(Math.abs(Number(pr.format.duration) * 1000 - sc.reduce((n, x) => n + x.durMs, 0)) < 400, `duration ${pr.format.duration}s`);
  assert.equal((await tool(client, "video_publish", { name: "demo" })).text.includes("video_export"), true, "a fragment is not publishable");

  // the full export, then publish it to the (mock) Files library
  const full = await tool(client, "video_export", { name: "demo" });
  for (let i = 0; i < 480; i++) {
    e = (await tool(client, "video_job", { jobId: full.json.jobId })).json;
    if (e.status !== "running") break;
    await sleep(500);
  }
  assert.equal(e.status, "done", e.error);
  const draft = join(D, "out", "demo-draft.mp4");
  assert.equal(e.result.partial, false);
  assert.ok(Math.abs(Number(probe(draft).format.duration) * 1000 - props().durationMs) < 400);
  const pub = await tool(client, "video_publish", { name: "demo" });
  assert.ok(!pub.isError, pub.text);
  assert.equal(pub.json.published, true);
  assert.equal(pub.json.folder, "Videos/demo");
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].type, "video/mp4");
  assert.equal(uploads[0].row.name, "demo-draft.mp4");
  assert.ok(uploads[0].body.equals(readFileSync(draft)), "uploaded bytes are the draft");
  assert.deepEqual(rows.filter((r) => r.kind === "folder").map((r) => r.name), ["Videos", "demo"]);
  assert.deepEqual(Object.keys((await tool(client, "video_list")).json[0].exports).sort(), ["demo-draft-part.mp4", "demo-draft.mp4"]);

  // ---- openai-compatible TTS, same path, mocked /v1/audio/speech ---------------------------------
  client2 = await connect({ VIDEO_TTS: "openai-compatible", VIDEO_TTS_BASE_URL: ttsUrl, VIDEO_TTS_MODEL: "tts-test", VIDEO_TTS_VOICE: "nova" });
  const p2 = (await tool(client2, "video_providers")).json;
  assert.equal(p2.tts.find((p) => p.id === "openai-compatible").configured, true);
  assert.equal(p2.tts.find((p) => p.id === "openai-compatible").default, true);
  await tool(client2, "video_init", { name: "oai", baseUrl: fx.url });
  editSb("oai", (sb) => { sb.steps = [{ id: "one", say: "Hello from the mock voice", do: { action: "goto", url: "/" } }, { id: "two", say: "And a second line", do: { action: "click", selector: "#new" } }]; });
  j = await build(client2, "oai");
  assert.equal(j.status, "done", j.error);
  assert.equal(j.result.providers.tts, "openai-compatible");
  assert.deepEqual(ttsOf(j), { one: "miss", two: "miss" });
  assert.ok(j.result.perStep.every((s) => Math.abs(s.audioMs - 1500) < 120), `audioMs ${j.result.perStep.map((s) => s.audioMs)}`);
  assert.equal(speech.length, 2);
  assert.equal(speech[0].url, "/v1/audio/speech");
  assert.equal(speech[0].auth, `Bearer ${SECRETS[0]}`);
  assert.deepEqual([speech[0].body.model, speech[0].body.voice, speech[0].body.input], ["tts-test", "nova", "Hello from the mock voice"]);
  const oaiAudio = JSON.parse(readFileSync(join(dirOf("oai"), "studio", "props.json"), "utf8")).scenes.filter((x) => x.audio);
  assert.equal(oaiAudio.length, 2);
  assert.ok(oaiAudio.every((x) => probe(join(dirOf("oai"), "studio", "public", x.audio.file)).streams.some((s) => s.codec_type === "audio")), "narration is under public/");
  j = await build(client2, "oai");
  assert.equal(j.status, "done", j.error);
  assert.deepEqual(ttsOf(j), { one: "hit", two: "hit" });
  assert.equal(speech.length, 2, "cached narration makes no request");
  // an upstream error that echoes the credential must not leak it
  editSb("oai", (sb) => { sb.steps[1].say = "FAIL this one"; });
  j = await build(client2, "oai");
  assert.equal(j.status, "failed");
  assert.match(j.error, /500|no to/);
  assert.ok(!j.error.includes(SECRETS[0]), "key redacted in the job error");
  assert.ok(speech.at(-1).auth.includes(SECRETS[0]), "the mock did receive the key (so the redaction test is real)");

  // ---- no key anywhere ---------------------------------------------------------------------------
  const all = [...seen];
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  for (const f of walk(join(cwd, ".daedalus")).filter((f) => /\.(json|md)$/.test(f))) all.push(readFileSync(f, "utf8"));
  for (const s of SECRETS) assert.ok(!all.some((t) => t.includes(s)), "a key value leaked into a tool result or a file");

  console.log("e2e ok");
} finally {
  for (const n of ["demo", "oai"]) await stopStudio(videoPaths(cwd, n)).catch(() => {}); // Studio is detached: it must not outlive the test
  await client?.close().catch(() => {});
  await client2?.close().catch(() => {});
  for (const s of [files, tts]) s.close();
  await fx.close();
  if (process.env.VIDEO_E2E_KEEP) console.log("kept", cwd);
  else rmSync(cwd, { recursive: true, force: true });
}
