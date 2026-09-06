import type { Context } from "hono";
import type { z } from "zod";
import { WorkspaceError } from "../workspace-fs.js";

export function bearerToken(header: string | undefined, query: string | undefined): string {
  if (header?.startsWith("Bearer ")) return header.slice(7);
  return query ?? "";
}

/* ── Workspace filesystem ──
   Project-scoped, unlike `/api/fs/list`: every path here is relative and
   resolved against the project's own cwd, and a WorkspaceError carries the
   status its refusal deserves — 403 for an escape, 409 for a stale write —
   which app.onError would otherwise flatten into a 500. */
export const workspace = async <T>(c: Context, run: () => T | Promise<T>) => {
  try {
    return c.json((await run()) as object);
  } catch (err) {
    if (err instanceof WorkspaceError) return c.json({ error: err.message }, err.status);
    throw err;
  }
};

export const flag = (c: Context, name: string) => c.req.query(name) === "1";

/**
 * The one create/update shape most of the JSON entities share, verbatim:
 * safeParse → 400 with the issues, create → 201, update → the row or a 404.
 * Only for routes that genuinely match it (profiles, projects, tasks, the
 * scheduled PATCH) — anything with an extra check or a different wrapper
 * (knowledge's `workspace()`, scheduled's session check) stays hand-written.
 *
 * `lenientJson` mirrors the routes that read the body with
 * `.catch(() => ({}))` — a non-JSON body there fails schema validation (400
 * with issues) instead of throwing into app.onError.
 */
export function crud<S extends z.ZodType>(schema: S, opts: { lenientJson?: boolean } = {}) {
  const body = (c: Context) =>
    opts.lenientJson ? c.req.json().catch(() => ({})) : c.req.json();
  return {
    create:
      (make: (data: z.infer<S>) => unknown) =>
      async (c: Context) => {
        const parsed = schema.safeParse(await body(c));
        if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
        return c.json(make(parsed.data) as object, 201);
      },
    update:
      (apply: (id: string, data: z.infer<S>) => unknown) =>
      async (c: Context) => {
        const parsed = schema.safeParse(await body(c));
        if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
        // Untyped Context can't prove the `:id` param exists; every caller
        // mounts these on a `/:id` path.
        const updated = apply(c.req.param("id") as string, parsed.data);
        return updated ? c.json(updated as object) : c.json({ error: "not found" }, 404);
      },
  };
}
