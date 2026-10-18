import { rm } from "node:fs/promises";
import type { TtsProvider, TtsWord } from "../../types.js";
import { errorText, post, writeAudio } from "./http.js";
import { probeDurationMs } from "./probe.js";

const API = "https://api.elevenlabs.io/v1/text-to-speech";
const FORMAT = "mp3_44100_128";

interface Alignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

/** Character timings to word timings: a word is a run of non-space characters. */
export function wordsFromAlignment(a: Alignment): TtsWord[] {
  const words: TtsWord[] = [];
  let cur: TtsWord | undefined;
  a.characters.forEach((ch, i) => {
    if (ch.trim() === "") return void (cur = undefined);
    const start = Math.round(a.character_start_times_seconds[i] * 1000);
    const end = Math.round(a.character_end_times_seconds[i] * 1000);
    if (cur) {
      cur.text += ch;
      cur.endMs = end;
    } else words.push((cur = { text: ch, startMs: start, endMs: end }));
  });
  return words;
}

export const elevenlabsTts: TtsProvider = {
  id: "elevenlabs",
  capabilities: { wordTimestamps: true, needsKey: true },
  async synth({ text, voice, outPath }) {
    const key = process.env.ELEVENLABS_API_KEY?.trim();
    if (!key) throw new Error("elevenlabs TTS: ELEVENLABS_API_KEY is not set");
    const voiceId = voice ?? process.env.ELEVENLABS_VOICE_ID?.trim();
    if (!voiceId) throw new Error("elevenlabs TTS: no voice (set ELEVENLABS_VOICE_ID or the step/storyboard voice)");
    const url = `${API}/${encodeURIComponent(voiceId)}`;
    const headers = { "xi-api-key": key };
    const body = { text, model_id: process.env.ELEVENLABS_MODEL?.trim() || "eleven_multilingual_v2" };
    const path = `${outPath}.mp3`;

    let words: TtsWord[] | undefined;
    const timed = await post("elevenlabs TTS", `${url}/with-timestamps?output_format=${FORMAT}`, headers, body);
    // Timestamps are a nicety: when the endpoint is not offered on this plan or host, plain audio still works.
    // Auth, quota and validation errors would fail the plain call the same way, so those are reported now.
    if (timed.ok) {
      const j = (await timed.json()) as { audio_base64?: string; alignment?: Alignment | null };
      if (!j.audio_base64) throw new Error("elevenlabs TTS: response had no audio");
      await writeAudio(path, Buffer.from(j.audio_base64, "base64"));
      if (j.alignment) words = wordsFromAlignment(j.alignment);
    } else if ([404, 405, 501].includes(timed.status)) {
      const plain = await post("elevenlabs TTS", `${url}?output_format=${FORMAT}`, headers, body);
      if (!plain.ok) throw new Error(`elevenlabs TTS: HTTP ${plain.status}: ${await errorText(plain)}`);
      await writeAudio(path, new Uint8Array(await plain.arrayBuffer()));
    } else throw new Error(`elevenlabs TTS: HTTP ${timed.status}: ${await errorText(timed)}`);

    try {
      return { path, durationMs: await probeDurationMs(path), ...(words && { words }) };
    } catch (e) {
      await rm(path, { force: true });
      throw new Error(`elevenlabs TTS: response was not playable audio (${(e as Error).message.split("\n")[0]})`);
    }
  },
};
