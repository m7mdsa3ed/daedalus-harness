import { chosenIds } from "../config.js";
import type { Storyboard } from "../storyboard.js";
import type { CaptureProvider, ProviderKind, TtsProvider } from "../types.js";
import { fileCapture } from "./capture/file.js";
import { playwrightCapture } from "./capture/playwright.js";
import { elevenlabsTts } from "./tts/elevenlabs.js";
import { openaiCompatibleTts } from "./tts/openai-compatible.js";
import { silentTts } from "./tts/silent.js";

// A provider is one import line and one entry here. Keys are the ids storyboards and env use.
export const CAPTURE: Record<string, CaptureProvider> = {
  playwright: playwrightCapture,
  file: fileCapture,
};

export const TTS: Record<string, TtsProvider> = {
  "openai-compatible": openaiCompatibleTts,
  elevenlabs: elevenlabsTts,
  silent: silentTts,
};

export const REGISTRY = { capture: CAPTURE, tts: TTS } as const;

function pick<T>(kind: ProviderKind, table: Record<string, T>, id: string): T {
  const p = Object.hasOwn(table, id) ? table[id] : undefined;
  if (!p) throw new Error(`unknown ${kind} provider "${id}"; registered: ${Object.keys(table).join(", ")}`);
  return p;
}

export interface Resolved {
  capture: CaptureProvider;
  tts: TtsProvider;
}

export function resolveProviders(sb: Storyboard): Resolved {
  const ids = chosenIds(sb);
  return { capture: pick("capture", CAPTURE, ids.capture), tts: pick("tts", TTS, ids.tts) };
}
