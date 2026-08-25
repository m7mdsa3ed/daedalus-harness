import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { DATA_DIR, readJson, writeJson } from "./config.js";

// A profile is the AGENT configuration used in a session (credentials, models);
// the workspace side lives in projects.ts.
export const ProfileInputSchema = z.object({
  name: z.string().min(1),
  agentId: z.string().min(1),
  baseUrl: z.string().optional().default(""),
  apiKey: z.string().optional().default(""),
  models: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().min(1),
        contextWindow: z.number().int().positive().optional(),
        maxOutputTokens: z.number().int().positive().optional(),
        // Effort levels the model accepts; empty = no effort control.
        reasoningEfforts: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  defaultModel: z.string().optional().default(""),
});

export type ProfileInput = z.infer<typeof ProfileInputSchema>;
export type Profile = ProfileInput & { id: string };

const PROFILES_PATH = join(DATA_DIR, "profiles.json");

export function listProfiles(): Profile[] {
  return readJson<Profile[]>(PROFILES_PATH, []);
}

export function getProfile(id: string): Profile | undefined {
  return listProfiles().find((p) => p.id === id);
}

/** API keys never leave the server. */
export function redact(profile: Profile) {
  const { apiKey, ...rest } = profile;
  return { ...rest, hasApiKey: (apiKey ?? "").length > 0 };
}

export function createProfile(input: ProfileInput): Profile {
  const profile: Profile = { id: randomUUID(), ...input };
  writeJson(PROFILES_PATH, [...listProfiles(), profile]);
  return profile;
}

export function updateProfile(id: string, input: ProfileInput): Profile | undefined {
  const profiles = listProfiles();
  const existing = profiles.find((p) => p.id === id);
  if (!existing) return undefined;
  // Empty apiKey in an update means "keep the stored key" (the client never sees it).
  const updated: Profile = { ...input, id, apiKey: input.apiKey || existing.apiKey };
  writeJson(PROFILES_PATH, profiles.map((p) => (p.id === id ? updated : p)));
  return updated;
}

export function deleteProfile(id: string): boolean {
  const profiles = listProfiles();
  const next = profiles.filter((p) => p.id !== id);
  if (next.length === profiles.length) return false;
  writeJson(PROFILES_PATH, next);
  return true;
}
