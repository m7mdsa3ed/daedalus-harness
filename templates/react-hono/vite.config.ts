import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import devServer from "@hono/vite-dev-server";
import nodeAdapter from "@hono/vite-dev-server/node";
import { basePath, listenPort } from "./src/base.ts";

const base = basePath();
const escaped = base.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

export default defineConfig({
  base,
  plugins: [
    react(),
    tailwindcss(),
    devServer({
      entry: "src/server.ts",
      adapter: nodeAdapter,
      injectClientScript: false,
      // The plugin tests `exclude` against the RAW request url (prefix included)
      // and never falls through to Vite once Hono has answered, so hand it only
      // `<BASE_PATH>api…` and let Vite own index.html, the SPA fallback and HMR.
      exclude: [new RegExp(`^(?!${escaped}api(?:/|\\?|$))`)],
    }),
  ],
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
