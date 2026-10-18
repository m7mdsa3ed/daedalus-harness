import { run } from "../../exec.js";

/** Duration of an audio/video file in ms, via ffprobe (argv array, no shell). Rejects on missing or zero duration. */
export async function probeDurationMs(path: string): Promise<number> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", path], { timeoutMs: 30_000 });
  const seconds = Number((JSON.parse(stdout) as { format?: { duration?: string } }).format?.duration);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`ffprobe found no duration in ${path}`);
  return Math.round(seconds * 1000);
}
