import { resolve } from "node:path";
import { run } from "./exec.js";

const RATE = 44100;

/** Every key lands a little differently: pitch and loudness vary on a fixed cycle (deterministic, so a rebuild sounds the same). */
export function keyJitter(i: number): { rate: number; vol: number } {
  return { rate: [1, 0.94, 1.07, 0.98, 1.05][i % 5], vol: [0.5, 0.42, 0.56, 0.46, 0.52][(i * 3) % 5] };
}

/** One key press: a low "thock" of the case, a higher plastic ring and a 3 ms noise snap of the contact, all decaying
    within 70 ms. VIDEO_TYPING_SOUND_FILE swaps in a recorded sample (any format ffmpeg reads, trimmed to 150 ms). */
export async function makeClick(path: string, cwd: string): Promise<void> {
  const own = process.env.VIDEO_TYPING_SOUND_FILE?.trim();
  if (own) return void (await run("ffmpeg", ["-y", "-v", "error", "-i", resolve(own), "-t", "0.15", "-ar", String(RATE), "-ac", "1", path], { cwd }));
  const expr = "0.8*exp(-t*75)*sin(2*PI*170*t)+0.4*exp(-t*60)*sin(2*PI*390*t)+0.7*exp(-t*600)*(2*random(0)-1)";
  await run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `aevalsrc=${expr}:d=0.07:s=${RATE}`, "-af", "highpass=f=80,lowpass=f=7500,volume=0.7", path], { cwd });
}
