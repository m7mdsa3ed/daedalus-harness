import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, readdirSync, lstatSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Project } from "./projects.js";

const BEGIN = "<!-- daedalus:profile-instructions:begin -->";
const END = "<!-- daedalus:profile-instructions:end -->";

/**
 * Project the workspace settings into the cwd so the Claude Code agent picks
 * them up natively: extraInstructions -> managed block in <cwd>/.claude/CLAUDE.md,
 * skills -> symlinks in <cwd>/.claude/skills/.
 * ponytail: file projection is the ceiling; switch to an adapter flag
 * (--append-system-prompt passthrough) if one appears.
 */
export function materializeProject(project: Project): void {
  const claudeDir = join(project.cwd, ".claude");
  mkdirSync(claudeDir, { recursive: true });

  const mdPath = join(claudeDir, "CLAUDE.md");
  const current = existsSync(mdPath) ? readFileSync(mdPath, "utf8") : "";
  const stripped = stripManagedBlock(current);
  const block = project.extraInstructions.trim()
    ? `${BEGIN}\n${project.extraInstructions.trim()}\n${END}\n`
    : "";
  const next = (stripped + (stripped && block ? "\n" : "") + block).trimStart();
  if (next !== current) writeFileSync(mdPath, next);

  const skillsDir = join(claudeDir, "skills");
  mkdirSync(skillsDir, { recursive: true });
  // Remove stale daedalus-managed symlinks, then link the project's skills.
  for (const entry of readdirSync(skillsDir)) {
    const path = join(skillsDir, entry);
    if (lstatSync(path).isSymbolicLink()) rmSync(path);
  }
  for (const skillPath of project.skills) {
    const target = resolve(skillPath);
    if (!existsSync(target)) continue;
    const link = join(skillsDir, basename(target));
    if (!existsSync(link)) symlinkSync(target, link);
  }
}

function stripManagedBlock(content: string): string {
  const start = content.indexOf(BEGIN);
  const end = content.indexOf(END);
  if (start === -1 || end === -1) return content;
  return (content.slice(0, start) + content.slice(end + END.length)).trim() + "\n";
}
