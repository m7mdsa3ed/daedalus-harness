/**
 * The scripts a project's `package.json` files declare — read off the disk,
 * never stored. The `!` completer's second suggestion list, beside the saved
 * helpers: a helper is a row the user wrote, a script is one the project
 * already shipped, and both are "the small shell actions this workspace
 * runs".
 *
 * One directory deep only, on purpose: that is the shape of a monorepo's
 * packages without following `workspaces` into the deep, and a walk that
 * recursed would read `node_modules`-scale trees to suggest nothing worth
 * typing. The lines this returns run through the same
 * `POST /api/sessions/:id/shell` door any other `!` line does — a nested
 * script's command carries its own `cd`, so nothing here needs a cwd of its
 * own the way a helper row has.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { projectRoot } from "./workspace-fs.js";

/** One runnable script: the name to read (dir-qualified when nested) and the
    shell line that runs it from the project root. */
export interface ProjectScript {
  name: string;
  command: string;
}

/** A word that needs no quoting in the line we hand a shell. */
const shellWord = (word: string) => (/^[\w.@:-]+$/.test(word) ? word : JSON.stringify(word));

/** `pnpm`/`npm`/`yarn`/`bun` for one package directory: the
    `packageManager` field wins (it is the project's own statement about
    itself), then whichever lockfile sits beside the manifest, then npm — the
    one every package.json is born runnable under. */
async function runnerFor(dir: string, pkg: { packageManager?: unknown }): Promise<string> {
  const declared =
    typeof pkg.packageManager === "string" && pkg.packageManager.trim()
      ? pkg.packageManager.trim().split("@")[0]
      : "";
  if (declared) return declared;
  const entries = new Set(await readdir(dir).catch(() => [] as string[]));
  if (entries.has("pnpm-lock.yaml")) return "pnpm";
  if (entries.has("yarn.lock")) return "yarn";
  if (entries.has("bun.lockb") || entries.has("bun.lock")) return "bun";
  return "npm";
}

/** The scripts of one manifest, or nothing — a missing, unreadable or
    unparseable package.json is an ordinary state of a directory, not an
    error the route should throw. */
async function scriptsIn(
  manifest: string,
  dir: string,
  /** The directory's name relative to the root, or null for the root itself —
      both the name qualifier and the `cd` the nested command needs. */
  subdir: string | null,
): Promise<ProjectScript[]> {
  let pkg: { scripts?: unknown; packageManager?: unknown };
  try {
    pkg = JSON.parse(await readFile(manifest, "utf8"));
  } catch {
    return [];
  }
  const scripts =
    typeof pkg.scripts === "object" && pkg.scripts !== null
      ? Object.entries(pkg.scripts as Record<string, unknown>)
      : [];
  const runner = await runnerFor(dir, pkg);
  const out: ProjectScript[] = [];
  for (const [name, command] of scripts) {
    if (typeof command !== "string" || !command.trim()) continue;
    const script = shellWord(name);
    out.push({
      name: subdir ? `${subdir}:${name}` : name,
      command: subdir
        ? `cd ${shellWord(subdir)} && ${runner} run ${script}`
        : `${runner} run ${script}`,
    });
  }
  return out;
}

/** The scripts under one directory — a project's root, or a thread's cwd. Split
    from `listProjectScripts` so a caller that already holds the directory (a
    spawn, which has the project in hand) reads it without re-resolving the
    project through the database. */
export async function listScriptsUnder(root: string): Promise<ProjectScript[]> {
  const out = await scriptsIn(join(root, "package.json"), root, null);
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    /* `node_modules` and dot-dirs are the whole reason this list is one level
       deep and filtered rather than just walked: one directory under the root
       is where a person's packages live, and everything else there is
       tooling. */
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
    out.push(...(await scriptsIn(join(root, entry.name, "package.json"), join(root, entry.name), entry.name)));
  }
  return out;
}

export async function listProjectScripts(projectId: string): Promise<ProjectScript[]> {
  return listScriptsUnder(await projectRoot(projectId));
}
