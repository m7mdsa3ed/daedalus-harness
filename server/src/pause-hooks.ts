/* ── Pause through the runtime's own hooks ──
 *
 * ACP has no pause; `session/cancel` throws the step in flight away. The
 * harness's own runtime holds at its step boundary over `_daedalus/session/
 * pause`, and a runtime that does not own a loop we can reach can still be held
 * at the same boundary *from inside its own hook system*: every step it takes
 * calls a hook of ours, and while the thread is paused that hook simply does
 * not answer. Nothing is refused — a hook that blocks between steps ends the
 * turn, which is a cancel, not a pause — the answer is only late.
 *
 * So the whole mechanism here is a gate per thread: `POST /ph/<key>/<threadId>`
 * answers `{}` at once while the gate is open and waits while it is shut.
 * How a runtime is told to call it is the agent row's (`AgentDef.pauseVia`);
 * whether a thread is paused is the bridge's, which shuts and opens the gate
 * from the one place its hold changes (`setHold`), so a resume, a cancel, a
 * failure hold's release and a dying process all let go through one door.
 *
 * Fails open by construction: a harness that is down answers nothing, the
 * runtime reads the error as a non-blocking hook failure, and the turn goes
 * on — the right way round for a pause.
 *
 * The key in the path is the credential, exactly as `/gw/<key>/`: minted per
 * boot, never stored, read only by children this server spawns.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";

let hooks: { key: string; port: number } | null = null;

/** Called once at boot with the port this server listens on. Until then no
    hook URL is handed out, and an agent that pauses through hooks is offered
    no pause — which is also what a test that never boots a server gets. */
export function configurePauseHooks(opts: { port: number }): void {
  hooks = { key: randomBytes(24).toString("hex"), port: opts.port };
}

/** The URL a thread's hooks call, or "" when there is nothing to call. */
export function pauseHookUrlFor(threadId: string): string {
  if (!hooks) return "";
  return `http://127.0.0.1:${hooks.port}/ph/${hooks.key}/${encodeURIComponent(threadId)}`;
}

/** How long a hook may wait, in seconds. A hook that times out is discarded
    and the runtime carries on — which would lift a pause nobody lifted — so
    this is far past `HELD_TURN_MAX_MS`, the sweep that gives up on a hold. */
export const PAUSE_HOOK_TIMEOUT_S = 7 * 24 * 60 * 60;

const shut = new Map<string, { opened: Promise<void>; open: () => void }>();

/** Shut or open a thread's gate. Idempotent both ways. */
export function setPauseGate(threadId: string, paused: boolean): void {
  const gate = shut.get(threadId);
  if (paused) {
    if (gate) return;
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    shut.set(threadId, { opened, open });
    return;
  }
  if (!gate) return;
  shut.delete(threadId);
  gate.open();
}

/* Not gateway-shim's `safeKeyEqual`: importing that module brings the database
   with it, and this one needs nothing but a gate. */
const sameKey = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

const ok = () => new Response("{}", { headers: { "content-type": "application/json" } });
const notFound = () => new Response(JSON.stringify({ error: "not found" }), { status: 404 });

/** `/ph/<key>/<threadId>` — answers when the thread is not paused. */
export async function handlePauseHook(req: Request): Promise<Response> {
  const [key, id] = new URL(req.url).pathname.slice("/ph/".length).split("/");
  if (!hooks || !key || !id || !sameKey(key, hooks.key)) return notFound();
  const gate = shut.get(decodeURIComponent(id));
  if (!gate) return ok();
  /* The runtime gives up on the request when its turn is cancelled or its
     process dies; nothing should stay parked on a socket nobody reads. */
  await new Promise<void>((resolve) => {
    void gate.opened.then(resolve);
    req.signal.addEventListener("abort", () => resolve(), { once: true });
  });
  return ok();
}

/**
 * Claude Code's half (`pauseVia: "acp-meta"`): the `settings` object that goes
 * into `_meta.claudeCode.options`, which claude-agent-acp hands the Agent SDK
 * as its programmatic settings tier — the `--settings` flag (verified against
 * claude-agent-acp 0.81.0).
 *
 * Two events, both before a model call and neither with a matcher:
 * `PostToolBatch` fires once a step's tool calls have all come back, before the
 * next request to the model — the boundary our own runtime holds at — and in
 * subagents too, so a held parent holds its workers. `UserPromptSubmit` is the
 * other boundary: a thread paused with no turn open holds its next prompt at
 * its first step. Its default timeout is 30s, so both carry ours explicitly.
 *
 * Not `allowedHttpHookUrls`: defining it at any tier turns it on, and ours
 * would then block every HTTP hook of the user's own. The cost is the other
 * way round — a user who keeps an allowlist that misses 127.0.0.1 has ours
 * skipped, and the pause does nothing.
 */
export function claudePauseSettings(url: string): Record<string, unknown> {
  const hook = { hooks: [{ type: "http", url, timeout: PAUSE_HOOK_TIMEOUT_S }] };
  return { hooks: { PostToolBatch: [hook], UserPromptSubmit: [hook] } };
}
