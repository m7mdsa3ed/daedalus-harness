import type { Hono } from "hono";
import {
  CommandInputSchema,
  McpServerInputSchema,
  SkillInputSchema,
  commands,
  mcpServers,
  skills,
} from "../library.js";
import { discoverCommands, discoverMcpServers, discoverSkills } from "../discover.js";

/** The library: MCP servers, skills and slash commands, shared across
    projects — plus the import scan over the agents' own configs. */
export function libraryRoutes(app: Hono): void {
  for (const [base, reg, schema] of [
    ["mcp-servers", mcpServers, McpServerInputSchema],
    ["skills", skills, SkillInputSchema],
    ["commands", commands, CommandInputSchema],
  ] as const) {
    app.get(`/api/${base}`, (c) => c.json(reg.list()));
    app.post(`/api/${base}`, async (c) => {
      const parsed = schema.safeParse(await c.req.json());
      if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
      return c.json(reg.create(parsed.data as never), 201);
    });
    app.put(`/api/${base}/:id`, async (c) => {
      const parsed = schema.safeParse(await c.req.json());
      if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
      const updated = reg.update(c.req.param("id"), parsed.data as never);
      return updated ? c.json(updated) : c.json({ error: "not found" }, 404);
    });
    app.delete(`/api/${base}/:id`, (c) =>
      reg.remove(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404),
    );
  }

  /** Put one of the harness's own MCP servers in the library. Idempotent — the
      row has a fixed id — so the button is safe to press again. */
  app.post("/api/mcp-servers/builtin/:kind", (c) => {
    const kind = c.req.param("kind");
    if (kind !== "web-search" && kind !== "knowledge") return c.json({ error: "unknown builtin" }, 404);
    return c.json(mcpServers.ensureBuiltin(kind), 201);
  });

  // Importable entries from the agents' own configs, minus what the library already has.
  app.get("/api/import", (c) => {
    const haveMcp = new Set(mcpServers.list().map((s) => s.name));
    const havePaths = new Set(skills.list().map((s) => s.path));
    const haveCommands = new Set(commands.list().map((s) => s.name));
    return c.json({
      mcpServers: discoverMcpServers().filter((s) => !haveMcp.has(s.name)),
      skills: discoverSkills().filter((s) => !havePaths.has(s.path)),
      commands: discoverCommands().filter((s) => !haveCommands.has(s.name)),
    });
  });
}
