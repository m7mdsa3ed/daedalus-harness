import { writeFile } from "node:fs/promises";
import { redact } from "../../exec.js";

export const TTS_TIMEOUT_MS = 120_000;

/** What a failed response said, trimmed and scrubbed of any configured key. */
export async function errorText(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  return redact(body.trim().replace(/\s+/g, " ").slice(0, 300));
}

/** fetch with a timeout; a network failure never carries the key (it only lives in a header), but scrub anyway. */
export async function post(provider: string, url: string, headers: Record<string, string>, body: unknown): Promise<Response> {
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
    });
  } catch (e) {
    const err = e as Error;
    const why = err.name === "TimeoutError" ? `timed out after ${TTS_TIMEOUT_MS / 1000}s` : err.message;
    throw new Error(redact(`${provider}: request failed: ${why}`));
  }
}

export async function writeAudio(path: string, bytes: Uint8Array): Promise<void> {
  if (bytes.length === 0) throw new Error("empty audio response");
  await writeFile(path, bytes);
}
