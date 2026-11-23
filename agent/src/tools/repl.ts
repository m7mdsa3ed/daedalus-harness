import { spawn, spawnSync } from "node:child_process";
import { asSchema, tool, type Tool } from "ai";
import { z } from "zod";
import type { ToolMeta, ToolRuntime } from "./context.js";
import { inputOf } from "./context.js";
import { SEARCH_TOOL } from "./tool-search.js";

/* ── Code mode: one tool call that makes many ──
   The model writes a JavaScript body; it runs in a child process and every
   other tool is an async function inside it. A call crosses back over IPC to
   that tool's real `execute`, so the permission gate each tool carries
   (`checkPermission` inside bash, edit, write and `withMcpGate`) is asked per
   call, with that call's own `kind` — the script never holds a capability the
   model did not already have one call at a time.

   The script is what must not reach anything *except* through those calls,
   and three layers say so, in order of strength:
   - `unshare -rn`: a network namespace with no interfaces. Node 22's
     permission model does not cover the network, and an ungated fetch is a
     door bash only gets through a permission.
   - `node --permission` with nothing granted: no fs, no child_process, no
     worker, no addons. Node calls it a seat belt, not a sandbox; the
     namespace is what holds if it slips.
   - a bare `vm` context: no `process`, `require` or `import()` to start from.
     Not a boundary (a passed-in function's constructor reaches the child's
     realm), only hygiene — the realm it reaches is the locked one.
   The child gets `PATH` and nothing else from the env, so a key in the
   agent's environment is not in the script's.

   A host without unprivileged user namespaces (macOS, a locked-down kernel)
   is never offered the tool: a tool that cannot hold its line is not
   advertised, rather than offered with a weaker one. */

export const REPL_TOOL = "repl";

/** Never callable from a script: a question mid-script has nobody placed to
    answer it, a subagent is a loop of its own, and a deferred-tool search only
    changes what the *model* is sent. */
export const NOT_IN_REPL = new Set(["ask_user", "task", "list_agents", "send_message", SEARCH_TOOL, REPL_TOOL]);

const MAX_MS = 600_000; // bash's own ceiling: a script is at most as long as one command may be
const DISPLAY_LIMIT = 30_000; // turn.ts's OUTPUT_CONTENT_LIMIT: what an inner row draws
const STDERR_LIMIT = 4_000;

export const replMeta: ToolMeta = {
  kind: "other",
  title: (input) => String(inputOf(input).description ?? "").trim() || "Run code",
};

let available: boolean | null = null;
/** Whether this host can make the namespace — probed once per process. */
export function replAvailable(): boolean {
  available ??= spawnSync("unshare", ["-rn", "true"], { stdio: "ignore" }).status === 0;
  return available;
}

/* The child side, passed as `-e` so it needs no file to read (and so no
   `--allow-fs-read`), and runs the same from `tsx` and from `dist/`. Plain JS,
   CommonJS, because that is what `-e` is. */
const RUNNER = String.raw`
const vm = require("node:vm");
const pending = new Map();
let seq = 0;
const call = (name, input) => new Promise((ok, fail) => {
  const id = ++seq;
  pending.set(id, { ok, fail });
  process.send({ t: "call", id, name, input: input === undefined ? {} : input });
});
const fmt = (v) => { if (typeof v === "string") return v; try { return JSON.stringify(v); } catch { return String(v); } };
const finish = (msg) => {
  try { process.send(msg, () => process.exit(0)); }
  catch { process.send({ t: "done", error: "The script's return value could not be sent back (not JSON-serialisable).", logs: msg.logs }, () => process.exit(0)); }
};
process.on("message", (m) => {
  if (m.t === "result") {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (p) m.error !== undefined ? p.fail(new Error(m.error)) : p.ok(m.value);
    return;
  }
  if (m.t !== "run") return;
  const logs = [];
  const log = (...a) => { logs.push(a.map(fmt).join(" ")); };
  const tools = {};
  for (const n of m.tools) tools[n] = (input) => call(n, input);
  const sandbox = { ...tools, tools, console: { log, info: log, warn: log, error: log } };
  const failed = (e) => finish({ t: "done", error: (e && e.stack) || String(e), logs });
  let result;
  try {
    result = vm.runInNewContext("(async () => {\n" + m.code + "\n})()", sandbox, { filename: "repl.js" });
  } catch (e) { return failed(e); }
  Promise.resolve(result).then((value) => finish({ t: "done", value: value === undefined ? null : value, logs }), failed);
});
`;

