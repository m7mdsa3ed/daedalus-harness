import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { listAgents } from "./registry.js";
import type { CommandInput, McpServerInput, SkillInput } from "./library.js";

/*
 * Import sources: MCP servers, skills and commands already configured for the
 * agents on this machine, offered as library entries. Read-only — nothing is
 * written back to the agents' own config.
 *
 * **Where to look is the agent row's** (`AgentDef.discovery`), not this
 * module's. Two home paths were hardcoded here — `~/.claude.json` and
 * `~/.codex/config.toml`, plus three skill and command directories beside them
 * — so a runtime somebody added could never contribute anything to an import
 * that describes itself as "what is already on this machine", and the two
 * dialects the parsers below understand read as the only two that could exist.
 * The parsers are still code (a JSON file and a TOML file are not the same
 * conversation, exactly as `QuotaProbe.kind`); the paths, and which dialect
 * each is in, are data.
 */

export type Found<T> = T & { source: string };

const HOME = homedir();

/** A home-relative pattern → the real directories it names. One `*` segment is
    allowed and expands to every immediate subdirectory, which is what Claude
    Code's plugin marketplaces need; the segment's own name becomes part of the
    label so two plugins' skills stay tellable apart. */
function expandHome(pattern: string): { path: string; label: string | null }[] {
  const star = pattern.split("/").indexOf("*");
  if (star === -1) return [{ path: join(HOME, ...pattern.split("/")), label: null }];
  const parts = pattern.split("/");
  const root = join(HOME, ...parts.slice(0, star));
  if (!existsSync(root)) return [];
  return readdirSync(root).map((entry) => ({
    path: join(root, entry, ...parts.slice(star + 1)),
    label: entry,
  }));
}

/** `Claude Code`, or `Claude Code (some-plugin)`. The agent's own name, so a
    row someone added is credited by the name they gave it. */
const sourceLabel = (agentName: string, label: string | null) =>
  label ? `${agentName} (${label})` : agentName;
const pairsOf = (map: unknown) =>
  Object.entries((map ?? {}) as Record<string, string>).map(([name, value]) => ({
    name,
    value: String(value),
  }));

/** One `{command, args, env}` / `{url, headers}` entry -> library shape. Both
    dialects below land on this shape. `sse` collapses to http (ACP has no sse
    variant here). */
function fromEntry(name: string, entry: Record<string, unknown>): McpServerInput | null {
  if (typeof entry.url === "string") {
    /* An imported row starts "none": what an agent's own config knows about
       this server is a URL and some headers, never whether it demands OAuth.
       The form's Check — or a save — is what discovers that. */
    return { type: "http", name, url: entry.url, headers: pairsOf(entry.headers), auth: "none" };
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

/** The `claude-json` dialect: a top-level `mcpServers` map plus one per
    project under `projects`. */
function claudeJsonMcpServers(path: string, agentName: string): Found<McpServerInput>[] {
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
      const server = fromEntry(name, entry);
      if (server) found.push({ ...server, source });
    }
  };
  collect(config.mcpServers, sourceLabel(agentName, "global"));
  for (const [cwd, project] of Object.entries((config.projects ?? {}) as Record<string, any>)) {
    collect(project?.mcpServers, sourceLabel(agentName, cwd));
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

/** The `codex-toml` dialect: `[mcp_servers.*]` tables in a TOML file. */
function codexTomlMcpServers(path: string, agentName: string): Found<McpServerInput>[] {
  if (!existsSync(path)) return [];
  return Object.entries(parseCodexMcp(readFileSync(path, "utf8")))
    .map(([name, table]) => {
      const server = fromEntry(name, table); // same command/args/env/url shape
      return server ? { ...server, source: agentName } : null;
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

export async function discoverMcpServers(): Promise<Found<McpServerInput>[]> {
  const found: Found<McpServerInput>[] = [];
  for (const agent of (await listAgents())) {
    for (const source of agent.discovery?.mcp ?? []) {
      for (const { path } of expandHome(source.path)) {
        found.push(
          ...(source.format === "codex-toml"
            ? codexTomlMcpServers(path, agent.name)
            : claudeJsonMcpServers(path, agent.name)),
        );
      }
    }
  }
  return found;
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

export async function discoverCommands(): Promise<Found<CommandInput>[]> {
  return (await everyDeclared("commands")).flatMap(({ path, source }) => commandsIn(path, source));
}

export async function discoverSkills(): Promise<Found<SkillInput>[]> {
  return (await everyDeclared("skills")).flatMap(({ path, source }) => skillsIn(path, source));
}

/** Every directory the agent rows declare for one kind, expanded and labelled.
    A path two agents both name (they do share directories — OpenCode reads
    `.claude/skills` too) is visited once: the same skill found twice is one
    library row offered twice. */
async function everyDeclared(kind: "skills" | "commands"): Promise<{ path: string; source: string }[]> {
  const seen = new Map<string, string>();
  for (const agent of (await listAgents())) {
    for (const pattern of agent.discovery?.[kind] ?? []) {
      for (const { path, label } of expandHome(pattern)) {
        if (!seen.has(path)) seen.set(path, sourceLabel(agent.name, label ?? "global"));
      }
    }
  }
  return [...seen].map(([path, source]) => ({ path, source }));
}
