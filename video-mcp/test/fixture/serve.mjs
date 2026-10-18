// Tiny static server for the fixture pages: serveFixture() -> { url, close }.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

export function serveFixture() {
  const server = createServer(async (req, res) => {
    const name = new URL(req.url ?? "/", "http://x").pathname.replace(/^\/+/, "") || "index.html";
    if (name.includes("..") || name.includes("/")) return void res.writeHead(404).end();
    try {
      const body = await readFile(join(root, name));
      res.writeHead(200, { "content-type": name.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })),
  );
}
