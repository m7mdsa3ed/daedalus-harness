import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CommandInput, McpServerInput, SkillInput } from "./library.js";

// Import sources: MCP servers and skills already configured for the agents on
// this machine, offered as library entries. Read-only — nothing is written back
// to the agents' own config.

export type Found<T> = T & { source: string };

const HOME = homedir();
const pairsOf = (map: unknown) =>
  Object.entries((map ?? {}) as Record<string, string>).map(([name, value]) => ({
    name,
    value: String(value),
  }));

/** ~/.claude.json entry -> library shape. `sse` collapses to http (ACP has no sse variant here). */
function fromClaudeEntry(name: string, entry: Record<string, unknown>): McpServerInput | null {
  if (typeof entry.url === "string") {
    return { type: "http", name, url: entry.url, headers: pairsOf(entry.headers) };
  }
  if (typeof entry.command === "string") {
    return {
      type: "stdio",
      name,
      command: entry.command,
      args: Array.isArray(entry.args) ? entry.args.map(String) : [],
      env: pairsOf(entry.env),
    };
  }
  return null;
}

function claudeMcpServers(): Found<McpServerInput>[] {
  const path = join(HOME, ".claude.json");
  if (!existsSync(path)) return [];
  let config: Record<string, any>;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  const found: Found<McpServerInput>[] = [];
  const collect = (map: unknown, source: string) => {
    for (const [name, entry] of Object.entries((map ?? {}) as Record<string, Record<string, unknown>>)) {
      const server = fromClaudeEntry(name, entry);
      if (server) found.push({ ...server, source });
    }
  };
  collect(config.mcpServers, "claude (global)");
  for (const [cwd, project] of Object.entries((config.projects ?? {}) as Record<string, any>)) {
    collect(project?.mcpServers, `claude (${cwd})`);
  }
  return found;
}

/**
 * The `[mcp_servers.*]` tables out of ~/.codex/config.toml.
 * ponytail: handles the flat `key = string | array | inline-table` shapes codex
 * writes — reach for a real TOML parser if configs get exotic (multi-line arrays).
 */
function parseCodexMcp(text: string): Record<string, Record<string, unknown>> {
  const tables: Record<string, Record<string, unknown>> = {};
  let current: Record<string, unknown> | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      const name = /^mcp_servers\.(?:"(.+)"|(.+))$/.exec(header[1]);
      current = name ? (tables[name[1] ?? name[2]] = {}) : null;
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (value.startsWith('"')) current[key] = value.slice(1, value.lastIndexOf('"'));
    else if (value.startsWith("[")) {
      try {
        current[key] = JSON.parse(value); // TOML string arrays are valid JSON
      } catch {
        /* multi-line or exotic — skipped */
      }
    } else if (value.startsWith("{")) {
      current[key] = Object.fromEntries(
        [...value.matchAll(/([\w.-]+)\s*=\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]),
      );
    }
  }
  return tables;
}

function codexMcpServers(): Found<McpServerInput>[] {
  const path = join(HOME, ".codex", "config.toml");
  if (!existsSync(path)) return [];
  return Object.entries(parseCodexMcp(readFileSync(path, "utf8")))
    .map(([name, table]) => {
      const server = fromClaudeEntry(name, table); // same command/args/env/url shape
      return server ? { ...server, source: "codex" } : null;
    })
    .filter((s): s is Found<McpServerInput> => s !== null);
}

/** Immediate subdirectories holding a SKILL.md. Symlinks are ours — skip them. */
function skillsIn(root: string, source: string): Found<SkillInput>[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((name) => ({ name, path: join(root, name), source }))
    .filter((s) => !lstatSync(s.path).isSymbolicLink() && existsSync(join(s.path, "SKILL.md")));
}

export function discoverMcpServers(): Found<McpServerInput>[] {
  return [...claudeMcpServers(), ...codexMcpServers()];
}

/** `<root>/*.md` -> library shape; description/argument-hint out of frontmatter. */
function commandsIn(root: string, source: string): Found<CommandInput>[] {
  if (!existsSync(root)) return [];
  const found: Found<CommandInput>[] = [];
  for (const entry of readdirSync(root)) {
    if (!entry.endsWith(".md")) continue;
    const path = join(root, entry);
    let raw: string;
    try {
      if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) continue;
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    // Files the harness materialized itself are not import candidates.
    if (raw.includes("managed by daedalus-harness")) continue;
    const name = entry.slice(0, -3);
    let content = raw;
    let description = "";
    let argumentHint: string | null = null;
    const frontmatter = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
    if (frontmatter) {
      content = raw.slice(frontmatter[0].length);
      for (const line of frontmatter[1].split("\n")) {
        const kv = /^([\w-]+):\s*(.*)$/.exec(line.trim());
        if (!kv) continue;
        const value = kv[2].replace(/^["']|["']$/g, "");
        if (kv[1] === "description") description = value;
        if (kv[1] === "argument-hint") argumentHint = value || null;
      }
    }
    content = content.trim();
    if (!content) continue;
    found.push({ name, description: description || name, argumentHint, content, source });
  }
  return found;
}

export function discoverCommands(): Found<CommandInput>[] {
  return commandsIn(join(HOME, ".claude", "commands"), "claude (global)");
}

export function discoverSkills(): Found<SkillInput>[] {
  const pluginRoot = join(HOME, ".claude", "plugins", "marketplaces");
  const plugins = existsSync(pluginRoot)
    ? readdirSync(pluginRoot).flatMap((plugin) =>
        skillsIn(join(pluginRoot, plugin, "skills"), `claude plugin (${plugin})`),
      )
    : [];
  return [
    ...skillsIn(join(HOME, ".claude", "skills"), "claude (global)"),
    ...skillsIn(join(HOME, ".codex", "skills"), "codex"),
    ...plugins,
  ];
}
