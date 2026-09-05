import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import type { ToolMeta, ToolRuntime } from "./context.js";
import { inputOf } from "./context.js";
import { checkPermission } from "../permissions.js";

const READ_CHAR_LIMIT = 60_000;
const DEFAULT_READ_LINES = 2_000;

export function resolvePath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function short(cwd: string, path: string): string {
  const abs = resolvePath(cwd, path);
  return abs.startsWith(`${cwd}/`) ? abs.slice(cwd.length + 1) : abs;
}

/* An `ENOENT` thrown as-is teaches the model nothing: it retries the same
   wrong path, or invents a second wrong one. Every failure below answers with
   what *is* there instead, which is usually enough to fix the call in one
   step rather than three. */
function fsFailure(err: unknown, abs: string, cwd: string, verb: string): Error {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") {
    return new Error(`No such file: ${abs}${suggestions(abs, cwd)}`);
  }
  if (code === "EISDIR") {
    return new Error(`${abs} is a directory, not a file. Use glob to list what is inside it.`);
  }
  if (code === "EACCES" || code === "EPERM") {
    return new Error(`Permission denied ${verb} ${abs}.`);
  }
  return new Error(`Could not ${verb} ${abs}: ${(err as Error)?.message ?? String(err)}`);
}

/** Near-misses in the parent directory: the wrong extension, the wrong case,
    the right name one directory over. Silent when the parent is gone too. */
function suggestions(abs: string, cwd: string): string {
  const parent = dirname(abs);
  let entries: string[];
  try {
    entries = readdirSync(parent).slice(0, 500);
  } catch {
    const up = dirname(parent);
    if (up !== parent && existsSync(up)) return `\n(${parent} does not exist either.)`;
    return "";
  }
  const want = basename(abs).toLowerCase();
  const stem = want.replace(/\.[^.]*$/, "");
  const near = entries
    .filter((e) => {
      const low = e.toLowerCase();
      return low === want || low.startsWith(stem) || stem.startsWith(low.replace(/\.[^.]*$/, ""));
    })
    .slice(0, 8);
  const listed = near.length ? near : entries.slice(0, 8);
  if (!listed.length) return `\n(${short(cwd, parent)} is empty.)`;
  const label = near.length ? "Did you mean" : `In ${short(cwd, parent)}`;
  return `\n${label}: ${listed.join(", ")}${!near.length && entries.length > listed.length ? ", …" : ""}`;
}

function isProbablyBinary(text: string): boolean {
  return text.slice(0, 8_000).includes("\0");
}

/** `cat -n`, so a later edit can name a line and an offset can be checked. */
function numbered(lines: string[], startLine: number): string {
  return lines.map((line, i) => `${String(startLine + i).padStart(6)}\t${line}`).join("\n");
}

export const readMeta: ToolMeta = {
  kind: "read",
  title: (input) => `Read ${String(inputOf(input).path ?? "file")}`,
  locations: (input) => {
    const path = inputOf(input).path;
    return typeof path === "string" ? [{ path }] : [];
  },
};

