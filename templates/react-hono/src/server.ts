import { Hono } from "hono";
import { validator } from "hono/validator";
import { basePath, listenPort } from "./base.ts";

// ---------------------------------------------------------------------------
// API — every route lives under /api. `AppType` is what src/client/api.ts uses.
// ---------------------------------------------------------------------------

interface Todo {
  id: number;
  text: string;
  done: boolean;
}

let nextId = 3;
const todos: Todo[] = [
  { id: 1, text: "Describe the app you want in the chat", done: true },
  { id: 2, text: "Watch it take shape in this preview", done: false },
];

const api = new Hono()
  .get("/api/health", (c) => c.json({ ok: true }))
  .get("/api/todos", (c) => c.json(todos))
  .post(
    "/api/todos",
    validator("json", (value, c) => {
      const text = typeof value?.text === "string" ? value.text.trim() : "";
      if (!text) return c.json({ error: "text is required" }, 400);
      return { text };
    }),
    (c) => {
      const todo: Todo = { id: nextId++, text: c.req.valid("json").text, done: false };
      todos.push(todo);
      return c.json(todo, 201);
    },
  )
  .patch("/api/todos/:id", (c) => {
    const todo = todos.find((t) => t.id === Number(c.req.param("id")));
    if (!todo) return c.json({ error: "not found" }, 404);
    todo.done = !todo.done;
    return c.json(todo);
  })
  .delete("/api/todos/:id", (c) => {
    const i = todos.findIndex((t) => t.id === Number(c.req.param("id")));
    if (i < 0) return c.json({ error: "not found" }, 404);
    todos.splice(i, 1);
    return c.body(null, 204);
  });

export type AppType = typeof api;

// ---------------------------------------------------------------------------
// App — mounted under BASE_PATH. In dev, @hono/vite-dev-server loads this
// module and forwards only `<BASE_PATH>api…` to it (see vite.config.ts).
// ---------------------------------------------------------------------------

const base = basePath();
const app = new Hono().basePath(base).route("/", api);

export default app;

// ---------------------------------------------------------------------------
// Production: `NODE_ENV=production node src/server.ts` serves dist/ (built with
// the same BASE_PATH) with an SPA fallback, and the API above.
// ---------------------------------------------------------------------------

if (process.env.NODE_ENV === "production") {
  const [{ serve }, { serveStatic }, { readFile }] = await Promise.all([
    import("@hono/node-server"),
    import("@hono/node-server/serve-static"),
    import("node:fs/promises"),
  ]);
  const stripBase = (p: string) => (p.startsWith(base) ? `/${p.slice(base.length)}` : p);
  app.use("*", serveStatic({ root: "./dist", rewriteRequestPath: stripBase }));
  app.get("*", async (c) => {
    if (c.req.path.startsWith(`${base}api/`)) return c.notFound();
    return c.html(await readFile("./dist/index.html", "utf8"));
  });
  const port = listenPort(3000);
  serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, () => {
    console.log(`Serving http://127.0.0.1:${port}${base}`);
  });
}
