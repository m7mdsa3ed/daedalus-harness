/**
 * opencode.ai free tier (`oc/*`) as a provider.
 *
 * Measured against opencode.ai 2026-10-14 (9router#4842, verified live from
 * this repo with curl): every free request outside this fingerprint answers
 * `403 FreeTierError`.
 *
 *   - endpoint  `/inference/v1/*` (never `/zen/v1/*` for free models)
 *   - `User-Agent: opencode/latest/2.0.26/cli` (v1 `opencode/1.18.x` rejected)
 *   - `x-opencode-session` AND `x-opencode-session-id` (either alone rejected),
 *     plus `x-session-affinity` / `x-session-id` with the same value
 *   - never any `x-opencode-request` header (v1 only, rejected)
 *   - `Authorization: Bearer public`, `x-opencode-client: cli`
 *   - body carries opencode's own `read` + `shell` tools with their EXACT
 *     descriptions and parameter schemas (stubbed ones rejected); the texts
 *     below are verbatim from the v2.0.26 CLI — do not reword
 *   - `tool_choice` absent/`auto`, never `"none"`
 *   - session prefix = 12 hex of `~(timeMs * 0x1000 + counter)` masked to 48
 *     bits; upstream rejects non-small counters, so counter is pinned to 1
 *     and the session is stable per thread (minting one per request burns
 *     quota into `429 FreeUsageLimitError`)
 *   - `stream: true` upstream always; the route layer aggregates for
 *     non-streaming callers
 *
 * Daedalus-only v1: the agent speaks OpenAI chat completions, so the wrapper
 * targets `/chat/completions` for every model. Responses-native models
 * (muse-spark-*) are in the catalog but served over chat — a chat→responses
 * translator is follow-up work if upstream stops answering them there.
 */
import { createHash, randomBytes } from "node:crypto";
import type { FreeProvider, ProviderContext } from "./types.js";

export const OPENCODE_FREE_UA = "opencode/latest/2.0.26/cli";
export const OPENCODE_FREE_CLIENT = "cli";
export const OPENCODE_FREE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const PREFIX_MASK = (1n << 48n) - 1n;
const TIME_MASK = (1n << 36n) - 1n;