export function makeReadTool(rt: ToolRuntime) {
  return tool({
    description:
      "Read a file from the filesystem. Lines come back numbered (`     1\\tcontent`) — the numbers are display only, so strip them before using a line as `old_string` in edit_file. Reads the first " +
      `${DEFAULT_READ_LINES} lines unless \`offset\`/\`limit\` say otherwise. Prefer this over \`cat\` in bash. ` +
      "Do not call this for a file already shown in this conversation unless you changed it since — read the earlier result instead, " +
      "and when you do need part of a large file again, ask for that range with `offset`/`limit` rather than the whole file.",
    inputSchema: z.object({
      path: z.string().describe("File path (absolute, or relative to the working directory)"),
      offset: z.number().int().min(1).optional().describe("1-based line number to start from"),
      limit: z.number().int().min(1).optional().describe("Maximum number of lines to return"),
    }),
    execute: async ({ path, offset, limit }) => {
      const abs = resolvePath(rt.session.cwd, path);
      let text: string;
      try {
        text = readFileSync(abs, "utf8");
      } catch (err) {
        throw fsFailure(err, abs, rt.session.cwd, "read");
      }
      /* Reading is what licenses a later edit, and the mtime is what tells a
         stale edit from a wrong one. Recorded even for the answers below. */
      try {
        rt.session.readFiles.set(abs, statSync(abs).mtimeMs);
      } catch {
        // raced a delete; the edit tool will report it in its own words
      }
      if (isProbablyBinary(text)) return `[${abs} is a binary file — ${byteSize(abs)}. Not shown.]`;
      if (text === "") return `[${abs} exists but is empty.]`;

      const all = text.split("\n");
      const total = all.length;
      const start = offset ?? 1;
      if (start > total) {
        throw new Error(`offset ${start} is past the end of ${abs}, which has ${total} lines.`);
      }
      const take = limit ?? DEFAULT_READ_LINES;
      const lines = all.slice(start - 1, start - 1 + take);
      let out = numbered(lines, start);
      let clipped = false;
      if (out.length > READ_CHAR_LIMIT) {
        out = out.slice(0, READ_CHAR_LIMIT);
        clipped = true;
      }
      const end = start + lines.length - 1;
      if (lines.length === total && !clipped) return out;
      const more = end < total ? ` Continue with offset ${end + 1}.` : "";
      return `${out}\n\n[lines ${start}-${end} of ${total}${clipped ? ", truncated on length" : ""}.${more}]`;
    },
  });
}

function byteSize(abs: string): string {
  try {
    return `${statSync(abs).size} bytes`;
  } catch {
    return "unknown size";
  }
}

export const writeMeta: ToolMeta = {
  kind: "edit",
  title: (input) => `Write ${String(inputOf(input).path ?? "file")}`,
  locations: (input) => {
    const path = inputOf(input).path;
    return typeof path === "string" ? [{ path }] : [];
  },
};

export function makeWriteTool(rt: ToolRuntime) {
  return tool({
    description:
      "Write a file, creating it (and its directories) or overwriting it entirely. Use edit_file for a change to part of an existing file; an existing file must have been read in this session before it can be overwritten.",
    inputSchema: z.object({
      path: z.string().describe("File path (absolute, or relative to the working directory)"),
      content: z.string().describe("The full contents to write"),
    }),
    execute: async ({ path, content }, options) => {
      const abs = resolvePath(rt.session.cwd, path);
      let oldText: string | null = null;
      if (existsSync(abs)) {
        try {
          if (statSync(abs).isDirectory()) {
            throw new Error(`${abs} is a directory, not a file.`);
          }
          oldText = readFileSync(abs, "utf8");
        } catch (err) {
          if (err instanceof Error && err.message.endsWith("is a directory, not a file.")) throw err;
          throw fsFailure(err, abs, rt.session.cwd, "read");
        }
        /* Overwriting a file nobody looked at is how a whole file's worth of
           work disappears. One read is the whole cost of not doing that. */
        if (oldText !== "" && !rt.session.readFiles.has(abs)) {
          throw new Error(
            `${abs} already exists and has not been read in this session. Read it first, then write it — or use edit_file to change part of it.`,
          );
        }
      }
      await checkPermission(rt.ctx, rt.session, "edit", {
        toolCallId: options.toolCallId,
        toolName: "write_file",
        title: `Write ${short(rt.session.cwd, path)}`,
        kind: "edit",
        rawInput: { path },
      });
      try {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content);
      } catch (err) {
        throw fsFailure(err, abs, rt.session.cwd, "write");
      }
      rt.session.readFiles.set(abs, statSync(abs).mtimeMs);
      await rt.emit.update({
        sessionUpdate: "tool_call_update",
        toolCallId: options.toolCallId,
        content: [{ type: "diff", path: abs, oldText, newText: content }],
      });
      const lines = content === "" ? 0 : content.split("\n").length;
      return `Wrote ${abs} (${lines} lines, ${Buffer.byteLength(content)} bytes).`;
    },
  });
}

export const editMeta: ToolMeta = {
  kind: "edit",
  title: (input) => `Edit ${String(inputOf(input).path ?? "file")}`,
  locations: (input) => {
    const path = inputOf(input).path;
    return typeof path === "string" ? [{ path }] : [];
  },
};

