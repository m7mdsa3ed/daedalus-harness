import { existsSync, mkdirSync, rmSync, symlinkSync, readdirSync, lstatSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { skills as skillLibrary } from "./library.js";
import type { Project } from "./projects.js";

/**
 * Project the workspace's skills into the cwd so the agent picks them up
 * natively: symlinks in <cwd>/.claude/skills/.
 */
export function materializeProject(project: Project): void {
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
