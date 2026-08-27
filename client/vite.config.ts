import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// `pnpm dev:tunnel` sets this. Behind a Cloudflare quick tunnel the page is
// https on port 443, but Vite's HMR client derives its socket from the dev
// server's own port — it would try wss://<tunnel host>:5173 and never connect.
const tunnelled = !!process.env.DAEDALUS_TUNNEL;

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Reach the dev server by whatever name the machine has — a LAN IP from a
    // phone, a tunnel hostname, a container alias. Vite otherwise answers a
    // Host header it does not recognise with "Blocked request".
    //
    // This turns off Vite's DNS-rebinding protection: while `pnpm dev` runs, a
    // page on any site the browser visits can point a hostname it controls at
    // this port and read what the dev server serves. That is source, not
    // secrets — the server URL and token live in localStorage on whatever
    // origin you actually use — but it is why this is a dev-only setting and
    // not something to carry into a deployment.
    allowedHosts: true,
    // No point allowing every hostname if the socket only answers on loopback.
    host: true,
    // The tunnel terminates TLS and forwards to plain http here, so the port
    // and scheme the browser must use are the tunnel's, not ours.
    ...(tunnelled ? { hmr: { protocol: "wss" as const, clientPort: 443 } } : {}),
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
});
