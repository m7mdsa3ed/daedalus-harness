import { run } from "../../exec.js";
import type { TtsProvider } from "../../types.js";
import { probeDurationMs } from "./probe.js";

/** Offline stand-in: silence as long as the line would take to say. Lets the pipeline run with no credentials. */
export const silentTts: TtsProvider = {
  id: "silent",
  capabilities: { wordTimestamps: false, needsKey: false },
  async synth({ text, outPath }) {
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    const ms = Math.max(900, words * 320);
    const path = `${outPath}.wav`;
    await run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", String(ms / 1000), path], { timeoutMs: 30_000 });
    return { path, durationMs: await probeDurationMs(path) };
  },
};
