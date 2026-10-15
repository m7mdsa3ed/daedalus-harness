import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { experimental_getRealtimeToolDefinitions, tool } from "ai";
import { asc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { db, profiles as profilesTable, projects as projectsTable, voiceProviders as voiceTable } from "./db/index.js";

/**
 * Voice mode: a realtime model (OpenAI Realtime or Gemini Live) in front of a
 * thread, never in the agent's seat. It talks with the person and reaches the
 * thread only through the doors the composer already uses — a send, a cancel,
 * an answer to a pending request — which the browser runs (`onToolCall`), so
 * nothing here executes a tool.
 *
 * What lives here is the server's half: the stored backends and the setup the
 * browser's `experimental_useRealtime` calls for a short-lived token. The key
 * never leaves this process. The session's instructions, voice and tools are
 * bound INTO the token — Gemini takes its whole setup at token time, OpenAI
 * keeps whatever the client's follow-up `session.update` leaves unset — so the
 * browser cannot talk the model out of them.
 */

export const VOICE_PROVIDERS = ["openai", "google"] as const;
export type VoiceProviderId = (typeof VOICE_PROVIDERS)[number];

/** A backend as the browser sees it: everything but the key. */
export interface VoiceProviderView {
  provider: VoiceProviderId;
  model: string;
  voice: string;
  isDefault: boolean;
  hasKey: boolean;
}

export const VoiceInputSchema = z.object({
  /** Empty keeps the stored key — it is never shown back, so the form cannot
      round-trip it. */
  apiKey: z.string().trim().default(""),
  model: z.string().trim().min(1),
  voice: z.string().trim().default(""),
  isDefault: z.boolean().default(false),
});
export type VoiceInput = z.infer<typeof VoiceInputSchema>;

const view = (row: typeof voiceTable.$inferSelect): VoiceProviderView => ({
  provider: row.provider,
  model: row.model,
  voice: row.voice,
  isDefault: row.isDefault,
  hasKey: row.apiKey !== "",
});

export async function listVoiceProviders(): Promise<VoiceProviderView[]> {
  return (await db.select().from(voiceTable).orderBy(asc(voiceTable.provider))).map(view);
}

/** Upsert one provider's row. The first row saved is the default whatever it
    asked; a row saved as the default takes it from the other. */
export async function saveVoiceProvider(provider: VoiceProviderId, input: VoiceInput): Promise<VoiceProviderView> {
  const [existing] = await db.select().from(voiceTable).where(eq(voiceTable.provider, provider));
  const apiKey = input.apiKey || existing?.apiKey || "";
  if (!apiKey) throw new Error("An API key is required");
  const [other] = await db.select().from(voiceTable).where(ne(voiceTable.provider, provider));
  const isDefault = input.isDefault || !other;
  const row = { provider, apiKey, model: input.model, voice: input.voice, isDefault, updatedAt: Date.now() };
  return db.transaction(async (tx) => {
    if (isDefault) await tx.update(voiceTable).set({ isDefault: false }).where(ne(voiceTable.provider, provider));
    const [saved] = await tx
      .insert(voiceTable)
      .values(row)
      .onConflictDoUpdate({ target: voiceTable.provider, set: row })
      .returning();
    return view(saved);
  });
}

/** Remove a row; the remaining one (if any) becomes the default. */
export async function deleteVoiceProvider(provider: VoiceProviderId): Promise<boolean> {
  const gone = await db.delete(voiceTable).where(eq(voiceTable.provider, provider)).returning();
  if (gone.length) await db.update(voiceTable).set({ isDefault: true });
  return gone.length > 0;
}

/* The tools are declared here, executed in the browser. `send_to_agent` answers
   at once and `wait_for_agent` is the long one — it resolves when the turn ends
   OR when the agent stops to ask something — so a permission in the middle of
   a turn reaches the person instead of waiting behind the turn it blocks. */
const tools = {
  send_to_agent: tool({
    description:
      "Give the coding agent a task or a follow-up, in the user's own words — faithful and complete, never summarised. Returns as soon as it is sent; then call wait_for_agent.",
    inputSchema: z.object({ text: z.string().describe("The message for the agent, as the user would type it.") }),
  }),
  wait_for_agent: tool({
    description:
      "Wait until the agent's turn ends or it needs the user (a permission or a question). Returns what happened: the agent's final answer, or the pending request to put to the user.",
    inputSchema: z.object({}),
  }),
  answer_request: tool({
    description:
      "Answer the agent's pending permission request: allow it this once, or deny it. Only after the user clearly said which. Then call wait_for_agent again.",
    inputSchema: z.object({ allow: z.boolean() }),
  }),
  answer_question: tool({
    description:
      "Answer the agent's pending question with the user's own words (an option, yes/no, a number or free text). Only after the user said it. If it reports the question needs the screen, tell the user to answer it there.",
    inputSchema: z.object({ answer: z.string().describe("The user's answer, in their words.") }),
  }),
  stop_agent: tool({
    description: "Stop the agent's running turn. Only when the user asks to stop.",
    inputSchema: z.object({}),
  }),
  agent_status: tool({
    description: "What the agent is doing right now, without waiting.",
    inputSchema: z.object({}),
  }),
};

const INSTRUCTIONS = `You are the voice of a coding agent's thread. You do not do the work yourself and you cannot see the code: the agent can.
- When the user asks for anything about the code, the project or the agent's work, call send_to_agent with their request, then wait_for_agent.
- While waiting, say one short line at most ("Asked it, I'll tell you when it's done"). Never invent progress.
- When wait_for_agent returns an answer, tell the user what the agent did in one or two sentences. Never read code, diffs, file contents, long paths, tables or markdown aloud — summarise them.
- When it returns needs_permission, say the tool and its target in a few words ("it wants to edit config.ts" or "run a shell command: npm test"), never a full path, and call answer_request only once the user decided. Allow is always for this one time.
- When it returns asking_a_question, put the question to the user and call answer_question with their answer. If that says the screen is needed, tell them to answer on screen.
- A message starting "[Update from the agent thread" is news the agent produced while you were not waiting: tell the user in one or two sentences, then handle it as above. It is not something the user said.
- Speak the user's language. Be brief; this is a conversation, not a report.`;

/** Mint a short-lived token for the default backend (or the one named), with
    the session's instructions, voice and tools bound into it. */
export async function voiceSetup(provider?: VoiceProviderId, scope?: { projectId?: string; profileId?: string }): Promise<{
  token: string;
  url: string;
  expiresAt?: number;
  tools: Awaited<ReturnType<typeof experimental_getRealtimeToolDefinitions>>;
}> {
  const rows = await db.select().from(voiceTable);
  /* Project, then profile, then the global default. A scope naming a backend
     this install has no row for (a restored backup, a deleted key) is no say. */
  const scoped = provider
    ? undefined
    : await Promise.all([
        scope?.projectId
          ? db.select({ v: projectsTable.defaultVoiceProvider }).from(projectsTable).where(eq(projectsTable.id, scope.projectId))
          : [],
        scope?.profileId
          ? db.select({ v: profilesTable.voiceProvider }).from(profilesTable).where(eq(profilesTable.id, scope.profileId))
          : [],
      ]).then(([p, f]) => [p[0]?.v, f[0]?.v].map((v) => rows.find((r) => r.provider === v)).find(Boolean));
  const row = provider
    ? rows.find((r) => r.provider === provider)
    : (scoped ?? rows.find((r) => r.isDefault) ?? rows[0]);
  if (!row) throw new Error(provider ? `No ${provider} voice backend is configured` : "No voice backend is configured");
  const defs = await experimental_getRealtimeToolDefinitions({ tools });
  const sessionConfig = {
    instructions: INSTRUCTIONS,
    ...(row.voice ? { voice: row.voice } : {}),
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    tools: defs,
  };
  const factory =
    row.provider === "openai"
      ? createOpenAI({ apiKey: row.apiKey }).experimental_realtime
      : createGoogleGenerativeAI({ apiKey: row.apiKey }).experimental_realtime;
  const token = await factory.getToken({ model: row.model, sessionConfig });
  return { ...token, tools: defs };
}
