import { WebSocket } from "ws";

/*
 * The browser relay's server half: a pipe between `chrome-devtools-mcp` and
 * the desktop window whose Preview is driving this thread.
 *
 *   chrome-devtools-mcp ──/cdp/<key>/<sessionId>──▶ server ──/browser──▶ renderer ─IPC─▶ main (cdp-shim.cjs) ─▶ <webview>
 *
 * The agent's MCP server (spawned on this machine) connects with
 * `--wsEndpoint` to the `/cdp` loopback, believing it is a browser. Every frame
 * on that socket goes to the host verbatim and back — the server interprets
 * no CDP. Electron main is what answers as a browser of one page.
 *
 * Frames to the host: `{t:"open"}` (a new client — start a fresh CDP
 * connection), `{t:"cdp", data}`, `{t:"close"}`. From the host: `{t:"cdp",
 * data}` and `{t:"closed", reason}` (the page went away).
 *
 * One host per thread and one client per host, the newest winning both — the
 * terminal's rule (`attachTerminal`). A host that loses its claim hears 4009
 * so its Drive toggle drops.
 */

interface Host {
  ws: WebSocket;
  client: WebSocket | null;
}

const hosts = new Map<string, Host>();

const send = (ws: WebSocket | null | undefined, frame: unknown) => {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
};

/** Take a `/browser` socket as this thread's host. Null, or why it was refused. */
export function attachBrowserHost(sessionId: string, ws: WebSocket): string | null {
  if (!sessionId) return "sessionId is required";

  const previous = hosts.get(sessionId);
  if (previous) {
    previous.client?.close(1001, "the preview is driven from another window now");
    try {
      previous.ws.close(4009, "driven elsewhere");
    } catch {
      /* already gone */
    }
  }

  const host: Host = { ws, client: null };
  hosts.set(sessionId, host);

  ws.on("message", (raw) => {
    let frame: { t?: string; data?: unknown; reason?: unknown };
    try {
      frame = JSON.parse(String(raw)) as typeof frame;
    } catch {
      return;
    }
    if (frame.t === "cdp" && typeof frame.data === "string") {
      if (host.client?.readyState === WebSocket.OPEN) host.client.send(frame.data);
    } else if (frame.t === "closed") {
      host.client?.close(1001, typeof frame.reason === "string" ? frame.reason.slice(0, 120) : "the preview closed");
    }
  });
  ws.on("close", () => {
    if (hosts.get(sessionId) !== host) return;
    hosts.delete(sessionId);
    host.client?.close(1001, "Drive was turned off or the preview closed");
  });
  return null;
}

/** Why a `/cdp` client cannot be taken right now, or null. Asked before the
    upgrade, so the refusal is an HTTP answer and not an open-then-close. */
export function cdpRefusal(sessionId: string): string | null {
  return hosts.get(sessionId)?.ws.readyState === WebSocket.OPEN
    ? null
    : "No preview is driving this thread: open its Preview panel in the Daedalus desktop app and turn on Drive";
}

/** Pipe a `chrome-devtools-mcp` connection to the thread's host. */
export function attachCdpClient(sessionId: string, client: WebSocket): void {
  const host = hosts.get(sessionId);
  if (!host) {
    client.close(1011, "no preview is driving this thread");
    return;
  }
  host.client?.close(1001, "replaced by a newer connection");
  host.client = client;
  send(host.ws, { t: "open" });
  client.on("message", (data) => send(host.ws, { t: "cdp", data: String(data) }));
  client.on("close", () => {
    if (host.client !== client) return;
    host.client = null;
    send(host.ws, { t: "close" });
  });
}
