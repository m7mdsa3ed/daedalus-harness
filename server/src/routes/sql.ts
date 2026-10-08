import type { Hono } from "hono";
import { z } from "zod";
import { describeTables, readOnlyQuery } from "../db/index.js";

const QuerySchema = z.object({ sql: z.string().min(1), limit: z.number().int().min(1).max(1000).default(100) });

/* Raw reads for the harness MCP (`sql_schema`, `sql_query`): behind the bearer
   like every `/api` route, read-only by construction (see `readOnlyQuery`). */
export function sqlRoutes(app: Hono): void {
  app.get("/api/sql/schema", async (c) => c.json({ tables: await describeTables(c.req.query("table")) }));

  app.post("/api/sql/query", async (c) => {
    const parsed = QuerySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    try {
      const { fields, rows } = await readOnlyQuery(parsed.data.sql, parsed.data.limit);
      return c.json({ fields, rows, truncated: rows.length === parsed.data.limit });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
}
