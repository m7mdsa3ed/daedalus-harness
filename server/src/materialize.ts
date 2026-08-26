import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  lstatSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { commands as commandLibrary, skills as skillLibrary, type CommandDef } from "./library.js";
import type { Project } from "./projects.js";

/**
 * Project the workspace's skills and slash commands into the cwd so the agent
 * picks them up natively: symlinks in <cwd>/.claude/skills/, markdown files in
 * <cwd>/.claude/commands/. The agent then advertises the commands over ACP
 * `available_commands_update` like any of its own — the client needs no
 * harness-specific list.
 */
export function materializeProject(project: Project): void {
  materializeSkills(project);
  materializeCommands(project);
}

function materializeSkills(project: Project): void {
  const paths = skillLibrary
    .list()
    .filter((s) => project.skillIds.includes(s.id))
    .map((s) => s.path);
  const skillsDir = join(project.cwd, ".claude", "skills");
  mkdirSync(skillsDir, { recursive: true });
  // Remove stale daedalus-managed symlinks, then link the project's skills.
  for (const entry of readdirSync(skillsDir)) {
    const path = join(skillsDir, entry);
    if (lstatSync(path).isSymbolicLink()) rmSync(path);
  }
  for (const skillPath of paths) {
    const target = resolve(skillPath);
    if (!existsSync(target)) continue;
    const link = join(skillsDir, basename(target));
    if (!existsSync(link)) symlinkSync(target, link);
  }
}

/* Command bodies live in the database, not on disk, so these are written files
   rather than symlinks — and the marker is what keeps the cleanup honest: the
   directory is shared with commands the user made by hand, and only files
   carrying it are ours to delete. */
const MANAGED_MARKER = "<!-- managed by daedalus-harness; edits are overwritten at spawn -->";

function renderCommand(command: CommandDef): string {
  const frontmatter = [
    "---",
    `description: ${JSON.stringify(command.description)}`,
    ...(command.argumentHint ? [`argument-hint: ${JSON.stringify(command.argumentHint)}`] : []),
    "---",
  ].join("\n");
  return `${frontmatter}\n${MANAGED_MARKER}\n\n${command.content}\n`;
}

function materializeCommands(project: Project): void {
  const linked = commandLibrary.list().filter((c) => project.commandIds.includes(c.id));
  const commandsDir = join(project.cwd, ".claude", "commands");
  mkdirSync(commandsDir, { recursive: true });
  for (const entry of readdirSync(commandsDir)) {
    if (!entry.endsWith(".md")) continue;
    const path = join(commandsDir, entry);
    try {
      if (lstatSync(path).isFile() && readFileSync(path, "utf8").includes(MANAGED_MARKER)) {
        rmSync(path);
      }
    } catch {
      // unreadable entry — not ours, leave it alone
    }
  }
  for (const command of linked) {
    const path = join(commandsDir, `${command.name}.md`);
    // A hand-made file with this name survived the sweep above — the user's
    // own command wins over the library's.
    if (existsSync(path)) continue;
    writeFileSync(path, renderCommand(command));
  }
}