/** Verbatim from the opencode v2.0.26 CLI. Upstream compares description AND parameters. */
export const FINGERPRINT_TOOLS = [
  {
    name: "read",
    description:
      "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or directory to read" },
        offset: { type: "integer", minimum: 0, description: "The line or directory entry to start reading from (1-based)" },
        limit: { type: "integer", minimum: 0, description: "The maximum number of lines or directory entries to read (defaults to and capped at 2000)" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "shell",
    description:
      "Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command string to execute" },
        workdir: { type: "string", description: "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead." },
        timeout: { type: "integer", minimum: 0, description: "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default." },
        background: { type: "boolean", description: "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
] as const;

function descendingTimeHex(time: bigint | number, counter: bigint | number): string {
  return ((~(BigInt(time) * 0x1000n + BigInt(counter)) & PREFIX_MASK).toString(16)).padStart(12, "0");
}

function randomTail(): string {
  const bytes = randomBytes(14);
  let out = "";
  for (let i = 0; i < 14; i++) out += BASE62[bytes[i]! % 62];
  return out;
}

/**
 * Stable session per thread: deterministic time field from the thread id,
 * counter pinned to 1 — what the CLI sends, and what the gate accepts.
 * A hash-filled prefix (random counter bits) 403s; an empty/foreign id 403s.
 */
export function sessionForThread(threadId: string): string {
  const digest = createHash("sha256").update(`opencode-free\0${threadId}`).digest();
  const time = BigInt(`0x${digest.subarray(0, 5).toString("hex")}`) & TIME_MASK;
  let tail = "";
  for (let i = 6; i < 20; i++) tail += BASE62[digest[i]! % 62];
  return `ses_${descendingTimeHex(time, 1)}${tail}`;
}

/** Fresh session (one-off probes, tests). Counter pinned to 1 like the CLI. */
export function freshSession(timestamp = Date.now()): string {
  return `ses_${descendingTimeHex(timestamp, 1)}${randomTail()}`;
}

/** Decoded low-12-bit counter of a session prefix — the field the gate checks. */
export function sessionCounter(id: string): number | null {
  const m = OPENCODE_FREE_SESSION_RE.exec(id.trim());
  if (!m) return null;
  return Number(~BigInt(`0x${id.slice(4, 16)}`) & 0xfffn);
}

type ChatTool = { type: string; function: { name: string; description?: string; parameters?: unknown } };

function toolName(tool: unknown): string {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return "";
  const t = tool as { name?: unknown; function?: { name?: unknown } };
  if (typeof t.name === "string" && t.name.trim()) return t.name.trim();
  if (t.function && typeof t.function === "object" && typeof t.function.name === "string") return t.function.name.trim();
  return "";
}

function isExactDefinition(tool: unknown, want: (typeof FINGERPRINT_TOOLS)[number]): boolean {
  const t = tool as { function?: { description?: unknown; parameters?: unknown }; description?: unknown; parameters?: unknown };
  const def = t.function && typeof t.function === "object" ? t.function : t;
  return def.description === want.description && JSON.stringify(def.parameters) === JSON.stringify(want.parameters);
}

/**
 * Caller tools pass through verbatim, except one that already uses a
 * fingerprint name with a different definition: it travels as `<name>_client`
 * so the exact definitions can be appended without a duplicate name.
 */
function applyFingerprint(body: Record<string, unknown>): void {
  const raw = Array.isArray(body.tools) ? (body.tools as unknown[]) : [];
  const taken = new Set(raw.map(toolName));
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const tool of raw) {
    const name = toolName(tool);
    const want = FINGERPRINT_TOOLS.find((f) => f.name === name);
    if (!want) {
      out.push(tool);
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    if (isExactDefinition(tool, want)) {
      out.push(tool);
      continue;
    }
    let alias = `${name}_client`;
    for (let i = 2; taken.has(alias); i++) alias = `${name}_client${i}`;
    taken.add(alias);
    const t = tool as { function?: Record<string, unknown> };
    out.push(t.function && typeof t.function === "object" ? { ...t, function: { ...t.function, name: alias } } : { ...(t as object), name: alias });
  }
  const appended: string[] = [];
  for (const want of FINGERPRINT_TOOLS) {
    if (out.some((t) => toolName(t) === want.name)) continue;
    out.push({ type: "function", function: { name: want.name, description: want.description, parameters: want.parameters } });
    appended.push(want.name);
  }
  body.tools = out;
  // Without the old "must not be used" stub text the model really calls the
  // appended tools, so the system prompt marks them as placeholders instead.
  // Upstream does not gate on prompt text. Wording matters: "not available"
  // made the model refuse the caller's own tools too.
  if (appended.length && Array.isArray(body.messages)) {
    const list = appended.map((n) => `\`${n}\``).join(" or ");
    const note = `Do not call the ${list} tools; they are placeholders that do nothing. Use the other tools you have been given instead.`;
    const messages = body.messages as { role?: unknown; content?: unknown }[];
    const first = messages[0];
    if (first?.role === "system" && typeof first.content === "string") {
      messages[0] = { ...first, content: `${first.content}\n\n${note}` };
    } else {
      body.messages = [{ role: "system", content: note }, ...messages];
    }
  }
}

export const opencodeFree: FreeProvider = {
  id: "opencode-free",

  upstreamPath(_model: string, _askedPath: string): string {
    // Daedalus speaks chat completions only; that is the dialect we forward.
    return "/chat/completions";
  },

  headers(ctx: ProviderContext): Record<string, string> {
    const session = sessionForThread(ctx.threadId || "default");
    return {
      authorization: "Bearer public",
      "user-agent": OPENCODE_FREE_UA,
      "x-opencode-client": OPENCODE_FREE_CLIENT,
      "x-opencode-session": session,
      "x-opencode-session-id": session,
      "x-session-affinity": session,
      "x-session-id": session,
      "x-opencode-project": "global",
    };
  },

  dropRequestHeaders(): string[] {
    // v1-only header: upstream rejects ANY value with 403.
    return ["x-opencode-request"];
  },

  transformBody(body: Record<string, unknown>): boolean {
    // Free tier rejects non-streaming requests: always stream upstream and let
    // the route layer aggregate for non-stream callers.
    body.stream = true;
    if (body.tool_choice === "none") delete body.tool_choice;
    applyFingerprint(body);
    return true;
  },
};
