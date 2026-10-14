/**
 * Free-provider registry for the gateway shim.
 *
 * Detection is by profile baseUrl for now (no schema migration): a profile
 * pointed at `https://opencode.ai/inference/v1` gets the opencode-free
 * fingerprint. When the second provider lands (antigravity, claude-code
 * oauth, codex oauth), add its file and one entry here — the shim calls
 * `applyProvider` and never names a provider itself.
 */
import type { FreeProvider } from "./types.js";
import { opencodeFree } from "./opencode-free.js";

export type { FreeProvider };
export { opencodeFree, sessionForThread, freshSession, sessionCounter, OPENCODE_FREE_UA } from "./opencode-free.js";

const PROVIDERS: FreeProvider[] = [opencodeFree];

/** Which free provider (if any) serves this profile base URL. */
export function detectProvider(baseUrl: string): FreeProvider | undefined {
  const host = (baseUrl || "").toLowerCase();
  if (host.includes("opencode.ai/inference")) return opencodeFree;
  return undefined;
}

export function providerById(id: string): FreeProvider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}
