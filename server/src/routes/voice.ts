import type { Hono } from "hono";
import { z } from "zod";
import type { SessionManager } from "../sessions.js";
import {
  VOICE_PROVIDERS,
  VoiceInputSchema,
  deleteVoiceProvider,
  listVoiceProviders,
  saveVoiceProvider,
  voiceSetup,
  type VoiceProviderId,
} from "../voice.js";

const isProvider = (value: string | undefined): value is VoiceProviderId =>
  (VOICE_PROVIDERS as readonly string[]).includes(value ?? "");

/* A finished line of the voice conversation, as the browser heard it. One
   update per line: a line is said once it is whole, never streamed, because
   the live caption is the call card's and the transcript only keeps what was
   finished. */
const VoiceLineSchema = z.object({
  voiceId: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  text: z.string().trim().min(1),
});

export function voiceRoutes(app: Hono, deps: { sessions: SessionManager }): void {
  const { sessions } = deps;

  app.get("/api/voice", async (c) => c.json(await listVoiceProviders()));

  app.put("/api/voice/:provider", async (c) => {
    const provider = c.req.param("provider");
    if (!isProvider(provider)) return c.json({ error: "unknown provider" }, 404);
    const parsed = VoiceInputSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    try {
      return c.json(await saveVoiceProvider(provider, parsed.data));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.delete("/api/voice/:provider", async (c) => {
    const provider = c.req.param("provider");
    if (!isProvider(provider)) return c.json({ error: "unknown provider" }, 404);
    return (await deleteVoiceProvider(provider)) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  });

  /* What `experimental_useRealtime` fetches by itself (`api.token`). It sends
     no Authorization header, so the bearer rides `?token=` like a socket's.
     Its body (`{ sessionConfig }`) is ignored on purpose: the session is the
     server's, bound into the token. `?provider=` picks a backend; without it,
     `?sessionId=` resolves project, then profile, then the default. A provider that refuses is a 502 with its own words. */
  app.post("/api/voice/setup", async (c) => {
    const provider = c.req.query("provider") || undefined;
    if (provider !== undefined && !isProvider(provider)) return c.json({ error: "unknown provider" }, 404);
    try {
      const session = sessions.get(c.req.query("sessionId") ?? "");
      return c.json(await voiceSetup(provider, session && { projectId: session.projectId, profileId: session.profileId }));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  /* A finished voice line goes into the thread as `_daedalus/voice` — journaled
     like a `!` row, so it comes back on a reload and on every device, and like
     one it is not a prompt: no turn, and the agent is never told. What reached
     the agent did so through the ordinary send. */
  app.post("/api/sessions/:id/voice", async (c) => {
    const session = sessions.get(c.req.param("id"));
    if (!session) return c.json({ error: "not found" }, 404);
    if (session.deletedAt !== null) return c.json({ error: "session deleted" }, 409);
    const parsed = VoiceLineSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    sessions.emitOn(session.id, {
      ev: "update",
      seq: 0,
      historyReplay: false,
      update: { sessionUpdate: "_daedalus/voice", ...parsed.data },
    });
    return c.json({ ok: true });
  });
}
