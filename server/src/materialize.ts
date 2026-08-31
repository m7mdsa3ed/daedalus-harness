import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  lstatSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { commands as commandLibrary, skills as skillLibrary, type CommandDef } from "./library.js";
import type { LinkSet } from "./db/links.js";

/**
 * Project skills and slash commands into a cwd so the agent picks them up
 * natively: symlinks in <cwd>/.claude/skills/, markdown files in
 * <cwd>/.claude/commands/. The agent then advertises the commands over ACP
 * `available_commands_update` like any of its own — the client needs no
 * harness-specific list.
 *
 * Takes the *effective* set, not a project: the cwd is shared by every thread
 * of the project, and each thread brings its profile's links plus its own
 * picks — the project itself links nothing. The caller
 * (`SessionManager.materializeFor`) hands in the union across every thread
 * that is live there, because this sweeps what it does not write —
 * materializing one thread's set alone would pull the symlinks out from
 * under the thread next to it.
 */
export function materializeWorkspace(cwd: string, links: Pick<LinkSet, "skillIds" | "commandIds">): void {
  materializeSkills(cwd, links.skillIds);
  materializeCommands(cwd, links.commandIds);
}

/* ── The model allowlist ──
 *
 * Claude Code's ACP adapter builds its model picker from `availableModels` in
 * the settings the SDK resolves for the cwd, and *only* from there — the
 * `CLAUDE_MODEL_CONFIG` env var reaches the SDK query but never the picker. A
 * value the picker does not offer is refused by `session/set_config_option`,
 * so writing this file is what makes a gateway's model ids switchable on a
 * running agent instead of only nameable at spawn (registry.ts, `liveConfig`).
 *
 * `settings.local.json` and not `settings.json`: the local tier is the
 * gitignored one, and this is machine state — a list of ids this harness can
 * serve, not a decision about the repository. It is merged rather than
 * written, because the file is the user's: their own keys are untouched, their
 * own `availableModels` entries survive, and a manifest beside it records
 * exactly which ids we added last time so the sweep only ever takes back its
 * own — the same contract as the skills manifest above.
 */
const MODELS_MANIFEST = ".daedalus-models.json";

export function materializeModelAllowlist(cwd: string, ids: string[]): void {
  const dir = join(cwd, ".claude");
  const settingsPath = join(dir, "settings.local.json");
  const manifestPath = join(dir, MODELS_MANIFEST);
  const ours = new Set(readManifest(manifestPath));
  let settings: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      settings = parsed as Record<string, unknown>;
    }
  } catch {
    /* absent, or not JSON we can safely rewrite — either way we start from
       nothing rather than destroying something we cannot read */
    if (existsSync(settingsPath)) return;
  }
  const existing = Array.isArray(settings.availableModels)
    ? settings.availableModels.filter((v): v is string => typeof v === "string")
    : [];
  // Theirs first, ours after, each once: an entry we added last time and no
  // longer serve drops out, one they typed themselves stays wherever it is.
  const theirs = existing.filter((id) => !ours.has(id));
  const merged = [...new Set([...theirs, ...ids])];
  /* An empty union means no profile serving this agent has a catalog, and the
     allowlist is not ours to impose: Claude Code reads `[]` as "nothing but
     Default", which would take the agent's own models away. Drop the key back
     to whatever the user had (usually nothing) instead. */
  if (merged.length === 0) delete settings.availableModels;
  else settings.availableModels = merged;
  const wrote = ids.filter((id) => !theirs.includes(id));
  mkdirSync(dir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  if (wrote.length > 0) writeFileSync(manifestPath, JSON.stringify(wrote.sort()) + "\n");
  else rmSync(manifestPath, { force: true });
}

/* The skills directory is shared with symlinks the user made by hand, so —
   like the commands sweep and its marker below — only links this harness wrote
   are ours to delete. A manifest in the directory records their names; links
   whose targets resolve into the library's known skill paths are also
   recognized, which covers directories written before the manifest existed. */
const SKILLS_MANIFEST = ".daedalus-managed.json";

function readManifest(path: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function materializeSkills(cwd: string, skillIds: string[]): void {
  const all = skillLibrary.list();
  const paths = all.filter((s) => skillIds.includes(s.id)).map((s) => s.path);
  const skillsDir = join(cwd, ".claude", "skills");
  mkdirSync(skillsDir, { recursive: true });
  const manifestPath = join(skillsDir, SKILLS_MANIFEST);
  const managed = new Set(readManifest(manifestPath));
  const known = new Set(all.map((s) => resolve(s.path)));
  // Remove stale daedalus-managed symlinks — and only those: a symlink the
  // user made by hand is not in the manifest and points outside the library.
  for (const entry of readdirSync(skillsDir)) {
    if (entry === SKILLS_MANIFEST) continue;
    const path = join(skillsDir, entry);
    let target = "";
    try {
      if (!lstatSync(path).isSymbolicLink()) continue;
      const raw = readlinkSync(path);
      target = isAbsolute(raw) ? resolve(raw) : resolve(dirname(path), raw);
    } catch {
      continue; // unreadable entry — not ours to touch
    }
    if (managed.has(entry) || known.has(target)) rmSync(path);
  }
  const written: string[] = [];
  for (const skillPath of paths) {
    const target = resolve(skillPath);
    if (!existsSync(target)) continue;
    const link = join(skillsDir, basename(target));
    // Anything still holding this name survived the sweep, so it is the
    // user's — their entry wins, and it must not be claimed in the manifest.
    if (existsSync(link)) continue;
    try {
      symlinkSync(target, link);
      written.push(basename(target));
    } catch {
      // e.g. a hand-made dangling symlink with this name — not ours, leave it
    }
  }
  if (written.length > 0) writeFileSync(manifestPath, JSON.stringify(written.sort()) + "\n");
  else rmSync(manifestPath, { force: true });
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

function materializeCommands(cwd: string, commandIds: string[]): void {
  const linked = commandLibrary.list().filter((c) => commandIds.includes(c.id));
  const commandsDir = join(cwd, ".claude", "commands");
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
