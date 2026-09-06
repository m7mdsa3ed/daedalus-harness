/*
 * `pnpm dev:tunnel` — the dev server, reachable over https, so the PWA is
 * installable from a phone.
 *
 * A PWA needs a secure context: no https, no service worker and no install.
 * `localhost` counts as one, a LAN IP does not, which is why `pnpm dev` alone
 * gives you a plain browser shortcut on a phone rather than an installed app.
 * Rather than issue a self-signed certificate and teach every device to trust
 * it, this puts a Cloudflare quick tunnel in front — a real certificate on a
 * real hostname, nothing to install on the client.
 *
 * BOTH halves have to be tunnelled. Once the page is https it may not open a
 * ws:// or http:// connection to the harness server; the browser blocks that as
 * mixed content. So this brings up two tunnels — one for Vite, one for the
 * server's port — and prints the pair.
 *
 * It does NOT start the server: keep running `cd server && pnpm dev` in its own
 * terminal. The tunnel 502s until it is up, and recovers on its own.
 *
 * The quick tunnel's hostname is random and changes every run, so the server
 * URL saved on the phone goes stale each time. For a hostname that survives a
 * restart, run your own named tunnels and pass their URLs in:
 *
 *     DAEDALUS_CLIENT_URL=https://dev.example.com \
 *     DAEDALUS_SERVER_URL=https://api.example.com pnpm dev:tunnel
 *
 * — the tunnel for a URL supplied that way is not started here.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLIENT_PORT = Number(process.env.PORT ?? 5173);

/** The server's port comes from its own bootstrap file, so the two agree. */
function serverPort() {
  if (process.env.DAEDALUS_SERVER_PORT) return Number(process.env.DAEDALUS_SERVER_PORT);
  try {
    const config = JSON.parse(
      readFileSync(path.join(ROOT, "..", "server", "data", "config.json"), "utf8")
    );
    return Number(config.port) || 8791;
  } catch {
    return 8791;
  }
}

const children = [];
let shuttingDown = false;

function track(child, label) {
  children.push(child);
  child.on("exit", (code) => {
    if (shuttingDown) return;
    console.error(`\n[dev:tunnel] ${label} exited (${code}) — shutting down.`);
    stop(code ?? 1);
  });
  return child;
}

function stop(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill("SIGTERM");
  // Give cloudflared a moment to tear its connections down politely.
  setTimeout(() => process.exit(code), 300).unref();
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

/**
 * Bring up a quick tunnel and resolve with its https URL.
 *
 * cloudflared announces the hostname on stderr inside a banner and then keeps
 * using the same stream for ordinary logs, so the listener is removed once the
 * URL is in hand — and its output is dropped rather than interleaved with
 * Vite's, since a healthy tunnel has nothing useful to say.
 */
function tunnel(port, label) {
  return new Promise((resolve, reject) => {
    const child = track(
      spawn("cloudflared", ["tunnel", "--url", `http://localhost:${port}`], {
        stdio: ["ignore", "ignore", "pipe"],
      }),
      `cloudflared (${label})`
    );
    child.on("error", (error) =>
      reject(
        error.code === "ENOENT"
          ? new Error("cloudflared is not on PATH — install it, or pass DAEDALUS_*_URL.")
          : error
      )
    );
    let seen = "";
    const onData = (chunk) => {
      seen += chunk;
      const match = seen.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (!match) return;
      child.stderr.off("data", onData);
      child.stderr.resume();
      resolve(match[0]);
    };
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", onData);
    setTimeout(() => reject(new Error(`${label} tunnel gave no URL after 30s`)), 30_000).unref();
  });
}

function token() {
  try {
    return JSON.parse(
      readFileSync(path.join(ROOT, "..", "server", "data", "config.json"), "utf8")
    ).token;
  } catch {
    return null;
  }
}

const port = serverPort();
console.log("[dev:tunnel] opening tunnels…");

const [clientUrl, serverUrl] = await Promise.all([
  process.env.DAEDALUS_CLIENT_URL ?? tunnel(CLIENT_PORT, "client"),
  process.env.DAEDALUS_SERVER_URL ?? tunnel(port, "server"),
]).catch((error) => {
  console.error(`[dev:tunnel] ${error.message}`);
  stop(1);
  return [];
});

if (!clientUrl) process.exit(1);

const secret = token();
console.log(
  [
    "",
    "  ┌─ daedalus dev over https ─────────────────────────────",
    `  │  app     ${clientUrl}`,
    `  │  server  ${serverUrl}   (localhost:${port})`,
    secret ? `  │  token   ${secret}` : "  │  token   — (start the server once to mint one)",
    "  └───────────────────────────────────────────────────────",
    "",
    "  Open the app URL on the phone and enter the server URL + token.",
    "  Both hostnames are public while this runs; the token is all that",
    "  stands in front of an agent that can run commands here.",
    "",
  ].join("\n")
);

// The local binary by path, not by name: this is also runnable as plain
// `node scripts/dev-tunnel.mjs`, where node_modules/.bin is not on PATH.
const vite = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "vite.cmd" : "vite");
track(
  spawn(vite, ["--port", String(CLIENT_PORT), "--strictPort"], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, DAEDALUS_TUNNEL: "1" },
  }),
  "vite"
);
