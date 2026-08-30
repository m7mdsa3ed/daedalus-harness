/*
 * `pnpm dev:serve` — the app over https on a hostname that does not change,
 * which is what installing the PWA actually needs.
 *
 * `dev:tunnel` (Cloudflare quick tunnels) is fine for looking at the app on a
 * phone and wrong for INSTALLING it on one, for two reasons:
 *
 *   1. **The hostname is random and ephemeral.** A PWA's identity is its origin
 *      — `id`, `scope` and `start_url` in the manifest are all origin-bound — so
 *      an app installed from `abc-def.trycloudflare.com` is pinned to a
 *      hostname that stops existing when the tunnel restarts. The icon stays on
 *      the home screen and opens nothing.
 *   2. **`trycloudflare.com` is a shared domain with a bad reputation.** Quick
 *      tunnels are widely abused to deliver malware, so Google Safe Browsing
 *      and Play Protect treat the whole domain with suspicion. On Android that
 *      surfaces as the browser refusing to install, or — because Chrome and
 *      Samsung Internet install a PWA as a real, generated APK (a WebAPK) —
 *      as Android's own "Unsafe app blocked" from Play Protect. Neither is
 *      about this app's code, and no amount of manifest fixing moves them.
 *
 * Tailscale Serve answers both: a stable `<host>.<tailnet>.ts.net` name with a
 * genuine Let's Encrypt certificate, reachable only from your tailnet. That
 * last part is also strictly safer than the quick tunnel, which puts both
 * ports on the public internet with only the bearer token in front.
 *
 * It does NOT start the harness server — keep running `cd server && pnpm dev`.
 * Serve just proxies to it, and 502s until it is up.
 *
 * Requires: tailscale up, MagicDNS and HTTPS certificates enabled for the
 * tailnet (Admin console → DNS), and the phone signed into the same tailnet.
 *
 *     pnpm dev:serve              # vite dev server
 *     pnpm dev:serve --preview    # build, then serve the built app
 *
 * Use --preview when the point is the PWA itself: the dev service worker
 * precaches only index.html, so offline and the update prompt do not behave
 * like the real thing.
 */
import { spawn, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLIENT_PORT = Number(process.env.PORT ?? 5173);
/* 443 and 10000 are two of the three ports Tailscale Serve exposes; 8443 is
   deliberately left alone in case something else on this machine already uses
   it — the teardown below is per-port for the same reason. */
const CLIENT_HTTPS_PORT = 443;
const SERVER_HTTPS_PORT = 10000;
const preview = process.argv.includes("--preview");

function config() {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, "..", "server", "data", "config.json"), "utf8"));
  } catch {
    return {};
  }
}

const serverPort = Number(process.env.DAEDALUS_SERVER_PORT ?? config().port) || 8791;

function tailscale(args) {
  return execFileSync("tailscale", args, { encoding: "utf8" });
}

/** The node's own DNS name, minus the trailing dot `status --json` includes. */
function hostname() {
  const status = JSON.parse(tailscale(["status", "--json"]));
  const name = status?.Self?.DNSName?.replace(/\.$/, "");
  if (!name) throw new Error("tailscale is not up, or this node has no MagicDNS name.");
  if (!status?.CertDomains?.length) {
    throw new Error(
      "HTTPS certificates are not enabled for this tailnet — turn them on in the admin console (DNS → HTTPS Certificates)."
    );
  }
  return name;
}

const children = [];
let shuttingDown = false;

function stop(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  // Per-port, never `serve reset`: that would drop every other mapping on this
  // machine, which this script did not create and does not own.
  for (const port of [CLIENT_HTTPS_PORT, SERVER_HTTPS_PORT]) {
    try {
      tailscale(["serve", "--https=" + port, "off"]);
    } catch {
      // Already gone, or the daemon went away first. Nothing to undo.
    }
  }
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 200).unref();
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

let host;
try {
  host = hostname();
  tailscale(["serve", "--bg", "--yes", `--https=${CLIENT_HTTPS_PORT}`, `http://127.0.0.1:${CLIENT_PORT}`]);
  tailscale(["serve", "--bg", "--yes", `--https=${SERVER_HTTPS_PORT}`, `http://127.0.0.1:${serverPort}`]);
} catch (error) {
  console.error(`[dev:serve] ${error.message?.trim() ?? error}`);
  stop(1);
}

const clientUrl = `https://${host}`;
const serverUrl = `https://${host}:${SERVER_HTTPS_PORT}`;

if (preview) {
  console.log("[dev:serve] building the client…");
  try {
    execFileSync(path.join(ROOT, "node_modules", ".bin", "vite"), ["build"], {
      cwd: ROOT,
      stdio: "inherit",
    });
  } catch {
    console.error("[dev:serve] build failed.");
    stop(1);
  }
}

console.log(
  [
    "",
    "  ┌─ daedalus over https (tailnet only) ──────────────────",
    `  │  app     ${clientUrl}`,
    `  │  server  ${serverUrl}   (localhost:${serverPort})`,
    config().token ? `  │  token   ${config().token}` : "  │  token   — (start the server once to mint one)",
    `  │  mode    ${preview ? "preview (built app + real service worker)" : "dev"}`,
    "  └───────────────────────────────────────────────────────",
    "",
    "  This hostname is stable, so an install made from it keeps working.",
    "  Only devices on your tailnet can reach it.",
    "",
  ].join("\n")
);

const vite = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "vite.cmd" : "vite");
const args = preview
  ? ["preview", "--port", String(CLIENT_PORT), "--strictPort"]
  : ["--port", String(CLIENT_PORT), "--strictPort"];

const child = spawn(vite, args, {
  cwd: ROOT,
  stdio: "inherit",
  // Same flag dev:tunnel sets: the page is https on 443, so Vite's HMR client
  // has to be told wss/443 rather than deriving ws://<host>:5173.
  env: { ...process.env, DAEDALUS_TUNNEL: "1" },
});
children.push(child);
child.on("exit", (code) => {
  if (!shuttingDown) {
    console.error(`\n[dev:serve] vite exited (${code}) — shutting down.`);
    stop(code ?? 1);
  }
});
