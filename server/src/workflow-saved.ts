/*
 * Saved workflows: script files in the directories Claude Code reads them from
 * — `<project>/.claude/workflows/` and `~/.claude/workflows/` (under
 * `CLAUDE_CONFIG_DIR` when that is set) — so a workflow saved by either tool
 * runs in both. A workflow is named by its `meta.name`, not its file name, and
 * a project one shadows a personal one of the same name, as Claude Code's does.
 *
 * ponytail: only the project root's `.claude/workflows/`, not every one between
 * the cwd and the repository root; walk upward when a monorepo needs it.
 */
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { extractMeta, type ScriptMeta, type WorkflowRef } from "./workflow-script.js";

export type SavedScope = "project" | "personal";

export interface SavedWorkflow extends Pick<ScriptMeta, "name" | "description" | "whenToUse"> {
  scope: SavedScope;
  path: string;
}

function dirs(projectCwd: string): { scope: SavedScope; dir: string }[] {
  const home = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return [
    { scope: "project", dir: join(projectCwd, ".claude", "workflows") },
    { scope: "personal", dir: join(home, "workflows") },
  ];
}

/** Every saved workflow, project ones first; a name already seen is shadowed. */
export async function listSaved(projectCwd: string): Promise<SavedWorkflow[]> {
  const out: SavedWorkflow[] = [];
  const seen = new Set<string>();
  for (const { scope, dir } of dirs(projectCwd)) {
    const files = await readdir(dir).catch(() => [] as string[]);
    for (const file of files.filter((f) => f.endsWith(".js")).sort()) {
      const path = join(dir, file);
      try {
        const meta = extractMeta(await readFile(path, "utf8"));
        if (seen.has(meta.name)) continue;
        seen.add(meta.name);
        out.push({ name: meta.name, description: meta.description, ...(meta.whenToUse ? { whenToUse: meta.whenToUse } : {}), scope, path });
      } catch {
        // A file whose `meta` does not parse is not a workflow — Claude Code
        // drops it from `/` autocomplete the same way.
      }
    }
  }
  return out;
}

/** The source behind a `workflow(ref)` or a run by name. A relative
    `scriptPath` is read against the thread's own cwd. */
export async function loadSaved(projectCwd: string, cwd: string, ref: WorkflowRef): Promise<string> {
  if (typeof ref !== "string") {
    const path = isAbsolute(ref.scriptPath) ? ref.scriptPath : resolve(cwd, ref.scriptPath);
    return await readFile(path, "utf8").catch(() => {
      throw new Error(`cannot read the workflow script at ${path}`);
    });
  }
  const hit = (await listSaved(projectCwd)).find((w) => w.name === ref);
  if (!hit) throw new Error(`no saved workflow is named "${ref}"`);
  return await readFile(hit.path, "utf8");
}

/** Write a script as `<meta.name>.js`. Refuses to write through a symlink —
    the project's `.claude`, its `workflows`, or the file itself; for the
    personal location only the file, so a dotfiles-managed `~/.claude` works. */
export async function saveWorkflow(projectCwd: string, source: string, scope: SavedScope): Promise<SavedWorkflow> {
  const meta = extractMeta(source);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(meta.name)) {
    throw new Error("meta.name must be a file-safe name (letters, digits, _ . -) to be saved");
  }
  const { dir } = dirs(projectCwd).find((d) => d.scope === scope)!;
  const path = join(dir, `${meta.name}.js`);
  const guarded = scope === "project" ? [join(projectCwd, ".claude"), dir, path] : [path];
  for (const p of guarded) {
    const stat = await lstat(p).catch(() => null);
    if (stat?.isSymbolicLink()) throw new Error(`refusing to save through a symlink: ${p}`);
  }
  await mkdir(dir, { recursive: true });
  await writeFile(path, source.endsWith("\n") ? source : `${source}\n`);
  return { name: meta.name, description: meta.description, scope, path };
}
