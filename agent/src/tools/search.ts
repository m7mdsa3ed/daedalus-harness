import { spawn } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import type { ToolMeta, ToolRuntime } from "./context.js";
import { inputOf } from "./context.js";
import { resolvePath } from "./fs-tools.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv"]);
const MAX_RESULTS = 200;
const MAX_VISITS = 20_000;
const MAX_FILE_BYTES = 1_000_000;
const SEARCH_TIMEOUT_MS = 10_000;

export const globMeta: ToolMeta = {
  kind: "search",
  title: (input) => `Find files matching ${String(inputOf(input).pattern ?? "pattern")}`,
};

export const grepMeta: ToolMeta = {
  kind: "search",
  title: (input) => `Search for ${String(inputOf(input).pattern ?? "pattern")}`,
};

/* Minimal glob → RegExp: **, *, ? and {a,b}. Enough for the patterns a model
   writes; no dependency, and the fallback for grep's file filter too. */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        out += pattern[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += pattern[i + 2] === "/" ? 3 : 2;
      } else {
        out += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      out += "[^/]";
      i += 1;
    } else if (c === "{") {
      const end = pattern.indexOf("}", i);
      if (end === -1) {
        out += "\\{";
        i += 1;
      } else {
        const alternatives = pattern
          .slice(i + 1, end)
          .split(",")
          .map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&"));
        out += `(?:${alternatives.join("|")})`;
        i = end + 1;
      }
    } else {
      out += (c as string).replace(/[.+^$()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

function* walk(root: string): Generator<string> {
  const queue = [root];
  let visits = 0;
  while (queue.length) {
    const dir = queue.shift() as string;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (visits++ > MAX_VISITS) return;
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) queue.push(full);
      } else if (entry.isFile()) {
        yield full;
      }
    }
  }
}

export function makeGlobTool(rt: ToolRuntime) {
  return tool({
    description:
      "Find files by glob pattern (e.g. `**/*.ts`, `src/{a,b}/*.json`), newest first. Skips node_modules, .git and hidden directories.",
    inputSchema: z.object({
      pattern: z.string().describe("Glob pattern, matched against paths relative to the search root"),
      path: z.string().optional().describe("Directory to search in (default: working directory)"),
    }),
    execute: async ({ pattern, path }) => {
      const root = resolvePath(rt.session.cwd, path ?? ".");
      const re = globToRegExp(pattern);
      const hits: { path: string; mtime: number }[] = [];
      for (const file of walk(root)) {
        const rel = relative(root, file);
        if (!re.test(rel)) continue;
        let mtime = 0;
        try {
          mtime = statSync(file).mtimeMs;
        } catch {
          // stat raced a delete; keep the hit with mtime 0
        }
        hits.push({ path: file, mtime });
        if (hits.length >= MAX_RESULTS * 4) break;
      }
      hits.sort((a, b) => b.mtime - a.mtime);
      const shown = hits.slice(0, MAX_RESULTS);
      if (shown.length === 0) return "No files matched.";
      const listing = shown.map((h) => h.path).join("\n");
      return hits.length > shown.length ? `${listing}\n[${hits.length - shown.length} more not shown]` : listing;
    },
  });
}

export function makeGrepTool(rt: ToolRuntime) {
  return tool({
    description:
      "Search file contents with a regular expression. Uses ripgrep when available. Returns matching lines as path:line:text.",
    inputSchema: z.object({
      pattern: z.string().describe("Regular expression to search for"),
      path: z.string().optional().describe("Directory or file to search (default: working directory)"),
      glob: z.string().optional().describe("Only search files matching this glob (e.g. `*.ts`)"),
      ignore_case: z.boolean().optional().describe("Case-insensitive search"),
    }),
    execute: async ({ pattern, path, glob, ignore_case }, options) => {
      const root = resolvePath(rt.session.cwd, path ?? ".");
      const viaRg = await tryRipgrep(pattern, root, glob, ignore_case, options.abortSignal);
      if (viaRg !== null) return viaRg;
      return grepFallback(pattern, root, glob, ignore_case, options.abortSignal);
    },
  });
}

