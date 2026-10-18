import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderKind } from "./types.js";
import type { Storyboard } from "./storyboard.js";

/** The harness's Files library refuses anything larger (413). */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

const env = (k: string): string | undefined => {
  const v = process.env[k]?.trim();
  return v ? v : undefined;
};

export function harnessUrl(): string | undefined {
  return env("HARNESS_URL")?.replace(/\/+$/, "");
}

/** Values to scrub from anything that leaves the process. Never returned to the agent. */
export function secretValues(): string[] {
  const out = ["VIDEO_TTS_API_KEY", "ELEVENLABS_API_KEY"].map(env);
  out.push(env("HARNESS_URL")); // embeds the loopback key
  // The TTS base URL may carry userinfo or a token in its query.
  try {
    const u = new URL(env("VIDEO_TTS_BASE_URL") ?? "");
    out.push(u.password, decodeURIComponent(u.password), u.username, u.search.slice(1), ...u.searchParams.values());
  } catch {}
  return [...new Set(out)].filter((v): v is string => !!v && v.length >= 6).sort((a, b) => b.length - a.length); // longest first: a query contains its own values
}

// ---- provider choice --------------------------------------------------------

/** Ids of the providers a build uses: storyboard override, else env, else the default. */
export function chosenIds(sb?: Storyboard): Record<ProviderKind, string> {
  const o = sb?.providers;
  return {
    capture: o?.capture ?? env("VIDEO_CAPTURE") ?? "playwright",
    tts: o?.tts ?? env("VIDEO_TTS") ?? (env("VIDEO_TTS_BASE_URL") ? "openai-compatible" : env("ELEVENLABS_API_KEY") ? "elevenlabs" : "silent"),
  };
}

/** Non-secret TTS settings that change the audio: part of the cache key. */
export function ttsFingerprint(): string {
  return ["VIDEO_TTS_BASE_URL", "VIDEO_TTS_MODEL", "VIDEO_TTS_VOICE", "ELEVENLABS_VOICE_ID", "ELEVENLABS_MODEL"].map((k) => env(k) ?? "").join("|");
}

// Optional override command (argv, no shell) for the Remotion CLI.
export const remotionCmd = (): string | undefined => env("VIDEO_REMOTION_CMD");

/** Where Studio listens. Loopback by default: Studio can write files and render, so widening it exposes both to the network. */
export const studioHost = (): string => env("VIDEO_STUDIO_HOST") ?? "127.0.0.1";

/** ms added to every recorder mark; the calibration knob for recorder/mark drift. Capture agent documents the default. */
export function captureOffsetMs(fallback: number): number {
  const n = Number(env("VIDEO_CAPTURE_OFFSET_MS"));
  return Number.isFinite(n) && env("VIDEO_CAPTURE_OFFSET_MS") !== undefined ? n : fallback;
}

// ---- chrome discovery -------------------------------------------------------

/**
 * VIDEO_CHROME_PATH, else the newest chromium in Playwright's cache (the installed
 * playwright-core may want a newer revision than the cache holds, so we never rely
 * on its own lookup), else a system chrome.
 */
export function findChrome(): string | undefined {
  const explicit = env("VIDEO_CHROME_PATH");
  if (explicit) return existsSync(explicit) ? explicit : undefined;
  const root = env("PLAYWRIGHT_BROWSERS_PATH") ?? join(homedir(), ".cache", "ms-playwright");
  try {
    const dirs = readdirSync(root)
      .map((d) => /^chromium-(\d+)$/.exec(d))
      .filter((m): m is RegExpExecArray => !!m)
      .sort((a, b) => Number(b[1]) - Number(a[1]));
    for (const m of dirs)
      for (const rel of ["chrome-linux64/chrome", "chrome-linux/chrome", "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing", "chrome-win64/chrome.exe"]) {
        const p = join(root, m[0], rel);
        if (existsSync(p)) return p;
      }
  } catch {}
  return ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(existsSync);
}

// ---- readiness --------------------------------------------------------------

interface Readiness {
  ok: () => boolean | Promise<boolean>;
  /** What to set when it is not ready. Names variables, never values. */
  hint: string;
}

// One entry per registered provider id. The pipeline asks this before a build so a
// missing key is one clear sentence, not a 401 from the middle of a render.
export const READINESS: Record<ProviderKind, Record<string, Readiness>> = {
  capture: {
    playwright: { ok: () => !!findChrome(), hint: "no Chrome/Chromium found: install one or set VIDEO_CHROME_PATH" },
    file: { ok: () => true, hint: "" },
  },
  tts: {
    "openai-compatible": { ok: () => !!env("VIDEO_TTS_BASE_URL"), hint: "set VIDEO_TTS_BASE_URL (and VIDEO_TTS_API_KEY, VIDEO_TTS_MODEL, VIDEO_TTS_VOICE as needed)" },
    elevenlabs: { ok: () => !!env("ELEVENLABS_API_KEY"), hint: "set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID" },
    silent: { ok: () => true, hint: "" },
  },
};

export async function readiness(kind: ProviderKind, id: string): Promise<{ configured: boolean; hint: string }> {
  const r = READINESS[kind][id];
  return r ? { configured: await r.ok(), hint: r.hint } : { configured: false, hint: "no readiness entry in config.ts READINESS" };
}

export async function assertConfigured(kind: ProviderKind, id: string): Promise<void> {
  const r = await readiness(kind, id);
  if (!r.configured) throw new Error(`${kind} provider "${id}" is not configured: ${r.hint}`);
}
