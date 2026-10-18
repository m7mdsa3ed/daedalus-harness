// TTS providers. Run after `pnpm build`: node test/tts.test.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { probeDurationMs } from "../dist/providers/tts/probe.js";
import { silentTts } from "../dist/providers/tts/silent.js";
import { openaiCompatibleTts } from "../dist/providers/tts/openai-compatible.js";
import { elevenlabsTts, wordsFromAlignment } from "../dist/providers/tts/elevenlabs.js";

const dir = await mkdtemp(join(tmpdir(), "tts-test-"));
try {
  // probe + silent, for real
  const s = await silentTts.synth({ text: "one two three four five six seven eight nine ten", outPath: join(dir, "s") });
  assert.ok(s.path.endsWith(".wav"));
  assert.ok(Math.abs(s.durationMs - 3200) < 60, `silent ${s.durationMs}`);
  assert.ok(Math.abs((await silentTts.synth({ text: "hi", outPath: join(dir, "s2") })).durationMs - 900) < 60);
  assert.equal(await probeDurationMs(s.path), s.durationMs);
  await assert.rejects(probeDurationMs(join(dir, "missing.wav")));
  await assert.rejects(probeDurationMs(join(dir, "s.wav.txt")));

  // a tiny real mp3 for the mock servers
  const mp3Path = join(dir, "tone.mp3");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1.5", mp3Path]);
  const mp3 = await readFile(mp3Path);

  // openai-compatible against a local server
  const seen = [];
  const server = createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: b ? JSON.parse(b) : null });
      const input = b ? JSON.parse(b).input : "";
      if (input === "boom") return void res.writeHead(500).end("upstream exploded secret-key-123");
      if (input === "json") return void res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      if (input === "junk") return void res.writeHead(200, { "content-type": "audio/mpeg" }).end("not audio at all");
      if (input === "empty") return void res.writeHead(200, { "content-type": "audio/mpeg" }).end();
      res.writeHead(200, { "content-type": "audio/mpeg" }).end(mp3);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const tts = (text, outName) => openaiCompatibleTts.synth({ text, outPath: join(dir, outName) });

  delete process.env.VIDEO_TTS_BASE_URL;
  await assert.rejects(tts("x", "o0"), /VIDEO_TTS_BASE_URL/);

  process.env.VIDEO_TTS_BASE_URL = base; // no /v1
  process.env.VIDEO_TTS_MODEL = "kokoro";
  process.env.VIDEO_TTS_VOICE = "af_bella";
  const a = await tts("hello", "o1");
  assert.ok(a.path.endsWith(".mp3") && Math.abs(a.durationMs - 1500) < 100, `mp3 ${a.durationMs}`);
  assert.equal(seen[0].url, "/v1/audio/speech");
  assert.equal(seen[0].auth, undefined); // key optional
  assert.deepEqual(seen[0].body, { model: "kokoro", input: "hello", voice: "af_bella", response_format: "mp3" });

  process.env.VIDEO_TTS_BASE_URL = `${base}/v1/`; // with /v1 and a slash
  process.env.VIDEO_TTS_API_KEY = "secret-key-123";
  await openaiCompatibleTts.synth({ text: "hello", voice: "other", outPath: join(dir, "o2") });
  assert.equal(seen[1].url, "/v1/audio/speech");
  assert.equal(seen[1].auth, "Bearer secret-key-123");
  assert.equal(seen[1].body.voice, "other"); // per-call voice wins

  await assert.rejects(tts("boom", "o3"), (e) => /HTTP 500/.test(e.message) && !e.message.includes("secret-key-123"));
  await assert.rejects(tts("json", "o4"), /expected audio/);
  await assert.rejects(tts("junk", "o5"), /not playable audio/);
  await assert.rejects(tts("empty", "o6"), /empty audio/);
  assert.ok(!(await readdir(dir)).some((f) => f.startsWith("o5")), "unplayable file is removed");
  await new Promise((r) => server.close(r));
  await assert.rejects(tts("hello", "o7"), /request failed/); // connection refused
  delete process.env.VIDEO_TTS_API_KEY;

  // elevenlabs word mapping (pure)
  const chars = [..."Hi you"];
  const starts = chars.map((_, i) => i * 0.1);
  const ends = chars.map((_, i) => i * 0.1 + 0.1);
  assert.deepEqual(wordsFromAlignment({ characters: chars, character_start_times_seconds: starts, character_end_times_seconds: ends }), [
    { text: "Hi", startMs: 0, endMs: 200 },
    { text: "you", startMs: 300, endMs: 600 },
  ]);

  // elevenlabs through a mocked fetch of the documented response shape (no real key was used)
  const realFetch = globalThis.fetch;
  const calls = [];
  let mode = "ok";
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), key: init.headers["xi-api-key"], body: JSON.parse(init.body) });
    const withTs = String(url).includes("/with-timestamps");
    if (mode === "auth") return new Response('{"detail":"bad key el-key-456"}', { status: 401 });
    if (mode === "fallback" && withTs) return new Response("nope", { status: 404 });
    if (!withTs) return new Response(mp3, { status: 200, headers: { "content-type": "audio/mpeg" } });
    return Response.json({
      audio_base64: mp3.toString("base64"),
      alignment: { characters: chars, character_start_times_seconds: starts, character_end_times_seconds: ends },
      normalized_alignment: null,
    });
  };
  const el = (outName, voice) => elevenlabsTts.synth({ text: "Hi you", voice, outPath: join(dir, outName) });
  delete process.env.ELEVENLABS_API_KEY;
  await assert.rejects(el("e0"), /ELEVENLABS_API_KEY/);
  process.env.ELEVENLABS_API_KEY = "el-key-456";
  await assert.rejects(el("e0"), /no voice/);
  process.env.ELEVENLABS_VOICE_ID = "voice/1";
  const e1 = await el("e1");
  assert.ok(e1.path.endsWith(".mp3") && Math.abs(e1.durationMs - 1500) < 100);
  assert.equal(e1.words.length, 2);
  assert.equal(calls[0].url, "https://api.elevenlabs.io/v1/text-to-speech/voice%2F1/with-timestamps?output_format=mp3_44100_128");
  assert.equal(calls[0].key, "el-key-456");
  assert.deepEqual(calls[0].body, { text: "Hi you", model_id: "eleven_multilingual_v2" });
  assert.equal(elevenlabsTts.capabilities.wordTimestamps, true);

  mode = "fallback";
  calls.length = 0;
  const e2 = await el("e2", "v2");
  assert.equal(e2.words, undefined);
  assert.equal(calls.length, 2);
  assert.ok(!calls[1].url.includes("with-timestamps"));

  mode = "auth";
  calls.length = 0;
  await assert.rejects(el("e3"), (e) => /HTTP 401/.test(e.message) && !e.message.includes("el-key-456"));
  assert.equal(calls.length, 1); // an auth failure is not retried on the plain endpoint
  globalThis.fetch = realFetch;

  console.log("tts ok");
} finally {
  await rm(dir, { recursive: true, force: true });
}
