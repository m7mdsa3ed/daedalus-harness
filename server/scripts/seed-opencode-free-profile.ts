/**
 * Seed the "Opencode Free" profile — `pnpm seed:opencode-free`.
 *
 * A profile is a provider: baseUrl points at opencode.ai's inference root and
 * the gateway shim applies the free-tier fingerprint per request (see
 * `src/providers/opencode-free.ts`), so the stored apiKey stays empty and
 * upstream sees `Bearer public`. Daedalus-only for now.
 *
 * The catalog is read live from `/zen/v1/models` (still 200) and filtered to
 * `-free` ids. Idempotent: re-running refreshes the model list, never the name
 * or credentials.
 */
import { createProfile, listProfiles, updateProfile } from "../src/profiles.js";

const BASE_URL = "https://opencode.ai/inference/v1";
const NAME = "Opencode Free";

const res = await fetch("https://opencode.ai/zen/v1/models");
if (!res.ok) throw new Error(`models fetch failed: HTTP ${res.status}`);
const data = (await res.json()) as { data?: { id?: string }[] };
const ids = [...new Set((data.data ?? []).map((m) => m.id).filter((id): id is string => !!id && id.endsWith("-free")))].sort();
if (!ids.length) throw new Error("no free models in upstream catalog");

const models = ids.map((id) => ({ id, label: id, reasoningEfforts: [] as string[] }));
const input = {
  name: NAME,
  agents: { daedalus: {} },
  baseUrl: BASE_URL,
  apiKey: "",
  models,
  defaultModel: ids.includes("mimo-v2.6-flash-free") ? "mimo-v2.6-flash-free" : ids[0]!,
  smallModel: "",
  usage: null,
  suppressModelMetadataWarning: false,
  upstreamTimeoutSeconds: null,
  hidden: false,
  disabled: false,
  logoUrl: "https://models.dev/logos/opencode.svg",
};

const existing = (await listProfiles([])).find((p) => p.name === NAME && !p.virtual);
if (existing) {
  await updateProfile(existing.id, { ...input, apiKey: "" });
  console.log(`updated ${NAME} (${existing.id}): ${ids.length} models`);
} else {
  const created = await createProfile(input);
  console.log(`created ${NAME} (${created.id}): ${ids.length} models`);
}
console.log(ids.join("\n"));
