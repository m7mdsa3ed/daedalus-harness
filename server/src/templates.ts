/* ── Templates ──
 *
 * The starters under `<repo>/templates/<id>/`, and the one write the harness
 * ever makes outside a project root: scaffolding a new project from one.
 *
 * A template is a directory with a `template.json` manifest; the manifest
 * describes the card (name, description, tags) and the three commands the
 * harness relies on (`install`, `dev`, `check`). Everything else in the
 * directory is copied verbatim into the new project, minus the manifest and
 * minus `node_modules`, `dist` and `.git` — a checked-in template must never
 * ship a build or a dependency tree, but a developer's working copy of one
 * frequently holds them.
 *
 * **The crux: one `mkdir`, and it is outside every project root.** Everything
 * `workspace-fs.ts` does is anchored to `projectRoot(projectId)` and checked
 * for containment. Creating a new project's directory has no such anchor —
 * there is no project yet, and the parent is wherever the user keeps their
 * code. So the substitute for containment is a short, stated rule, enforced in
 * exactly one function (`prepareTargetDir`):
 *
 *   - the parent must be an absolute path that already exists and is a
 *     directory;
 *   - the target must not exist, or must exist and be empty (so a retry after
 *     a failed first attempt is not an error, and an occupied directory is
 *     never clobbered);
 *   - no symlink traversal — the real path of the parent and of the target
 *     are what is checked, as `resolveInProject` does;
 *   - failures are `WorkspaceError`s, so the existing status mapping carries
 *     them unchanged;
 *   - if recording the project row then fails, what was written is removed —
 *     and the directory itself only if this call made it.
 *
 * The one exception to "absolute and existing" is the default parent,
 * `config.appsDir()`: it is the harness's own directory, created on demand.
 */
import { execFile } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { z } from "zod";

import { appsDir } from "./config.js";
import { createProject as createProjectRow, type Project, type ProjectInput } from "./projects.js";
import { WorkspaceError } from "./workspace-fs.js";

/* `src/` and `dist/` both sit one level under `server/`, and `templates/` is
   the repo root's, so the same two hops work built and under tsx. */
export const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "templates");

const MANIFEST = "template.json";
/** Never copied, at any depth. */
const NEVER_COPIED = new Set(["node_modules", "dist", ".git"]);

export const TemplateManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes"),
  name: z.string().min(1),
  description: z.string().default(""),
  tags: z.array(z.string()).default([]),
  /** Run once after scaffolding, as an `install` terminal; null for none. */
  install: z.string().nullable().default(null),
  /** The managed dev-server command. Required — a template without one has no
      preview, and the preview is the point. */
  dev: z.string().min(1),
  /** What the agent runs before it says it is done; null for none. */
  check: z.string().nullable().default(null),
  /** The production build, run on demand from the preview panel; null for
      none. Whether it passes is the one question a production deploy asks
      that the dev server never does. */
  build: z.string().nullable().default(null),
  /** Words and short phrases in a prompt that point at this starter ("api",
      "landing page", "login"). Read by the client's stack sensing
      (`lib/stack-sense.ts`), which offers the best-scoring starter before the
      user has picked one; a starter with none is only ever picked by hand or
      as the fallback. Matched case-insensitively on word boundaries. */
  signals: z.array(z.string()).default([]),
  sortOrder: z.number().int().default(0),
});

export type Template = z.infer<typeof TemplateManifestSchema>;

/**
 * The starter that ships nothing. A project built "from scratch" records this
 * as its `templateId`, so everything that asks "was this scaffolded by Build
 * mode?" (the shell's auto-opened preview, the panel's task commands) reads
 * one column — while `getTemplate` answers `undefined` for it, which is what
 * sends the dev-server manager to the project's own manifest (`daedalus.json`
 * or `package.json`) for its commands. A `templates/scratch/` directory is
 * refused, so the sentinel cannot be shadowed.
 */
export const SCRATCH_TEMPLATE_ID = "scratch";

/**
 * The project's own manifest, for a project that has no template to read
 * commands from: `daedalus.json` at the root, the command half of
 * `template.json` (`install`, `dev`, `check`, `build`). Written by the agent
 * of a from-scratch build — its AGENTS.md says so — or by anyone who wants a
 * preview on a project the harness did not scaffold. Absent or malformed reads
 * as empty; a wrong file must never take the project down.
 */
export const PROJECT_MANIFEST = "daedalus.json";
export const ProjectManifestSchema = z.object({
  install: z.string().nullable().default(null),
  dev: z.string().nullable().default(null),
  check: z.string().nullable().default(null),
  build: z.string().nullable().default(null),
});
export type ProjectManifest = z.infer<typeof ProjectManifestSchema>;

