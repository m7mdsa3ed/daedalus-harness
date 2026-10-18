#!/usr/bin/env node
// The only place that talks to Remotion's Node API. Bundles once, then renders media or stills.
//   --mode still|media --props <props.json> --out <file or dir> [--frames a-b] [--frame n,n,n]
//   [--quality draft|final] [--chrome <path>] [--concurrency n]
// stdout, one JSON object per line: {"progress":0..1} ... {"done":true,"out":...} | {"error":"..."} (exit 1).
import { rmSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const say = (o) => process.stdout.write(JSON.stringify(o) + "\n");

async function main() {
  const { values: a } = parseArgs({
    options: { mode: { type: "string" }, props: { type: "string" }, out: { type: "string" }, frames: { type: "string" }, frame: { type: "string" }, quality: { type: "string", default: "draft" }, chrome: { type: "string" }, concurrency: { type: "string" } },
  });
  if (!["still", "media"].includes(a.mode) || !a.props || !a.out) throw new Error("usage: --mode still|media --props <file> --out <path> [--frames a-b] [--frame n,n] [--quality draft|final] [--chrome path] [--concurrency n]");
  const inputProps = JSON.parse(await readFile(resolve(a.props), "utf8"));
  const common = { browserExecutable: a.chrome || null, logLevel: "error" };
  const concurrency = a.concurrency ? Number(a.concurrency) : null;

  // bundling is a tenth of the bar; the rest is the render
  const tmp = await mkdtemp(join(tmpdir(), "studio-bundle-"));
  // the bundle holds a copy of public/ (the capture): a killed export must not leave it behind
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => (rmSync(tmp, { recursive: true, force: true }), process.exit(1)));
  try {
    const serveUrl = await bundle({ entryPoint: join(root, "src", "index.ts"), publicDir: join(root, "public"), outDir: join(tmp, "b"), onProgress: (p) => say({ progress: (p / 100) * 0.1 }) });
    const comp = await selectComposition({ ...common, serveUrl, id: "Demo", inputProps });
    const last = comp.durationInFrames - 1;

    if (a.mode === "still") {
      const list = (a.frame ?? "0").split(",").map((n) => Math.min(last, Math.max(0, Math.round(Number(n)))));
      if (list.some(Number.isNaN)) throw new Error("--frame wants numbers: 10,70,120");
      let i = 0;
      for (const frame of list) {
        await renderStill({ ...common, serveUrl, composition: comp, inputProps, frame, output: join(resolve(a.out), `${frame}.png`), overwrite: true });
        say({ progress: 0.1 + (0.9 * ++i) / list.length });
      }
    } else {
      let frameRange = null;
      if (a.frames) {
        const m = /^(\d+)-(\d+)$/.exec(a.frames);
        if (!m) throw new Error('--frames wants "a-b"');
        frameRange = [Math.min(last, Number(m[1])), Math.min(last, Number(m[2]))];
        if (frameRange[0] > frameRange[1]) throw new Error("--frames: a must not exceed b");
      }
      await renderMedia({
        ...common, serveUrl, composition: comp, inputProps, codec: "h264", crf: a.quality === "final" ? 18 : 28, frameRange, concurrency,
        outputLocation: resolve(a.out), overwrite: true, onProgress: (p) => say({ progress: 0.1 + 0.9 * p.progress }),
      });
    }
    say({ progress: 1 });
    say({ done: true, out: resolve(a.out) });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  say({ error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