interface Match {
  /** The text actually present in the file, which may differ from what the
      model asked for by the tolerance that found it. */
  found: string;
  index: number;
  /** How the match was reached, for the note on the way out. */
  via: "exact" | "line-numbers" | "trailing-space" | "indentation";
  count: number;
}

const LINE_NUMBER_PREFIX = /^\s*\d+\t/;

/** The model pasted `read_file`'s numbering back in. Strip it and retry. */
function stripLineNumbers(text: string): string | null {
  const lines = text.split("\n");
  if (!lines.some((l) => LINE_NUMBER_PREFIX.test(l))) return null;
  if (!lines.every((l) => l === "" || LINE_NUMBER_PREFIX.test(l))) return null;
  return lines.map((l) => l.replace(LINE_NUMBER_PREFIX, "")).join("\n");
}

function countOf(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

/** Whitespace a model gets wrong is whitespace it cannot see: the spaces at
    the end of a line, and the indentation it re-typed at a different depth.
    Both are recoverable without guessing, because the *lines* still match
    exactly — and both are applied only when the recovered match is unique. */
function findWithTolerance(text: string, needle: string): Match | null {
  const exact = countOf(text, needle);
  if (exact > 0) return { found: needle, index: text.indexOf(needle), via: "exact", count: exact };

  const renumbered = stripLineNumbers(needle);
  if (renumbered && renumbered !== needle) {
    const count = countOf(text, renumbered);
    if (count > 0) return { found: renumbered, index: text.indexOf(renumbered), via: "line-numbers", count };
  }

  const wanted = (renumbered ?? needle).split("\n");
  const haystack = text.split("\n");
  const rightTrim = (s: string) => s.replace(/[ \t]+$/, "");
  const hits: number[] = [];
  let indented = false;

  for (let i = 0; i + wanted.length <= haystack.length; i++) {
    const window = haystack.slice(i, i + wanted.length);
    const trailingOnly = window.every((line, j) => rightTrim(line) === rightTrim(wanted[j] as string));
    if (trailingOnly) {
      hits.push(i);
      continue;
    }
    /* One shared indentation delta across every line: the same block, pasted
       at a different depth. A per-line difference is a different block. */
    const deltas = window.map((line, j) => indentDelta(line, wanted[j] as string));
    if (deltas.every((d) => d !== null && d === deltas[0])) {
      hits.push(i);
      indented = true;
    }
  }
  if (hits.length !== 1) return null;
  const at = hits[0] as number;
  const found = haystack.slice(at, at + wanted.length).join("\n");
  const index = haystack.slice(0, at).reduce((n, l) => n + l.length + 1, 0);
  return { found, index, via: indented ? "indentation" : "trailing-space", count: 1 };
}

/** The leading-whitespace difference between two lines, or null when their
    content differs at all. Blank lines match any indentation. */
function indentDelta(actual: string, wanted: string): string | null {
  if (actual.trim() === "" && wanted.trim() === "") return "";
  const a = /^[ \t]*/.exec(actual)?.[0] ?? "";
  const w = /^[ \t]*/.exec(wanted)?.[0] ?? "";
  if (actual.slice(a.length) !== wanted.slice(w.length)) return null;
  return String(a.length - w.length);
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/** Where the model probably meant: the lines that look most like the first
    distinctive line of what it asked for. Turns "not found" into a place. */
function nearestLines(text: string, needle: string, cwd: string, abs: string): string {
  const first = (stripLineNumbers(needle) ?? needle)
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 3);
  if (!first) return "";
  const lines = text.split("\n");
  const key = first.slice(0, 60);
  const hits: string[] = [];
  for (let i = 0; i < lines.length && hits.length < 5; i++) {
    const line = lines[i] as string;
    if (line.includes(key) || (key.length > 12 && line.trim().startsWith(key.slice(0, 12)))) {
      hits.push(`${String(i + 1).padStart(6)}\t${line}`);
    }
  }
  if (!hits.length) return `\nNothing in ${short(cwd, abs)} looks like its first line either.`;
  return `\nThe closest lines in the file are:\n${hits.join("\n")}\nRead the file around them and copy the text exactly.`;
}

export function makeEditTool(rt: ToolRuntime) {
  return tool({
    description:
      "Edit a file by exact string replacement. `old_string` must appear in the file exactly — copy it from read_file (without the line-number prefix), including indentation — and must be unique unless `replace_all` is set. Include a line or two of surrounding context to make it unique rather than setting `replace_all`.",
    inputSchema: z.object({
      path: z.string().describe("File path (absolute, or relative to the working directory)"),
      old_string: z.string().describe("The exact text to replace, copied from the file"),
      new_string: z.string().describe("The replacement text"),
      replace_all: z.boolean().optional().describe("Replace every occurrence (default: false)"),
    }),
    execute: async ({ path, old_string, new_string, replace_all }, options) => {
      const abs = resolvePath(rt.session.cwd, path);
      let oldText: string;
      try {
        oldText = readFileSync(abs, "utf8");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "ENOENT") {
          throw new Error(
            `No such file: ${abs}. Use write_file to create it.${suggestions(abs, rt.session.cwd)}`,
          );
        }
        throw fsFailure(err, abs, rt.session.cwd, "read");
      }
      if (old_string === new_string) {
        throw new Error("old_string and new_string are identical — this edit would change nothing.");
      }

      const match = findWithTolerance(oldText, old_string);
      if (!match) {
        const seen = rt.session.readFiles.get(abs);
        const why =
          seen === undefined
            ? `${short(rt.session.cwd, abs)} has not been read in this session, so old_string was written from memory.`
            : mtimeOf(abs) !== seen
              ? `${short(rt.session.cwd, abs)} has changed since it was read — read it again.`
              : `old_string does not appear in ${short(rt.session.cwd, abs)}.`;
        throw new Error(`${why}${nearestLines(oldText, old_string, rt.session.cwd, abs)}`);
      }
      if (match.count > 1 && !replace_all) {
        const where = allLines(oldText, match.found).slice(0, 5).join(", ");
        throw new Error(
          `old_string appears ${match.count} times in ${short(rt.session.cwd, abs)} (lines ${where}). Add surrounding context to name one of them, or set replace_all to change all ${match.count}.`,
        );
      }

      await checkPermission(rt.ctx, rt.session, "edit", {
        toolCallId: options.toolCallId,
        toolName: "edit_file",
        title: `Edit ${short(rt.session.cwd, path)}`,
        kind: "edit",
        rawInput: { path },
      });
      const newText = replace_all
        ? oldText.split(match.found).join(new_string)
        : `${oldText.slice(0, match.index)}${new_string}${oldText.slice(match.index + match.found.length)}`;
      try {
        writeFileSync(abs, newText);
      } catch (err) {
        throw fsFailure(err, abs, rt.session.cwd, "write");
      }
      rt.session.readFiles.set(abs, mtimeOf(abs) ?? 0);
      await rt.emit.update({
        sessionUpdate: "tool_call_update",
        toolCallId: options.toolCallId,
        content: [{ type: "diff", path: abs, oldText, newText }],
      });
      const note =
        match.via === "exact"
          ? ""
          : match.via === "line-numbers"
            ? " (read_file's line-number prefixes were stripped from old_string)"
            : match.via === "trailing-space"
              ? " (matched ignoring trailing whitespace)"
              : " (matched at the file's own indentation)";
      return replace_all
        ? `Edited ${abs}: ${match.count} replacement${match.count === 1 ? "" : "s"}${note}.`
        : `Edited ${abs} at line ${lineOf(oldText, match.index)}${note}.`;
    },
  });
}

function mtimeOf(abs: string): number | null {
  try {
    return statSync(abs).mtimeMs;
  } catch {
    return null;
  }
}

function allLines(text: string, needle: string): number[] {
  const out: number[] = [];
  let i = text.indexOf(needle);
  while (i !== -1 && out.length < 20) {
    out.push(lineOf(text, i));
    i = text.indexOf(needle, i + needle.length);
  }
  return out;
}
