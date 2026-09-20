import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type * as acp from "./acp.js";

export interface CommandDef {
  name: string;
  description: string;
  body: string;
  /* An MCP prompt is not a body on disk — it is a `prompts/get` call whose
     answer is the body. When present this is what expansion asks, and `body`
     is only the fallback if it fails. */
  fetch?: (args: string) => Promise<string>;
}

/* The harness materializes commands as `<cwd>/.claude/commands/*.md` and
   skills as `<cwd>/.claude/skills/<name>/SKILL.md`; both are also how a user
   hand-authors them. Commands are advertised over available_commands_update
   and expanded here; skills are listed in the system prompt with an
   instruction to read the SKILL.md before use. */
export function scanCommands(cwd: string): CommandDef[] {
  const dir = join(cwd, ".claude", "commands");
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const commands: CommandDef[] = [];
  for (const file of entries.sort()) {
    let raw: string;
    try {
      raw = readFileSync(join(dir, file), "utf8");
    } catch {
      continue;
    }
    const { frontmatter, body } = splitFrontmatter(raw);
    const description =
      frontmatter.description ??
      body
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("<!--"))[0] ??
      "";
    commands.push({ name: basename(file, ".md"), description, body });
  }
  return commands;
}

export function toAvailableCommands(commands: CommandDef[]): acp.AvailableCommand[] {
  return commands.map((c) => ({
    name: c.name,
    description: c.description,
    input: { hint: "arguments" },
  }));
}

/** `/name args` → the command body with $ARGUMENTS filled; null when it is not a known command. */
export async function expandCommand(commands: CommandDef[], text: string): Promise<string | null> {
  const match = /^\/([\w:-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const command = commands.find((c) => c.name === match[1]);
  if (!command) return null;
  const args = match[2]?.trim() ?? "";
  if (command.fetch) {
    try {
      return await command.fetch(args);
    } catch (err) {
      /* A prompt the server refused is still a message the user sent: fall
         through to the placeholder body rather than failing the turn. */
      return `${command.body}\n\n(could not be fetched: ${(err as Error).message})`;
    }
  }
  if (command.body.includes("$ARGUMENTS")) return command.body.replaceAll("$ARGUMENTS", args);
  return args ? `${command.body}\n\nArguments: ${args}` : command.body;
}

export interface SkillDef {
  name: string;
  description: string;
  path: string;
}

export function scanSkills(cwd: string): SkillDef[] {
  const dir = join(cwd, ".claude", "skills");
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const skills: SkillDef[] = [];
  for (const name of entries.sort()) {
    const path = join(dir, name, "SKILL.md");
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const { frontmatter } = splitFrontmatter(raw);
    skills.push({ name, description: frontmatter.description ?? "", path });
  }
  return skills;
}

function splitFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string } {
  const frontmatter: Record<string, string> = {};
  if (!raw.startsWith("---\n")) return { frontmatter, body: raw };
  const end = raw.indexOf("\n---", 4);
  if (end === -1) return { frontmatter, body: raw };
  for (const line of raw.slice(4, end).split("\n")) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    frontmatter[line.slice(0, sep).trim()] = line
      .slice(sep + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return { frontmatter, body: raw.slice(end + 4).replace(/^\n/, "") };
}
