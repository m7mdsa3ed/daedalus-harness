import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { asc, eq } from "drizzle-orm";
import { DATA_DIR } from "../config.js";
import { db, videoTtsProviders } from "../db/index.js";

export interface TtsProvider {
  id: string;
  label: string;
  synthesize(input: { text: string; apiKey: string; model: string; voice: string }): Promise<Buffer>;
}

const elevenLabs: TtsProvider = {
  id: "elevenlabs",
  label: "ElevenLabs",
  async synthesize({ text, apiKey, model, voice }) {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}`, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: model, output_format: "mp3_44100_128" }),
    });
    if (!response.ok) throw new Error(`ElevenLabs speech request failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
    return Buffer.from(await response.arrayBuffer());
  },
};

const providers = new Map<string, TtsProvider>([[elevenLabs.id, elevenLabs]]);

export const availableTtsProviders = () => [...providers.values()].map(({ id, label }) => ({ id, label }));

export async function listConfiguredTtsProviders() {
  return (await db.select().from(videoTtsProviders).orderBy(asc(videoTtsProviders.provider))).map(({ provider, model, voice }) => ({
    id: provider,
    label: providers.get(provider)?.label ?? provider,
    model,
    voice,
    hasKey: true,
  }));
}

export async function saveTtsProvider(input: { provider: string; apiKey: string; model: string; voice: string }) {
  const adapter = providers.get(input.provider);
  if (!adapter) throw new Error("Unsupported TTS provider");
  const [existing] = await db.select().from(videoTtsProviders).where(eq(videoTtsProviders.provider, input.provider));
  const apiKey = input.apiKey.trim() || existing?.apiKey || "";
  if (!apiKey) throw new Error("An API key is required");
  const [saved] = await db.insert(videoTtsProviders).values({ ...input, apiKey, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: videoTtsProviders.provider, set: { apiKey, model: input.model, voice: input.voice, updatedAt: Date.now() } }).returning();
  return { id: saved.provider, label: adapter.label, model: saved.model, voice: saved.voice, hasKey: true };
}

export async function synthesizeSpeech(input: { provider: string; text: string; sessionId: string }): Promise<{ name: string }> {
  const provider = providers.get(input.provider);
  if (!provider) throw new Error("Unsupported TTS provider");
  const row = (await db.select().from(videoTtsProviders).where(eq(videoTtsProviders.provider, input.provider)))[0];
  if (!row) throw new Error(`No ${input.provider} speech provider is configured`);
  const bytes = await provider.synthesize({ text: input.text, apiKey: row.apiKey, model: row.model, voice: row.voice });
  const id = randomUUID();
  const dir = join(DATA_DIR, "videos", "audio", input.sessionId);
  await mkdir(dir, { recursive: true });
  const name = `${id}.mp3`;
  const path = join(dir, name);
  await writeFile(path, bytes, { flag: "wx" });
  return { name };
}
