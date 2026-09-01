import type { Context, Hono } from "hono";
import {
  ProfileInputSchema,
  createProfile,
  deleteProfile,
  getProfile,
  listProfiles,
  redact,
  resolveProfileAgent,
  updateProfile,
} from "../profiles.js";
import { AgentInputSchema, getAgent, isBuiltInAgent, listAgents, resetAgent, updateAgent } from "../registry.js";
import { getProject } from "../projects.js";
import { probeAgentOptions } from "../probe.js";
import { modelsDevProviders, searchModelsDev, toCandidate } from "../models-dev.js";
import { enrichProviderModels, fetchProviderModels } from "../provider-models.js";
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
  app.get("/api/agents", (c) =>
    c.json(listAgents().map((agent) => ({ ...agent, builtIn: isBuiltInAgent(agent.id) }))),
  );
  /* An agent row is a runtime definition, and its spawn command is a contract
     with a binary somebody else ships — so only the user's half is writable
     (`AgentInputSchema`), and a built-in can always be put back. Nothing here
     touches a running thread: the process it holds was spawned with the old
     command, and the edit reaches it at its next spawn, exactly like every
     other change to how an agent is launched. */
  const agentCrud = crud(AgentInputSchema);
  app.put("/api/agents/:id", agentCrud.update((id, data) => updateAgent(id, data)));
  app.post("/api/agents/:id/reset", (c) => {
    const restored = resetAgent(c.req.param("id"));
    return restored ? c.json(restored) : c.json({ error: "not found" }, 404);
  });

  // Agents are passed in so an agent with no profile of its own still gets one
  // (virtual, never stored) — see defaultProfileFor.
  app.get("/api/profiles", (c) => c.json(listProfiles(listAgents()).map(redact)));
  const profileCrud = crud(ProfileInputSchema);
  app.post("/api/profiles", profileCrud.create((data) => redact(createProfile(data))));
  app.put("/api/profiles/:id", profileCrud.update((id, data) => {
    const updated = updateProfile(id, data);
    return updated && redact(updated);
  }));
  app.delete("/api/profiles/:id", (c) => {
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
    return deleteProfile(id) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  });

  /**
   * What this profile's agent can be configured with, asked by spawning one and
   * throwing it away. The client calls this once per profile, so a thread that
   * has not been sent yet can still offer real settings — see probe.ts for why
   * there is no cheaper way to ask.
   */
  app.post("/api/profiles/:id/options", async (c) => {
    const profile = getProfile(c.req.param("id"));
    if (!profile) return c.json({ error: "unknown profile" }, 404);
    const { projectId, agentId: askedAgent } = await c.req.json();
    // Which of the profile's agents to ask. Optional only when the profile
    // names exactly one (the virtual Default always does).
    const agentId = resolveProfileAgent(profile, askedAgent);
    if (!agentId || !getAgent(agentId)) {
      return c.json({ error: "unknown agent for this profile" }, 404);
    }
    // No falling back to "some other project": the cwd is part of the answer, so
    // probing a different one returns a menu that quietly does not apply here.
    const project = getProject(projectId);
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
  app.post("/api/profiles/:id/fetch-models", async (c) => {
    const body = await c.req.json().catch(() => ({}) as { baseUrl?: string; apiKey?: string });
    let baseUrl = body.baseUrl?.trim() ?? "";
    let apiKey = body.apiKey ?? "";
    if (!baseUrl || !apiKey) {
      const profile = getProfile(c.req.param("id"));
      if (profile) {
        baseUrl = baseUrl || profile.baseUrl;
        apiKey = apiKey || profile.apiKey;
      } else if (!baseUrl) {
        return c.json({ error: "unknown profile" }, 404);
      }
    }
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