function tryRipgrep(
  pattern: string,
  root: string,
  glob: string | undefined,
  ignoreCase: boolean | undefined,
  abortSignal: AbortSignal | undefined,
): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const args = ["--no-heading", "--line-number", "--color", "never", "--max-count", "50"];
    if (glob) args.push("--glob", glob);
    if (ignoreCase) args.push("--ignore-case");
    args.push("--", pattern, root);
    const child = spawn("rg", args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    /* A timed-out, aborted or over-budget rg answers with what it found —
       never null, or the sync fallback would rescan what rg already covered. */
    let cutOff: string | null = null;
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.length > 200_000) {
        cutOff ??= "[more matches not shown]";
        child.kill("SIGKILL");
      }
    });
    const killTimer = setTimeout(() => {
      cutOff = `[search timed out after ${SEARCH_TIMEOUT_MS}ms; results may be incomplete]`;
      child.kill("SIGKILL");
    }, SEARCH_TIMEOUT_MS);
    killTimer.unref();
    const onAbort = () => {
      cutOff = "[search cancelled]";
      child.kill("SIGKILL");
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", () => {
      clearTimeout(killTimer);
      resolvePromise(null); // no rg on PATH → fallback
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      abortSignal?.removeEventListener("abort", onAbort);
      const partial = clampLines(out);
      if (cutOff) resolvePromise(partial ? `${partial}\n${cutOff}` : cutOff);
      else if (code === 0) resolvePromise(partial || "No matches.");
      else if (code === 1) resolvePromise("No matches.");
      else resolvePromise(null);
    });
  });
}

function grepFallback(
  pattern: string,
  root: string,
  glob: string | undefined,
  ignoreCase: boolean | undefined,
  abortSignal: AbortSignal | undefined,
): string {
  let re: RegExp;
  try {
    re = new RegExp(pattern, ignoreCase ? "i" : "");
  } catch (err) {
    return `Invalid regular expression: ${(err as Error).message}`;
  }
  const fileRe = glob ? globToRegExp(glob.includes("/") ? glob : `**/${glob}`) : null;
  const lines: string[] = [];
  let isFile = false;
  try {
    isFile = statSync(root).isFile();
  } catch {
    return `No such path: ${root}`;
  }
  const files = isFile ? [root] : walk(root);
  /* Synchronous scan on the main thread: a catastrophically backtracking
     pattern would freeze the whole process, so a wall-clock budget is checked
     between files and the scan bails with what it has. */
  const deadline = Date.now() + SEARCH_TIMEOUT_MS;
  for (const file of files) {
    if (Date.now() > deadline || abortSignal?.aborted) {
      const note =
        abortSignal?.aborted ? "[search cancelled]" : `[search timed out after ${SEARCH_TIMEOUT_MS}ms; results may be incomplete]`;
      return lines.length ? `${lines.join("\n")}\n${note}` : note;
    }
    if (fileRe && !fileRe.test(relative(root, file))) continue;
    let text: string;
    try {
      if (statSync(file).size > MAX_FILE_BYTES) continue;
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\0")) continue;
    const fileLines = text.split("\n");
    for (let i = 0; i < fileLines.length; i++) {
      if (re.test(fileLines[i] as string)) {
        lines.push(`${file}:${i + 1}:${fileLines[i]}`);
        if (lines.length >= MAX_RESULTS) return `${lines.join("\n")}\n[more matches not shown]`;
      }
    }
  }
  return lines.length ? lines.join("\n") : "No matches.";
}

function clampLines(text: string): string {
  const lines = text.trimEnd().split("\n");
  if (lines.length <= MAX_RESULTS) return text.trimEnd();
  return `${lines.slice(0, MAX_RESULTS).join("\n")}\n[${lines.length - MAX_RESULTS} more lines not shown]`;
}