type ExecOptions = Parameters<NonNullable<Tool["execute"]>>[1];

type ChildMessage =
  | { t: "call"; id: number; name: string; input: unknown }
  | { t: "done"; value?: unknown; error?: string; logs?: string[] };

export function makeReplTool(
  rt: ToolRuntime,
  inner: Record<string, Tool>,
  metaOf: (name: string) => ToolMeta,
): Tool {
  /* MCP tools are callable but not listed: the search tool's catalogue already
     names them, and a description that grew with every linked server would
     cost the cached prefix each time one is linked. */
  const names = Object.keys(inner).filter((n) => !n.startsWith("mcp__"));
  const mcp = Object.keys(inner).some((n) => n.startsWith("mcp__"));
  return tool({
    description: [
      "Run JavaScript that calls your other tools, in one step. Each tool is an async function taking the same input object you would pass it directly, and resolving to its usual text result:",
      `${names.join(", ")}${mcp ? `, and any MCP tool by its full name (mcp__server__tool; load its schema with ${SEARCH_TOOL} first)` : ""}. Every tool is also reachable as tools[name], for a name that is not an identifier.`,
      "Use it for any step that needs two or more tool calls — several reads or searches, edits across files, checking which of many paths exist, a few commands to run — with independent calls run together through Promise.all. Call a tool directly only for a step that is genuinely one call; when you need to see content before deciding, read it here, return the part you need, and act in the next script.",
      "The body runs inside an async function: `await` freely and end with `return <value>`; only what you return (JSON) and console.log lines come back, so return what you need, not whole files. There is no require, import, process, fetch or filesystem — only the tool functions.",
      "Every call still asks the user's permission like a direct call would; a rejected call throws inside the script, and changes already made stay made. The script is killed after 10 minutes.",
    ].join("\n"),
    inputSchema: z.object({
      code: z.string().describe("The body of an async function. End with `return`."),
      description: z
        .string()
        .optional()
        .describe("What the script does in 5-10 words, active voice. It is the line a reader sees beside the call."),
    }),
    execute: ({ code }, options) => runScript(rt, inner, metaOf, code, options),
  });
}

function runScript(
  rt: ToolRuntime,
  inner: Record<string, Tool>,
  metaOf: (name: string) => ToolMeta,
  code: string,
  options: ExecOptions,
): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("unshare", ["-rn", process.execPath, "--permission", "-e", RUNNER], {
      env: { PATH: process.env.PATH ?? "" },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      detached: true, // own process group, so the kill reaches all of it
    });
    let settled = false;
    let stderr = "";
    let seq = 0;
    /* Which tools the script called, and how often — said on the repl row's own
       `_meta.daedalus.repl.calls`, so the client draws it from the row and never
       has to find the `<id>:<n>` rows to count them. Live per call (transient),
       journaled once at the end, before the row completes. */
    const calls: Record<string, number> = {};
    const tally = (journal: boolean) => {
      const update = {
        sessionUpdate: "tool_call_update" as const,
        toolCallId: options.toolCallId,
        _meta: { daedalus: { repl: { calls: { ...calls } } } },
      };
      void (journal ? rt.emit.update(update) : rt.emit.transient(update)).catch(() => {});
    };

    const kill = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    };
    const finish = (text: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.abortSignal?.removeEventListener("abort", onAbort);
      kill();
      if (seq > 0) tally(true);
      resolve(text);
    };
    const onAbort = () => finish("[script cancelled]");
    const timer = setTimeout(() => finish(`[script killed after ${MAX_MS / 1000}s]`), MAX_MS);
    timer.unref();
    if (options.abortSignal?.aborted) return finish("[script cancelled]");
    options.abortSignal?.addEventListener("abort", onAbort, { once: true });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < STDERR_LIMIT) stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => finish(`Could not start the script sandbox: ${err.message}`));
    /* `close`, not `exit`: it waits for the IPC channel, so a `done` sent just
       before the child exits is read before this reports it as a crash. */
    child.on("close", (exitCode, signal) =>
      finish(`[the script sandbox exited (${signal ?? exitCode}) before the script finished]${stderr ? `\n${stderr.trim()}` : ""}`),
    );
    child.on("message", (message: ChildMessage) => {
      if (message.t === "done") return finish(resultText(message));
      if (message.t !== "call") return;
      const id = `${options.toolCallId}:${++seq}`;
      if (Object.prototype.hasOwnProperty.call(inner, message.name)) {
        calls[message.name] = (calls[message.name] ?? 0) + 1;
        tally(false);
      }
      void callInner(rt, inner, metaOf, message, id, options).then((reply) => {
        if (!settled && child.connected) child.send(reply);
      });
    });
    child.send({ t: "run", code, tools: Object.keys(inner) });
  });
}

