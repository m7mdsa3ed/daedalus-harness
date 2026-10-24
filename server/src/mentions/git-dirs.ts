/* Where a git mention is looked up. A project is not one repository (git.ts
   header): the thread's own directory comes first, then every nested checkout
   the project holds, and a ref is read from the first that has it. */
import { join } from "node:path";
import * as git from "../git.js";
import { projectRoot } from "../workspace-fs.js";

export interface RepoDir {
  /** Absolute; every git call for this repository runs here. */
  dir: string;
  /** Project-relative — `""` is the project itself. */
  path: string;
  name: string;
}

/** The repositories a mention may name, thread first, each worktree once. */
export async function repoDirs(projectId: string, cwd: string): Promise<RepoDir[]> {
  const out: RepoDir[] = [];
  const tops = new Set<string>();
  const add = async (dir: string, path: string, name: string) => {
    const top = await git.toplevelOf(dir).catch(() => null);
    if (!top || tops.has(top)) return;
    tops.add(top);
    out.push({ dir, path, name });
  };
  await add(cwd, "", "Project");
  try {
    const root = await projectRoot(projectId);
    for (const repo of await git.repositories(projectId)) {
      if (repo.path !== "") await add(join(root, repo.path), repo.path, repo.name);
    }
  } catch {
    // A project whose directory has gone has only the thread's own — and that was already tried.
  }
  return out;
}

/** A name a person typed after `@branch:` — never an option, never a revision
    expression: it is checked against `refs/…` by name, so only the characters a
    ref name is made of get through. */
export const REF_NAME = /^[A-Za-z0-9_][A-Za-z0-9_./+-]*$/;
