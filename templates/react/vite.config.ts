import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
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

export default defineConfig({
  base: basePath(),
  plugins: [react(), tailwindcss()],
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
