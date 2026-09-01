import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import type { ToolMeta, ToolRuntime } from "./context.js";
import { inputOf } from "./context.js";
import { checkPermission } from "../permissions.js";

const READ_CHAR_LIMIT = 60_000;

export function resolvePath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function short(cwd: string, path: string): string {
  const abs = resolvePath(cwd, path);
  return abs.startsWith(`${cwd}/`) ? abs.slice(cwd.length + 1) : abs;
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
      "Read a file from the filesystem. Returns the file's text, optionally from a line offset with a line limit.",
    inputSchema: z.object({
      path: z.string().describe("File path (absolute, or relative to the working directory)"),
      offset: z.number().int().min(1).optional().describe("1-based line number to start from"),
      limit: z.number().int().min(1).optional().describe("Maximum number of lines to return"),
    }),
    execute: async ({ path, offset, limit }) => {
      const abs = resolvePath(rt.session.cwd, path);
      const text = readFileSync(abs, "utf8");
      let lines = text.split("\n");
      const total = lines.length;
      if (offset) lines = lines.slice(offset - 1);
      if (limit) lines = lines.slice(0, limit);
      let out = lines.join("\n");
      let clipped = false;
      if (out.length > READ_CHAR_LIMIT) {
        out = out.slice(0, READ_CHAR_LIMIT);
        clipped = true;
      }
      const shown = lines.length;
      return shown < total || clipped
        ? `${out}\n\n[${shown} of ${total} lines shown${clipped ? ", output truncated" : ""}]`
        : out;
    },
  });
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
    description: "Write a file, creating it (and its directories) or overwriting it entirely.",
    inputSchema: z.object({
      path: z.string().describe("File path (absolute, or relative to the working directory)"),
      content: z.string().describe("The full contents to write"),
    }),
    execute: async ({ path, content }, options) => {
      const abs = resolvePath(rt.session.cwd, path);
      const oldText = existsSync(abs) ? readFileSync(abs, "utf8") : null;
      await checkPermission(rt.ctx, rt.session, "edit", {
        toolCallId: options.toolCallId,
        toolName: "write_file",
        title: `Write ${short(rt.session.cwd, path)}`,
        kind: "edit",
        rawInput: { path },
      });
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      await rt.emit.update({
        sessionUpdate: "tool_call_update",
        toolCallId: options.toolCallId,
        content: [{ type: "diff", path: abs, oldText, newText: content }],
      });
      return `Wrote ${Buffer.byteLength(content)} bytes to ${abs}`;
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

export function makeEditTool(rt: ToolRuntime) {
  return tool({
    description:
      "Edit a file by exact string replacement. `old_string` must match the file exactly and be unique unless `replace_all` is set.",
    inputSchema: z.object({
      path: z.string().describe("File path (absolute, or relative to the working directory)"),
      old_string: z.string().describe("The exact text to replace"),
      new_string: z.string().describe("The replacement text"),
      replace_all: z.boolean().optional().describe("Replace every occurrence (default: false)"),
    }),
    execute: async ({ path, old_string, new_string, replace_all }, options) => {
      const abs = resolvePath(rt.session.cwd, path);
      const oldText = readFileSync(abs, "utf8");
      if (!oldText.includes(old_string)) {
        throw new Error(`old_string not found in ${abs}`);
      }
      if (!replace_all) {
        const first = oldText.indexOf(old_string);
        if (oldText.indexOf(old_string, first + 1) !== -1) {
          throw new Error(
            `old_string matches more than once in ${abs}; make it unique or set replace_all`,
          );
        }
      }
      await checkPermission(rt.ctx, rt.session, "edit", {
        toolCallId: options.toolCallId,
        toolName: "edit_file",
        title: `Edit ${short(rt.session.cwd, path)}`,
        kind: "edit",
        rawInput: { path },
      });
      const newText = replace_all
        ? oldText.split(old_string).join(new_string)
        : oldText.replace(old_string, new_string);
      writeFileSync(abs, newText);
      await rt.emit.update({
        sessionUpdate: "tool_call_update",
        toolCallId: options.toolCallId,
        content: [{ type: "diff", path: abs, oldText, newText }],
      });
      return `Edited ${abs}`;
    },
  });
}