const EMPTY_MANIFEST: ProjectManifest = { install: null, dev: null, check: null, build: null };

export function readProjectManifest(cwd: string): ProjectManifest {
  try {
    const parsed = ProjectManifestSchema.safeParse(JSON.parse(readFileSync(join(cwd, PROJECT_MANIFEST), "utf8")));
    return parsed.success ? parsed.data : EMPTY_MANIFEST;
  } catch {
    return EMPTY_MANIFEST;
  }
}

/** Which package manager a Node project uses, read off its lockfile. */
export function packageManager(cwd: string): "pnpm" | "yarn" | "bun" | "npm" {
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"))) return "bun";
  return "npm";
}

function packageScripts(cwd: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

/**
 * Sense how a directory the harness did not scaffold from a starter is run:
 * `daedalus.json`'s `dev` first (the stated answer, any stack), then a
 * `package.json` `dev` or `start` script through the lockfile's package
 * manager. Null when nothing declares one — a directory the agent has not
 * built into yet, or a stack that has to say so in the manifest.
 */
export function detectDevCommand(cwd: string): string | null {
  const stated = readProjectManifest(cwd).dev?.trim();
  if (stated) return stated;
  const scripts = packageScripts(cwd);
  if (scripts.dev) return `${packageManager(cwd)} run dev`;
  if (scripts.start) return `${packageManager(cwd)} start`;
  return null;
}

/** Same reading for the other three commands. `install` is offered only when
    the tree has a `package.json` — the manifest is the way to say it for any
    other stack. */
export function detectCommand(cwd: string, kind: "install" | "check" | "build"): string | null {
  const stated = readProjectManifest(cwd)[kind]?.trim();
  if (stated) return stated;
  if (kind === "install") return existsSync(join(cwd, "package.json")) ? `${packageManager(cwd)} install` : null;
  const scripts = packageScripts(cwd);
  return scripts[kind] ? `${packageManager(cwd)} run ${kind}` : null;
}

const fail = (status: 400 | 403 | 404 | 409, message: string) => new WorkspaceError(message, status);

/**
 * Every valid template, sorted. A directory whose manifest is missing, is not
 * JSON, fails the schema or names an id other than its own directory is
 * skipped with a warning rather than failing the whole list — a half-written
 * template in a working copy must not take the gallery down with it.
 */
export function listTemplates(dir: string = TEMPLATES_DIR): Template[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Template[] = [];
  for (const entry of entries) {
    const path = join(dir, entry, MANIFEST);
    if (!existsSync(path)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      console.warn(`[templates] ${path} is not valid JSON:`, error instanceof Error ? error.message : error);
      continue;
    }
    const parsed = TemplateManifestSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn(`[templates] ${path} is not a valid manifest:`, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      continue;
    }
    if (parsed.data.id !== entry) {
      console.warn(`[templates] ${path} names id "${parsed.data.id}" but lives in "${entry}" — skipped`);
      continue;
    }
    if (parsed.data.id === SCRATCH_TEMPLATE_ID) {
      console.warn(`[templates] "${SCRATCH_TEMPLATE_ID}" is the from-scratch sentinel and cannot be a starter — skipped`);
      continue;
    }
    out.push(parsed.data);
  }
  return out.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

export function getTemplate(id: string, dir: string = TEMPLATES_DIR): Template | undefined {
  return listTemplates(dir).find((t) => t.id === id);
}

/** A directory name from a project name: lowercase, dashes, nothing a shell
    or a URL would trip on, never empty and never a dot-name. */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug || "app";
}

const within = (root: string, path: string) => path === root || path.startsWith(root + sep);

/**
 * The directory a new project will be scaffolded into, checked against the
 * rules at the top of the file. Creates it when it does not exist. Returns
 * whether this call made it, so a failure afterwards knows what to undo.
 */
export function prepareTargetDir(parent: string, name: string): { dir: string; created: boolean } {
  if (!isAbsolute(parent)) throw fail(400, "the parent directory must be an absolute path");
  let parentReal: string;
  try {
    parentReal = realpathSync(parent);
  } catch {
    throw fail(404, `the parent directory does not exist: ${parent}`);
  }
  if (!statSync(parentReal).isDirectory()) throw fail(400, `not a directory: ${parent}`);

  const slug = slugify(name);
  const dir = resolvePath(parentReal, slug);
  if (!within(parentReal, dir) || dir === parentReal) throw fail(400, "the project name is not usable as a directory");

  let existing: ReturnType<typeof lstatSync> | null = null;
  try {
    existing = lstatSync(dir);
  } catch {
    existing = null;
  }
  if (!existing) {
    mkdirSync(dir);
    return { dir, created: true };
  }
  /* A link at the target is refused outright: whether it points at an empty
     directory or not, filling it would write somewhere the user did not name. */
  if (existing.isSymbolicLink()) throw fail(409, `already exists and is a symlink: ${dir}`);
  if (!existing.isDirectory()) throw fail(409, `already exists and is not a directory: ${dir}`);
  if (readdirSync(dir).length > 0) throw fail(409, `already exists and is not empty: ${dir}`);
  if (!within(parentReal, realpathSync(dir))) throw fail(403, "the target escapes the parent directory");
  return { dir, created: false };
}

/** Copy a template's tree into `dest`, minus the manifest at the root and
    minus `node_modules`/`dist`/`.git` anywhere. Symlinks are copied as links,
    never followed — a template is checked in, it has no business pointing
    outside itself. */
export function copyTemplate(templateDir: string, dest: string): void {
  for (const entry of readdirSync(templateDir)) {
    if (entry === MANIFEST || NEVER_COPIED.has(entry)) continue;
    cpSync(join(templateDir, entry), join(dest, entry), {
      recursive: true,
      verbatimSymlinks: true,
      errorOnExist: false,
      filter: (source) => !NEVER_COPIED.has(source.split(sep).pop() ?? ""),
    });
  }
}

const exec = promisify(execFile);

/** `git init` + first commit, best effort: an install without git, or one
    without an identity configured, still gets a project — just not a repo. */
export async function gitInit(dir: string, message: string): Promise<boolean> {
  const git = (...args: string[]) => exec("git", args, { cwd: dir, timeout: 30_000 });
  try {
    await git("init", "-q");
    await git("add", "-A");
    try {
      await git("commit", "-q", "-m", message);
    } catch {
      // No user.name/user.email on this machine — commit under a harness
      // identity rather than leave the tree staged and uncommitted.
      await git("-c", "user.name=Daedalus", "-c", "user.email=daedalus@localhost", "commit", "-q", "-m", message);
    }
    return true;
  } catch (error) {
    console.warn(`[templates] git init in ${dir} failed:`, error instanceof Error ? error.message : error);
    return false;
  }
}

export const ScaffoldInputSchema = z.object({
  /** A starter's id, or null / `"scratch"` for an empty project the agent
      builds the stack of itself (`scaffoldFromScratch`). */
  templateId: z.string().min(1).nullable().optional(),
  name: z.string().trim().min(1).max(120),
  parent: z.string().trim().min(1).optional(),
  description: z.string().nullable().optional(),
  /** For a from-scratch build: the stack the prompt named ("Next.js",
      "Flask"), written into the project's AGENTS.md so the agent starts on it
      rather than on its own default. Free text, ignored with a template. */
  stack: z.string().trim().max(80).optional(),
});
export type ScaffoldInput = z.infer<typeof ScaffoldInputSchema>;

export const isScratch = (templateId: string | null | undefined): boolean =>
  !templateId || templateId === SCRATCH_TEMPLATE_ID;

export interface ScaffoldOptions {
  /** Where templates are read from — a test's fixture dir. */
  templatesDir?: string;
  /** The row writer; the real one by default, swappable so a test can make it
      fail and watch the directory get cleaned up. */
  createProject?: (input: ProjectInput) => Project;
}

/**
 * Copy a template into a new directory, make it a repo, record the project.
 *
 * Starting the dev server is the caller's — the route fires it and forgets,
 * so the response carries the project rather than waiting on an install.
 */
export async function scaffoldProject(input: ScaffoldInput, options: ScaffoldOptions = {}): Promise<Project> {
  if (isScratch(input.templateId)) return scaffoldFromScratch(input, options);
  const templatesDir = options.templatesDir ?? TEMPLATES_DIR;
  const template = getTemplate(input.templateId!, templatesDir);
  if (!template) throw fail(404, `no such template: ${input.templateId}`);

  return withNewDir(input, async (dir) => {
    copyTemplate(join(templatesDir, template.id), dir);
    await gitInit(dir, `Scaffold from ${template.name}`);
    return (options.createProject ?? createProjectRow)({
      name: input.name,
      cwd: dir,
      description: input.description ?? null,
      devCommand: template.dev,
      templateId: template.id,
    });
  });
}

/**
 * An empty project for a stack no starter covers: the directory, the rules
 * file that tells the agent how a preview is earned, `git init`, and a row
 * with **no dev command** — the agent is about to choose the stack, and the
 * command is sensed off the directory when its first turn ends
 * (`detectDevCommand`, called from the session manager), which is what makes
 * the preview appear. Same one-mkdir rules, same undo.
 */
export async function scaffoldFromScratch(
  input: Omit<ScaffoldInput, "templateId">,
  options: Pick<ScaffoldOptions, "createProject"> = {},
): Promise<Project> {
  return withNewDir(input, async (dir) => {
    writeFileSync(join(dir, "AGENTS.md"), scratchAgentsMd(input.name, input.stack?.trim() || null));
    writeFileSync(join(dir, "CLAUDE.md"), "@AGENTS.md\n");
    writeFileSync(join(dir, ".gitignore"), SCRATCH_GITIGNORE);
    await gitInit(dir, input.stack?.trim() ? `Start from scratch (${input.stack.trim()})` : "Start from scratch");
    return (options.createProject ?? createProjectRow)({
      name: input.name,
      cwd: dir,
      description: input.description ?? null,
      devCommand: null,
      templateId: SCRATCH_TEMPLATE_ID,
    });
  });
}

/** The one mkdir and its undo, shared by both scaffolds. */
async function withNewDir(
  input: Pick<ScaffoldInput, "name" | "parent">,
  fill: (dir: string) => Promise<Project>,
): Promise<Project> {
  let parent = input.parent;
  if (!parent) {
    parent = appsDir();
    mkdirSync(parent, { recursive: true });
  }
  const { dir, created } = prepareTargetDir(parent, input.name);

  const undo = () => {
    try {
      if (created) rmSync(dir, { recursive: true, force: true });
      else for (const entry of readdirSync(dir)) rmSync(join(dir, entry), { recursive: true, force: true });
    } catch {
      /* the failure being reported is the one that matters */
    }
  };

  try {
    return await fill(dir);
  } catch (error) {
    undo();
    throw error;
  }
}

const SCRATCH_GITIGNORE = [
  "node_modules",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".output",
  ".venv",
  "__pycache__",
  "target",
  ".env",
  ".env.*",
  ".claude/settings.local.json",
  "*.log",
  ".DS_Store",
  "",
].join("\n");

/**
 * The rules file of a from-scratch project. The template AGENTS.md files say
 * "the dev server is not yours"; this one has to say the same *and* how the
 * harness learns what the dev server is, because there is no manifest yet
 * and no dev command on the row. The contract is the one `detectDevCommand`
 * reads, stated from the agent's side.
 */
export function scratchAgentsMd(name: string, stack: string | null): string {
  const opening = stack
    ? `This is a new project for **${name}**, to be built with **${stack}** — that is the stack the user asked for; use it unless they say otherwise.`
    : `This is a new, empty project for **${name}**. Choose the stack that fits what the user asked for and say which one you chose.`;
  return `# Working in this project

${opening} It runs inside Daedalus Harness "Build" mode, which shows the running
app next to the chat once it knows how to run it.

## Your first turn sets the project up

There is nothing here yet but this file. Scaffold the stack yourself with its own
tooling (\`pnpm create vite\`, \`npx create-next-app\`, \`uv init\`, \`cargo init\`, …)
**into this directory**, not a subdirectory, and install its dependencies. Prefer
pnpm for Node projects. Then make the app runnable under the harness:

- The harness starts the dev server itself and passes \`PORT\` (listen on it, on
  \`127.0.0.1\`) and \`BASE_PATH\` — a URL prefix with leading and trailing slash,
  like \`/preview/<key>/<id>/\`, under which the app is served. Every asset URL,
  API route and router basename must live under it; with it unset the app must
  work at \`/\`. (Vite: \`base: process.env.BASE_PATH ?? "/"\`, \`server.port\` from
  \`PORT\`, \`strictPort: true\`. Next.js: \`basePath\` without the trailing slash.
  Django/Flask/FastAPI: mount under the prefix and bind \`127.0.0.1:$PORT\`.)
- **Say how it runs.** The harness reads the dev command from \`package.json\`'s
  \`dev\` (or \`start\`) script through the lockfile's package manager. For any
  other stack, or to be explicit, write \`daedalus.json\` at the root:

      { "install": "uv sync", "dev": "uv run flask --app app run --port $PORT", "check": "uv run pyright", "build": null }

  \`dev\` is required for a preview; \`check\` is what you run before finishing;
  \`build\` is the production build, run on demand from the preview.
- Do not start the dev server yourself. Once the command exists, the harness
  starts it at the end of your turn, keeps it running with hot reload, and shows
  the app beside the chat. **Never** start, stop or restart it after that, and
  never change the port, host or base path.

## Every turn after

- Build the complete feature asked for, with sensible empty, loading and error
  states. Keep components small, one per file. Prefer editing what is there.
- Run the \`check\` command and fix what it reports before you say you are done.
- Commit after each completed change with a one-line message in the user's
  words (\`git add -A && git commit -m "..."\`): every commit is a restore point
  the user can roll back to from the preview's History.
- Do not add dependencies you do not need.
`;
}
