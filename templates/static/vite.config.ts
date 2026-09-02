import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

/** URL prefix the app is served under (from BASE_PATH), normalised to "/…/" or "/". */
function basePath(): string {
  const raw = (process.env.BASE_PATH ?? "").trim();
  if (raw === "" || raw === "/") return "/";
  return `/${raw.replace(/^\/+|\/+$/g, "")}/`;
}

function listenPort(fallback: number): number {
  const n = Number(process.env.PORT);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Every top-level `*.html` is a page — add `about.html` and it is built and served. */
function pages(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(import.meta.dirname)) {
    if (entry.endsWith(".html")) out[entry.slice(0, -5)] = resolve(import.meta.dirname, entry);
  }
  return out;
}

export default defineConfig({
  base: basePath(),
  plugins: [tailwindcss()],
  build: { rollupOptions: { input: pages() } },
  server: {
    host: "127.0.0.1",
    port: listenPort(5173),
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: listenPort(4173),
    strictPort: true,
  },
});
