import type { Hono } from "hono";
import { getConfig } from "../config.js";
import { threadActor } from "../task-threads.js";
import type { WorkflowRunner } from "../workflows.js";

/**
 * The loopback the `harness` MCP server drives — outside `/api`, so outside the
 * bearer check: the per-boot key the workflow runner mints is the credential,
 * and the session id after it names the thread the call is made for.
 *
 * It is one generic proxy, not a route per tool: a request to
 * `/hm/<key>/<sessionId>/api/<rest>` is re-dispatched, in-process, to the
 * app's own `/api/<rest>` with the server's bearer attached. That is what makes
 * the MCP the client's equal — every validation, side effect, restart and event
 * a browser route fires is the same code, because it *is* the same route. The
 * child (`harness-mcp.ts`) only names which paths its tools reach.
 */
export function harnessRoutes(app: Hono, deps: { runner: WorkflowRunner }): void {
  const { runner } = deps;
  const marker = "/api/";

  app.all("/hm/:key/:sessionId/api/*", async (c) => {
    const caller = runner.resolveCaller(c.req.param("key") ?? "", c.req.param("sessionId") ?? "");
    if (!caller) return c.json({ error: "not found" }, 404);

    /* The path after `/api/` is the client's own route, verbatim. Taken off the
       raw path rather than the wildcard param so a `:`-free forward stays a
       plain string. */
    const at = c.req.path.indexOf(marker);
    const rest = at === -1 ? "" : c.req.path.slice(at + marker.length);

    const source = new URL(c.req.url);
    const target = new URL(`${marker}${rest}`, source.origin);
    target.search = source.search;

    const method = c.req.method.toUpperCase();
    const carriesBody = method !== "GET" && method !== "HEAD";
    let body: BodyInit | undefined;
    if (carriesBody) {
      const bytes = await c.req.arrayBuffer();
      // A route that parses JSON must never see an empty body.
      body = bytes.byteLength > 0 ? bytes : "{}";
    }

    const headers = new Headers();
    headers.set("authorization", `Bearer ${getConfig().token}`);
    /* Said by the harness, never by the agent: the thread's runtime and title,
       which `routes/tasks.ts` writes as a comment's author and an activity row's
       actor. Set after nothing the caller sent is copied, so it cannot be forged. */
    headers.set("x-harness-actor", encodeURIComponent(await threadActor(caller)));
    const contentType = c.req.header("content-type");
    headers.set("content-type", contentType ?? "application/json");

    const response = await app.fetch(new Request(target, { method, headers, body }));
    return new Response(response.body, { status: response.status, headers: response.headers });
  });
}
