import { rm } from "node:fs/promises";
import type { TtsProvider } from "../../types.js";
import { errorText, post, writeAudio } from "./http.js";
import { probeDurationMs } from "./probe.js";

/** OpenAI's shape, which Kokoro-FastAPI and most self-hosted servers copy. The key is optional: self-hosted ones have none. */
export const openaiCompatibleTts: TtsProvider = {
  id: "openai-compatible",
  capabilities: { wordTimestamps: false, needsKey: false },
  async synth({ text, voice, outPath }) {
    const base = process.env.VIDEO_TTS_BASE_URL?.trim().replace(/\/+$/, "");
    if (!base) throw new Error("openai-compatible TTS: VIDEO_TTS_BASE_URL is not set");
    // ponytail: a server mounted at some other prefix than /v1 must be given with that prefix ending in /v1.
    const url = `${base.endsWith("/v1") ? base : `${base}/v1`}/audio/speech`;
    const shown = (() => {
      try {
        const u = new URL(url);
        return u.origin + u.pathname; // never userinfo or query: either may be a credential
      } catch {
        return "the TTS server";
      }
    })();
    const key = process.env.VIDEO_TTS_API_KEY?.trim();
    const res = await post("openai-compatible TTS", url, key ? { authorization: `Bearer ${key}` } : {}, {
      model: process.env.VIDEO_TTS_MODEL?.trim() || "tts-1",
      input: text,
      voice: voice ?? process.env.VIDEO_TTS_VOICE?.trim() ?? "alloy",
      response_format: "mp3",
    });
    if (!res.ok) throw new Error(`openai-compatible TTS: HTTP ${res.status} from ${shown}: ${await errorText(res)}`);
    const type = res.headers.get("content-type") ?? "";
    // Some servers send octet-stream; JSON or text means an error body that came back as 200.
    if (type && !/^(audio\/|application\/octet-stream)/i.test(type)) throw new Error(`openai-compatible TTS: expected audio, got ${type}: ${await errorText(res)}`);
    const path = `${outPath}.mp3`;
    await writeAudio(path, new Uint8Array(await res.arrayBuffer()));
    try {
      return { path, durationMs: await probeDurationMs(path) };
    } catch (e) {
      await rm(path, { force: true });
      throw new Error(`openai-compatible TTS: response was not playable audio (${(e as Error).message.split("\n")[0]})`);
    }
  },
};
