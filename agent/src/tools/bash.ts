import { spawn } from "node:child_process";
import { tool } from "ai";
import { z } from "zod";
import type { ToolMeta, ToolRuntime } from "./context.js";
import { inputOf } from "./context.js";
import { checkPermission } from "../permissions.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const OUTPUT_LIMIT = 64_000;
const DELTA_THROTTLE_MS = 100;

export const bashMeta: ToolMeta = {
  kind: "execute",
  /* The model's own sentence when it wrote one, and the command itself when it
     did not — a reader gets prose or the thing that ran, never "Bash" twice. */
  title: (input) => {
    const said = String(inputOf(input).description ?? "").trim();
    if (said) return said;
    const command = String(inputOf(input).command ?? "");
    return command.length > 80 ? `${command.slice(0, 80)}…` : command || "Run command";
  },
};

export function makeBashTool(rt: ToolRuntime) {
  return tool({
    description:
      "Execute a shell command. Each call is a fresh `bash -c` in the session's working directory, so `cd` does not carry over between calls — use absolute paths or chain with `&&`. stdout and stderr stream back combined, the command is killed at the timeout, and a non-zero exit is reported rather than thrown. stdin is closed, so never run an interactive command; prefer the read_file, glob and grep tools over cat, find and grep.",
    inputSchema: z.object({
      command: z.string().describe("The shell command to run"),
      description: z
        .string()
        .optional()
        .describe(
          "Clear, concise description of what this command does in 5-10 words, in active voice (`ls` → \"List files in current directory\"). It is the line a reader sees beside the call.",
        ),
      timeout_ms: z
        .number()
        .int()
        .min(1000)
        .max(MAX_TIMEOUT_MS)
        .optional()
        .describe(`Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})`),
    }),
    execute: async ({ command, description, timeout_ms }, options) => {
      await checkPermission(rt.ctx, rt.session, "execute", {
        toolCallId: options.toolCallId,
        toolName: "bash",
        title: bashMeta.title({ command, description }),
        kind: "execute",
        rawInput: { command, ...(description ? { description } : {}) },
      });
      return runCommand(rt, command, timeout_ms ?? DEFAULT_TIMEOUT_MS, options.toolCallId, options.abortSignal);
    },
  });
}

function runCommand(
  rt: ToolRuntime,
  command: string,
  timeoutMs: number,
  toolCallId: string,
  abortSignal: AbortSignal | undefined,
): Promise<string> {
  return new Promise((resolvePromise) => {
    const child = spawn("bash", ["-c", command], {
      cwd: rt.session.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // own process group, so the kill below reaches backgrounded grandchildren
    });

    let output = "";
    let truncated = false;
    let pendingDelta = "";
    let deltaTruncated = false;
    let deltaTimer: NodeJS.Timeout | null = null;

    /* Killing `child` alone reaps only `bash -c`; anything it backgrounded
       survives. Signal the whole group, guarding the race where it exited. */
    const killTree = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // group already gone
      }
    };

    /* Codex-style live output: the content block is the tool result, the
       stream is `_meta.terminal_output_delta` on interim updates, which the
       client accumulates. Transient — a load replay gets the final text. */
    const flushDelta = () => {
      deltaTimer = null;
      if (!pendingDelta) return;
      const data = pendingDelta;
      pendingDelta = "";
      void rt.emit.transient({
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "in_progress",
        _meta: { terminal_output_delta: { data } },
      });
    };
    const onChunk = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (output.length < OUTPUT_LIMIT) {
        output += text;
        if (output.length > OUTPUT_LIMIT) {
          output = output.slice(0, OUTPUT_LIMIT);
          truncated = true;
        }
      } else truncated = true;
      pendingDelta += text;
      if (pendingDelta.length > OUTPUT_LIMIT) {
        // keep the tail — the newest bytes are the ones a live view is watching
        pendingDelta = pendingDelta.slice(-OUTPUT_LIMIT);
        if (!deltaTruncated) {
          deltaTruncated = true;
          pendingDelta = `[stream truncated]\n${pendingDelta}`;
        }
      }
      deltaTimer ??= setTimeout(flushDelta, DELTA_THROTTLE_MS);
    };
    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);

    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);
    killTimer.unref();
    const onAbort = () => killTree();
    abortSignal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      cleanup();
      resolvePromise(`Failed to start command: ${err.message}`);
    });
    child.on("close", (code, signal) => {
      cleanup();
      let result = output;
      if (truncated) result += "\n[output truncated]";
      if (timedOut) {
        result += `\n[command timed out after ${timeoutMs}ms and was killed. Re-run a longer job with a bigger timeout_ms, or in the background writing to a log file.]`;
      } else if (signal) result += `\n[killed by ${signal}]`;
      else if (code !== 0) result += `\n[exit code ${code}${output.trim() ? "" : " — the command printed nothing"}]`;
      resolvePromise(result || "[the command produced no output and exited 0]");
    });

    function cleanup() {
      clearTimeout(killTimer);
      if (deltaTimer) clearTimeout(deltaTimer);
      flushDelta();
      abortSignal?.removeEventListener("abort", onAbort);
    }
  });
}