/* One call from the script, as the transcript draws a direct one: a row of
   its own under `<replId>:<n>`, which is also the id the tool streams its own
   content against (bash's terminal deltas, edit's diff), so those land on it. */
async function callInner(
  rt: ToolRuntime,
  inner: Record<string, Tool>,
  metaOf: (name: string) => ToolMeta,
  call: { id: number; name: string; input: unknown },
  toolCallId: string,
  options: ExecOptions,
): Promise<{ t: "result"; id: number; value?: unknown; error?: string }> {
  const t = Object.prototype.hasOwnProperty.call(inner, call.name) ? inner[call.name] : undefined;
  if (!t?.execute) {
    return { t: "result", id: call.id, error: `No tool named ${call.name}. Available: ${Object.keys(inner).join(", ")}` };
  }
  /* Best-effort: a row that cannot be drawn — the connection closed under a
     cancel while this call was still settling — must not fail the call, nor
     surface later as an unhandled rejection nobody is awaiting. */
  const row = (update: Parameters<ToolRuntime["emit"]["update"]>[0]) => rt.emit.update(update).catch(() => {});
  const meta = metaOf(call.name);
  const rawInput = inputOf(call.input);
  await row({
    sessionUpdate: "tool_call",
    toolCallId,
    title: meta.title(rawInput),
    name: call.name,
    kind: meta.kind,
    status: "in_progress",
    rawInput,
    locations: meta.locations?.(rawInput) ?? [],
  });
  try {
    /* The SDK validates a call's input before `execute`; calling `execute`
       directly skips that, so it is done here against the tool's own schema. */
    const checked = await asSchema(t.inputSchema).validate?.(call.input);
    if (checked && !checked.success) throw new Error(`Invalid input for ${call.name}: ${checked.error.message}`);
    const input = checked ? checked.value : call.input;
    // ponytail: assumes a promise result; a tool whose execute streams (AsyncIterable) needs its last value taken
    const value: unknown = await t.execute(input, { ...options, toolCallId });
    await row({
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: display(value) } }],
    });
    return { t: "result", id: call.id, value };
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    await row({
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "failed",
      content: [{ type: "content", content: { type: "text", text } }],
    });
    return { t: "result", id: call.id, error: text };
  }
}

function display(value: unknown): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");
  return text.length > DISPLAY_LIMIT ? `${text.slice(0, DISPLAY_LIMIT)}\n[output truncated]` : text;
}

/* The client reads these forms back apart — value, `The script threw:`, the
   bracketed stop notes above, and the `console:` tail — in
   `client/src/lib/tools/code.ts`; a change to one is a change to both. */
function resultText(done: { value?: unknown; error?: string; logs?: string[] }): string {
  const logs = done.logs?.length ? `\n\nconsole:\n${done.logs.join("\n")}` : "";
  if (done.error !== undefined) return `The script threw:\n${done.error}${logs}`;
  const value = typeof done.value === "string" ? done.value : JSON.stringify(done.value, null, 2);
  return `${value}${logs}`;
}
