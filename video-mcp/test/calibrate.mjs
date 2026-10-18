// Measures VIDEO_CAPTURE_OFFSET_MS: where the recorded video's clock sits against our marks.
// Marks are `Date.now() - firstFrameTimestamp` (the screencast's first frame is video t=0).
// A colour cue is painted at a known time; the first frame showing it gives the video time.
// offset = video time - mark time. Prints per-run values and the median.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { findChrome } from "../dist/config.js";

const FPS = 25;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frames = (path) =>
  new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", ["-v", "error", "-i", path, "-vf", "scale=1:1,format=rgb24", "-f", "rawvideo", "-"]);
    const chunks = [];
    p.stdout.on("data", (d) => chunks.push(d));
    p.on("error", reject);
    p.on("close", () => resolve(Buffer.concat(chunks)));
  });

const runs = Number(process.argv[2] ?? 8);
const offsets = [];
const browser = await chromium.launch({ executablePath: findChrome(), headless: true });
for (let i = 0; i < runs; i++) {
  const dir = await mkdtemp(join(tmpdir(), "vm-cal-"));
  const context = await browser.newContext({ viewport: { width: 640, height: 360 } });
  const page = await context.newPage();
  const path = join(dir, "v.webm");
  let first;
  await page.screencast.start({ path, size: { width: 640, height: 360 }, onFrame: (f) => void (first ??= f.timestamp) });
  await sleep(500);
  await page.evaluate(() => {
    document.documentElement.style.background = "#0000ff";
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  const cue = Date.now() - first;
  await sleep(500);
  await page.screencast.stop();
  await context.close();
  const buf = await frames(path);
  let f = 0;
  while (f * 3 < buf.length && !(buf[f * 3] < 60 && buf[f * 3 + 2] > 200)) f++;
  if (f * 3 >= buf.length) throw new Error("cue not found in the video");
  const off = Math.round((f / FPS) * 1000 - cue);
  offsets.push(off);
  console.log(`run ${i + 1}: cue at mark ${Math.round(cue)}ms, first blue frame ${f} (${(f / FPS) * 1000}ms) -> offset ${off}ms`);
  await rm(dir, { recursive: true, force: true });
}
await browser.close();
offsets.sort((a, b) => a - b);
console.log("median offset", offsets[Math.floor(offsets.length / 2)], "ms");
