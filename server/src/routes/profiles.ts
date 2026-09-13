import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  ProfileInputSchema,
  createProfile,
  deleteProfile,
  getProfile,
  listProfiles,
  redact,
  resolveProfileAgent,
  setProfileFlags,
  updateProfile,
} from "../profiles.js";
import { AgentInputSchema, getAgent, isBuiltInAgent, listAgents, resetAgent, updateAgent } from "../registry.js";
import { evictAgentStatus, getAgentsStatus, installAgent } from "../agent-status.js";
import { getProject } from "../projects.js";
import { probeAgentOptions } from "../probe.js";
import { modelsDevProviders, searchModelsDev, toCandidate } from "../models-dev.js";
import { resolveProfilePresets } from "../profile-presets.js";
import { enrichProviderModels, fetchProviderModels, testProviderModel } from "../provider-models.js";
import type { SessionManager } from "../sessions.js";
import { crud } from "./helpers.js";

/** Agents, profiles (and what a profile's agent can be configured with), and
    the models.dev proxy that feeds the profile editor. */
export function profileRoutes(app: Hono, deps: { sessions: SessionManager }): void {
  const { sessions } = deps;

  /* `builtIn` is computed, not stored: it says this release still defines a
     default for the row, which is exactly the question "is there something to
     reset to". A row someone added by hand has no answer and is not offered
     one. */
  app.get("/api/agents", async (c) =>
    c.json((await listAgents()).map((agent) => ({ ...agent, builtIn: isBuiltInAgent(agent.id) }))),
  );
  /* An agent row is a runtime definition, and its spawn command is a contract
     with a binary somebody else ships — so only the user's half is writable
     (`AgentInputSchema`), and a built-in can always be put back. Nothing here
     touches a running thread: the process it holds was spawned with the old
     command, and the edit reaches it at its next spawn, exactly like every
     other change to how an agent is launched. */
  /* Whether each row's binary is on this machine, and what it says it is
     (agent-status.ts): the install check plus one ACP handshake per agent,
     cached with a short TTL. `?refresh=1` re-measures — the way past the cache
     after an install that just ran. Registered before `/:id` so the literal
     wins. */
  app.get("/api/agents/status", async (c) =>
    c.json(await getAgentsStatus(await listAgents(), { refresh: c.req.query("refresh") === "1" })),
  );
  /* Run the row's own install line, which is the same string the page has
     always offered to copy — installing and updating are one door, because
     `npm install -g` is the same command either way. The status cache is
     evicted by the runner, so the page's re-check reads the new binary. */
  app.post("/api/agents/:id/install", async (c) => {
    const agent = await getAgent(c.req.param("id"));
    if (!agent) return c.json({ error: "not found" }, 404);
    const result = await installAgent(agent);
    /* A failure leaves through the same `{ error }` door every route throw
       does, carrying the command's own output — which is the only thing that
       says *why* an install failed. */
    return result.ok ? c.json(result) : c.json({ error: result.output }, 500);
  });
  const agentCrud = crud(AgentInputSchema);
  app.put(
    "/api/agents/:id",
    agentCrud.update(async (id, data) => {
      evictAgentStatus(id);
      return await updateAgent(id, data);
    }),
  );
  app.post("/api/agents/:id/reset", async (c) => {
    const restored = await resetAgent(c.req.param("id"));
    if (restored) evictAgentStatus(restored.id);
    return restored ? c.json(restored) : c.json({ error: "not found" }, 404);
  });

  // Agents are passed in so an agent with no profile of its own still gets one
  // (virtual, never stored) — see defaultProfileFor.
  app.get("/api/profiles", async (c) => c.json((await listProfiles(await listAgents())).map(redact)));
  /* The coding plans a new profile can start from (profile-presets.ts), each
     with its catalog read from models.dev. Never a failure: a preset whose
     catalog could not be read says so and keeps its URLs. Only the agents this
     install registers are offered on a preset — the form would otherwise save
     a link to a runtime that does not exist here. */
  app.get("/api/profile-presets", async (c) => {
    const known = new Set((await listAgents()).map((a) => a.id));
    const presets = await resolveProfilePresets();
    return c.json({
      presets: presets.map((preset) => ({
        ...preset,
        agents: Object.fromEntries(Object.entries(preset.agents).filter(([id]) => known.has(id))),
      })),
    });
  });
  const profileCrud = crud(ProfileInputSchema);
  app.post("/api/profiles", profileCrud.create(async (data) => redact(await createProfile(data))));
  app.put("/api/profiles/:id", profileCrud.update(async (id, data) => {
    const updated = await updateProfile(id, data);
    return updated && redact(updated);
  }));
  /* The list's switches: one field each, so the client never resends the
     credentials it does not hold to change one. */
  const profilePatchSchema = z.object({
    hidden: z.boolean().optional(),
    disabled: z.boolean().optional(),
  });
  app.patch("/api/profiles/:id", async (c) => {
    const parsed = profilePatchSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const updated = await setProfileFlags(c.req.param("id"), parsed.data);
    return updated ? c.json(redact(updated)) : c.json({ error: "not found" }, 404);
  });
  app.delete("/api/profiles/:id", async (c) => {
    const id = c.req.param("id");
    /* A profile a live thread still spawns from must not vanish under it — the
       thread would keep its profileId and every revive would 404. Trashed
       threads don't block: they are already on their way out. */
    const referencing = sessions.list().filter((s) => s.profileId === id && s.deletedAt === null);
    if (referencing.length > 0) {
      const names = referencing.slice(0, 5).map((s) => `“${s.title}”`).join(", ");
      const more = referencing.length > 5 ? ` and ${referencing.length - 5} more` : "";
      return c.json(
        {
          error: `${referencing.length} thread(s) still use this profile: ${names}${more}. Delete or move them first.`,
        },
        409,
      );
    }
    return (await deleteProfile(id)) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  });

  /**
   * What this profile's agent can be configured with, asked by spawning one and
   * throwing it away. The client calls this once per profile, so a thread that
   * has not been sent yet can still offer real settings — see probe.ts for why
   * there is no cheaper way to ask.
   */
  app.post("/api/profiles/:id/options", async (c) => {
    const profile = await getProfile(c.req.param("id"));
    if (!profile) return c.json({ error: "unknown profile" }, 404);
    const { projectId, agentId: askedAgent } = await c.req.json();
    // Which of the profile's agents to ask. Optional only when the profile
    // names exactly one (the virtual Default always does).
    const agentId = resolveProfileAgent(profile, askedAgent);
    if (!agentId || !await getAgent(agentId)) {
      return c.json({ error: "unknown agent for this profile" }, 404);
    }
    // No falling back to "some other project": the cwd is part of the answer, so
    // probing a different one returns a menu that quietly does not apply here.
    const project = await getProject(projectId);
    if (!project) return c.json({ error: "unknown project" }, 404);
    const refresh = c.req.query("refresh") === "1";
    return c.json(await probeAgentOptions(profile, agentId, project, { refresh }));
  });

  /**
   * The model list behind the profile's credentials — `GET {baseUrl}/models` —
   * mapped onto models.dev for the metadata (name, context, pricing, efforts,
   * modalities). The body may carry `baseUrl`/`apiKey` straight from the form:
   * an unsaved profile fetches with what the user typed, and a saved one falls
   * back to its stored key when the body leaves the key empty (the client never
   * has it). No profile id is required when the body carries both.
   */
  /** The form's credentials, falling back to the saved profile's — the client
      never holds the key, so an empty one means "use the stored one". */
  async function formCredentials(
    id: string,
    body: { baseUrl?: string; apiKey?: string },
  ): Promise<{ baseUrl: string; apiKey: string }> {
    let baseUrl = body.baseUrl?.trim() ?? "";
    let apiKey = body.apiKey ?? "";
    if (!baseUrl || !apiKey) {
      const profile = await getProfile(id);
      if (profile) {
        baseUrl = baseUrl || profile.baseUrl;
        apiKey = apiKey || profile.apiKey;
      }
    }
    return { baseUrl, apiKey };
  }

  app.post("/api/profiles/:id/fetch-models", async (c) => {
    const body = await c.req.json().catch(() => ({}) as { baseUrl?: string; apiKey?: string });
    const { baseUrl, apiKey } = await formCredentials(c.req.param("id"), body);
    if (!baseUrl) return c.json({ error: "no base URL to fetch models from" }, 400);
    try {
      const models = await fetchProviderModels(baseUrl, apiKey);
      return c.json({ models: await enrichProviderModels(models) });
    } catch (err) {
      // The provider's answer (or absence of one) is the message worth showing.
      return c.json({ error: err instanceof Error ? err.message : "the provider fetch failed" }, 502);
    }
  });

  /**
   * Run one of the profile's models for real — the same credentials, the same
   * id, the same `max_tokens` a turn would send — and report what the provider
   * said. The listing route proves the id exists; this proves a turn on it
   * would start, which is a different question (balance, access, and a stored
   * output cap the provider rejects as too large).
   */
  app.post("/api/profiles/:id/test-model", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      model?: string;
      maxOutputTokens?: number;
      baseUrl?: string;
      apiKey?: string;
    };
    const model = body.model?.trim() ?? "";
    if (!model) return c.json({ error: "no model to test" }, 400);
    const { baseUrl, apiKey } = await formCredentials(c.req.param("id"), body);
    if (!baseUrl) return c.json({ error: "no base URL to test against" }, 400);
    try {
      return c.json(
        await testProviderModel({
          baseUrl,
          apiKey,
          model,
          ...(typeof body.maxOutputTokens === "number" && body.maxOutputTokens > 0
            ? { maxOutputTokens: Math.round(body.maxOutputTokens) }
            : {}),
        }),
      );
    } catch (err) {
      // The provider's own words — the message is the whole point of the test.
      return c.json({ error: err instanceof Error ? err.message : "the model test failed" }, 502);
    }
  });

  /**
   * models.dev, proxied. The full catalog is ~4.4 MB, so the client searches
   * server-side and gets trimmed entries; an unreachable upstream is a 502 the
   * UI renders as "enrichment unavailable", not an editor-breaking error.
   *
   * The reason travels with the 502. A bare `catch {}` here reported "couldn't
   * reach models.dev" for a fetch that failed inside this process — a DNS answer
   * this host can't route, a TLS trust store, an aborted read — and that message
   * sends everyone to check whether models.dev is up when the answer is on this
   * side. `detail` is the thrown message; the log line is the whole error.
   */
  function modelsDevUnreachable(c: Context, err: unknown) {
    console.error("models.dev request failed", err);
    const detail = err instanceof Error ? (err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message) : String(err);
    return c.json({ error: "couldn't reach models.dev", detail }, 502);
  }

  app.get("/api/models-dev/providers", async (c) => {
    try {
      return c.json({ providers: await modelsDevProviders() });
    } catch (err) {
      return modelsDevUnreachable(c, err);
    }
  });

  app.get("/api/models-dev/search", async (c) => {
    try {
      const provider = c.req.query("provider") || undefined;
      const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
      const hits = await searchModelsDev(c.req.query("q") ?? "", { provider, limit });
      return c.json({ models: hits.map(toCandidate) });
    } catch (err) {
      return modelsDevUnreachable(c, err);
    }
  });
}
