import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, projectTemplates as templatesTable } from "./db/index.js";
import { TEMPLATE_LINKS, emptyLinks, linksOf, readLinks, writeLinks, type LinkSet } from "./db/links.js";
import { createProject, type Project } from "./projects.js";
import { WorkspaceError } from "./workspace-fs.js";

/**
 * A template is a starting point, and the harness executes none of it.
 *
 * `createProject` records a directory it never made, which is why every project
 * in this install was assembled by hand somewhere else first — and why the
 * first turn of the first thread is spent re-explaining a stack the last five
 * projects also had. A template carries the missing half as *data*: a repo, a
 * kit of library links, and the instruction the agent carries out in its first
 * turn. `createFromTemplate` makes one empty directory and records the row; the
 * clone, the install and everything after it are an ordinary turn in the
 * agent's own cwd, under the permission rules that already govern one. The
 * harness never becomes a second writer to a user's repo.
 *
 * `runtime` is a label the gallery groups by and nothing here switches on, so
 * Python or Go later is an entry in `BUILTIN_TEMPLATES` and no code branch.
 */

export const TemplateInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  logoUrl: z.string().default(""),
  /** Where the starter is cloned from. Not validated as a URL: `git clone`
      takes ssh remotes and local paths too, and the agent is what runs it. */
  repoUrl: z.string().min(1),
  /** Branch or tag; null = the repo's own default. */
  repoRef: z.string().nullable().default(null),
  /** A directory inside the repo, for a starter that lives in a monorepo. */
  repoSubdir: z.string().nullable().default(null),
  runtime: z.string().default(""),
  tags: z.array(z.string()).default([]),
  setup: z.string().default(""),
  prompt: z.string().default(""),
  /** The kit — the "pre-configured" half, and what makes a template more than
      a repo URL. Written to the join tables, read back the same way. */
  mcpServerIds: z.array(z.string()).default([]),
  skillIds: z.array(z.string()).default([]),
  commandIds: z.array(z.string()).default([]),
});

export type TemplateInput = z.infer<typeof TemplateInputSchema>;

export type TemplateDef = Omit<TemplateInput, keyof LinkSet> &
  LinkSet & {
    id: string;
    /** A row this release seeded (see `seedTemplates`); 0 = the user's own. */
    seededVersion: number;
    createdAt: number;
  };

type TemplateRow = typeof templatesTable.$inferSelect;

/** A row plus its links, with the nullable columns read back the way the API
    reports them — `""` for "none", like a project's `logoUrl`. */
function toDef(row: TemplateRow, links: LinkSet = linksOf(TEMPLATE_LINKS, row.id)): TemplateDef {
  return {
    ...links,
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    logoUrl: row.logoUrl ?? "",
    repoUrl: row.repoUrl,
    repoRef: row.repoRef ?? null,
    repoSubdir: row.repoSubdir ?? null,
    runtime: row.runtime ?? "",
    tags: row.tags ?? [],
    setup: row.setup ?? "",
    prompt: row.prompt ?? "",
    seededVersion: row.seededVersion,
    createdAt: row.createdAt,
  };
}

/** The columns, without the link arrays that live in their own tables. */
function columnsOf(template: TemplateDef): typeof templatesTable.$inferInsert {
  const { mcpServerIds: _m, skillIds: _s, commandIds: _c, ...columns } = template;
  return columns;
}

/* ── CRUD ──
 * The shape `library.ts` gives commands and skills, plus the link write the
 * profile form already does — so the routes are the routes those already have.
 * `seededVersion` is not in the input: a built-in is the seed's to stamp, and
 * editing one is allowed but does not make it yours to renumber. */
export const templates = {
  list(): TemplateDef[] {
    const rows = db.select().from(templatesTable).orderBy(asc(templatesTable.name)).all();
    const links = readLinks(TEMPLATE_LINKS, rows.map((r) => r.id));
    return rows.map((row) => toDef(row, links.get(row.id) ?? emptyLinks()));
  },
  get(id: string): TemplateDef | undefined {
    const row = db.select().from(templatesTable).where(eq(templatesTable.id, id)).get();
    return row ? toDef(row) : undefined;
  },
  create(input: TemplateInput): TemplateDef {
    const template: TemplateDef = { id: randomUUID(), seededVersion: 0, createdAt: Date.now(), ...input };
    db.transaction((tx) => {
      tx.insert(templatesTable).values(columnsOf(template)).run();
      writeLinks(tx, TEMPLATE_LINKS, template.id, template);
    });
    return templates.get(template.id)!;
  },
  update(id: string, input: TemplateInput): TemplateDef | undefined {
    const existing = templates.get(id);
    if (!existing) return undefined;
    // `seededVersion` and `createdAt` are the row's own history, not the form's.
    const updated: TemplateDef = { ...existing, ...input };
    db.transaction((tx) => {
      tx.update(templatesTable).set(columnsOf(updated)).where(eq(templatesTable.id, id)).run();
      writeLinks(tx, TEMPLATE_LINKS, id, updated);
    });
    return templates.get(id);
  },
  /** The links go with it — that is the cascades' job, not this function's. */
  remove: (id: string): boolean =>
    db.delete(templatesTable).where(eq(templatesTable.id, id)).run().changes > 0,
};

/* ── Rendering ──
 *
 * `setup` and `prompt` accept the same five placeholders, and this is the only
 * thing that fills them — server-side, so the client cannot drift from it. An
 * unknown placeholder is left alone rather than blanked: the body is prose
 * headed for an agent, and `{}` in it is as likely to be code as a typo.
 */
export interface TemplateVars {
  name: string;
  cwd: string;
}

export function renderPrompt(template: TemplateDef, vars: TemplateVars): { setup: string; prompt: string } {
  const values: Record<string, string> = {
    name: vars.name,
    cwd: vars.cwd,
    repo: template.repoUrl,
    ref: template.repoRef ?? "",
    subdir: template.repoSubdir ?? "",
  };
  const render = (text: string) =>
    text.replace(/\{(name|cwd|repo|ref|subdir)\}/g, (_, key: string) => values[key]);
  return { setup: render(template.setup), prompt: render(template.prompt) };
}

/** The body the composer opens with: the instruction, then the template's own
    setup notes under it. Two fields rather than one because the setup is the
    part a user edits per template and the prompt is the part they edit per
    project — but the agent only ever sees one message, so they are joined
    here, once, rather than by whatever calls this. */
function composeBody(rendered: { setup: string; prompt: string }): string {
  const parts = [rendered.prompt.trim(), rendered.setup.trim()].filter(Boolean);
  return parts.join("\n\n");
}

/* ── Built-ins ──
 *
 * `seedAgents`' rules verbatim (registry.ts), for the reason `seedPersonas`
 * restates: `since` is how far this install has been carried, `introduced` is
 * the release that first offered the row, and only the pair can tell "never
 * seen" apart from "deleted on purpose". Built-ins are ordinary rows —
 * editable, deletable, never overwritten on a field a user may have changed.
 *
 * Seeded small and honest: two real public starters, each pointing at a repo
 * that exists and carries the stack the card names. A template that promises
 * something its repo does not hold is worse than no template — the agent finds
 * out mid-turn — so the setup states what is actually in there, including the
 * versions, rather than describing the stack somebody wishes it were.
 */
type SeedTemplate = Omit<TemplateDef, "seededVersion" | "createdAt"> & {
  since: number;
  introduced: number;
  /** What this seed release ADDS to a row that already exists — the same
      contract `SeedAgent.backfill` has: only fields a release introduced,
      never a wholesale replacement, because everything here is editable. */
  backfill?: (existing: TemplateDef) => Partial<TemplateDef>;
};

export const BUILTIN_TEMPLATES: SeedTemplate[] = [
  {
    since: 1,
    introduced: 1,
    id: "builtin:ts-service",
    name: "TypeScript service",
    description:
      "A plain Node + TypeScript HTTP service on Hono — the official starter's Node template, nothing generated.",
    logoUrl: "",
    repoUrl: "https://github.com/honojs/starter",
    repoRef: null,
    // The starter repo is a collection; the Node service is one directory in
    // it, which is exactly what `repoSubdir` is for.
    repoSubdir: "templates/nodejs",
    runtime: "node",
    tags: ["typescript", "server", "api", "hono"],
    mcpServerIds: [],
    skillIds: [],
    commandIds: [],
    prompt: [
      "Start the “{name}” project in {cwd} from the {repo} starter.",
      "",
      "Clone it, take {subdir} out of it as the project root, drop the starter's own",
      "git history, and get it running. Then tell me the dev command and the URL it",
      "serves on.",
    ].join("\n"),
    setup: [
      "Setup notes:",
      "",
      "- Clone into a scratch directory and copy `{subdir}` into `{cwd}` — the repo is a",
      "  collection of templates and only that one directory is this project.",
      "- Remove the cloned `.git` and `git init` fresh, so the history starts here.",
      "- Set the package name to something derived from “{name}”.",
      "- `npm install`, then `npm run dev` (tsx + @hono/node-server) to check it serves.",
      "- Add a `.gitignore` covering `node_modules` and `dist` if the template lacks one.",
    ].join("\n"),
  },
  {
    since: 1,
    introduced: 1,
    id: "builtin:vite-react-tailwind",
    name: "Vite + React + Tailwind",
    description:
      "A Vite 5 + React 18 + TypeScript app with Tailwind, Vitest and Testing Library already wired up.",
    logoUrl: "",
    repoUrl: "https://github.com/joaopaulomoraes/reactjs-vite-tailwindcss-boilerplate",
    repoRef: null,
    repoSubdir: null,
    runtime: "node",
    tags: ["typescript", "react", "vite", "tailwind", "web"],
    mcpServerIds: [],
    skillIds: [],
    commandIds: [],
    prompt: [
      "Start the “{name}” project in {cwd} from the {repo} boilerplate.",
      "",
      "Clone it in, make it this project rather than the boilerplate, and get the dev",
      "server up. Then tell me the URL.",
    ].join("\n"),
    setup: [
      "Setup notes:",
      "",
      "- Clone {repo} into {cwd} (clone into a temp dir and move the contents if the",
      "  directory has to stay the one that already exists).",
      "- Remove the cloned `.git` and `git init` fresh.",
      "- Set the package name and the `<title>` in `index.html` from “{name}”, and",
      "  replace the boilerplate's README with one about this project.",
      "- `npm install`, then `npm run dev`.",
      "- The boilerplate ships Tailwind 3 with a `tailwind.config.mjs`; leave it as it",
      "  is unless I ask for Tailwind 4, which is a different (Vite-plugin) setup.",
    ].join("\n"),
  },
];

/**
 * Insert the built-in templates this install has never been offered.
 *
 * `seedAgents`' rules: only rows newer than the highest `since` present are
 * considered, an absent row whose `introduced` this install is already past
 * was deleted on purpose and does not come back, and an existing row is never
 * overwritten — every field on a template is one a user may have edited.
 */
export function seedTemplates(): void {
  const applied =
    db
      .select({ v: templatesTable.seededVersion })
      .from(templatesTable)
      .orderBy(desc(templatesTable.seededVersion))
      .get()?.v ?? 0;
  for (const { since, introduced, backfill, ...template } of BUILTIN_TEMPLATES) {
    if (since <= applied) continue;
    const existing = templates.get(template.id);
    if (!existing) {
      /* Offered in an earlier release and not here now: deleted. `since >
         applied` alone cannot tell that from a fresh install, because a
         backfill bumps `since` past every row present — `introduced` is the
         half that does not move. Nothing is stamped either; there is no row to
         carry a version, and the re-check next boot is a no-op. */
      if (introduced <= applied) continue;
      const row: TemplateDef = { ...template, seededVersion: since, createdAt: Date.now() };
      db.transaction((tx) => {
        tx.insert(templatesTable).values(columnsOf(row)).run();
        writeLinks(tx, TEMPLATE_LINKS, row.id, row);
      });
      continue;
    }
    // Still here: stamp it as carried this far and fill in only what the
    // release ADDED. The links are the user's too, so a backfill that does not
    // name them does not touch them.
    const added = backfill?.(existing);
    const updated: TemplateDef = { ...existing, ...added, seededVersion: since };
    db.transaction((tx) => {
      tx.update(templatesTable).set(columnsOf(updated)).where(eq(templatesTable.id, template.id)).run();
      if (added && (added.mcpServerIds || added.skillIds || added.commandIds))
        writeLinks(tx, TEMPLATE_LINKS, template.id, updated);
    });
  }
}

/* ── The one write outside a project root ──
 *
 * Everything in `workspace-fs.ts` is anchored to `projectRoot(projectId)` and
 * checked for containment, because every path it touches is user input naming
 * a file for an agent to open. Creating a new project's directory has no such
 * anchor: there is no project yet, and the parent is wherever the user keeps
 * their code. So this is deliberately the only write outside a project root,
 * it happens in exactly one function, and it creates an EMPTY directory and
 * nothing else — no clone, no install, no scaffold.
 *
 * The substitute for containment is a short, stated rule:
 *
 *   - the parent must be an absolute path that already exists and is a
 *     directory;
 *   - the target must not exist, or must exist and be empty — so a retry after
 *     a failed first turn is not an error, and an occupied directory is never
 *     clobbered;
 *   - no symlink traversal: resolve and re-check, as `resolveInProject` does;
 *   - failures are `WorkspaceError`, so the existing status mapping and the
 *     client's ApiError/describeError path carry them unchanged;
 *   - if recording the project row then fails, the directory is removed — and
 *     only if this call made it.
 */

const fail = (status: 400 | 403 | 404 | 409, message: string) => new WorkspaceError(message, status);

export const CreateFromTemplateSchema = z.object({
  templateId: z.string().min(1),
  /** The project's name — also what the folder name defaults to. */
  name: z.string().min(1),
  /** Absolute directory the new folder is made in. */
  parentDir: z.string().min(1),
  /** One path segment. Defaults to a slug of `name`. */
  folderName: z.string().optional(),
});

export type CreateFromTemplateInput = z.infer<typeof CreateFromTemplateSchema>;

export interface CreatedFromTemplate {
  project: Project;
  /** The composer body, rendered — see `renderPrompt`. */
  prompt: string;
  /** The template's kit, for `POST /api/sessions` to take verbatim. */
  links: LinkSet;
}

/** A name → a folder name. Lowercased, non-word runs collapsed to a dash: a
    directory the shell does not need quoting for, since the agent's first act
    is to `cd` into it. */
export function slugifyName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function createFromTemplate(input: CreateFromTemplateInput): CreatedFromTemplate {
  const template = templates.get(input.templateId);
  if (!template) throw fail(404, "unknown template");

  const parentRaw = input.parentDir.trim();
  if (!isAbsolute(parentRaw)) throw fail(400, "the parent directory must be an absolute path");
  let parent: string;
  try {
    // Canonical, so both sides of every comparison below are real paths — the
    // same reason `projectRoot` canonicalizes a project's own cwd.
    parent = realpathSync(parentRaw);
  } catch {
    throw fail(404, `no such directory: ${parentRaw}`);
  }
  if (!statSync(parent).isDirectory()) throw fail(400, `not a directory: ${parentRaw}`);

  const folder = (input.folderName ?? "").trim() || slugifyName(input.name);
  // One segment, and not a traversal. `join` would happily take `../..`.
  if (!folder || folder !== normalize(folder) || folder.includes("/") || folder.includes("\\") || folder === "." || folder === "..")
    throw fail(400, "the folder name must be a single path segment");
  const target = join(parent, folder);

  /* mkdir first and read EEXIST as "it is already there", rather than asking
     asking first and then creating: between the two answers is a window, and
     `existsSync` follows links, so a dangling symlink would answer "no" and
     the mkdir would fail anyway. */
  let created = false;
  try {
    mkdirSync(target);
    created = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST")
      throw fail(400, `could not create ${target}: ${(err as Error).message}`);
  }

  let cwd: string;
  try {
    cwd = realpathSync(target);
  } catch {
    // Exists to `mkdir` but does not resolve: a broken symlink sitting on the
    // name. Refused rather than followed.
    throw fail(409, `${target} already exists and does not resolve to a real directory`);
  }
  if (!created) {
    // A link on that name pointing somewhere else is the traversal this
    // re-check exists for: the answer has to still be the child of `parent`
    // that was asked for.
    if (dirname(cwd) !== parent) throw fail(403, `${target} is a link out of ${parentRaw}`);
    if (!lstatSync(cwd).isDirectory()) throw fail(409, `${target} already exists and is not a directory`);
    if (readdirSync(cwd).length > 0) throw fail(409, `${target} already exists and is not empty`);
  }

  let project: Project;
  try {
    project = createProject({
      name: input.name,
      cwd,
      description: template.description || null,
      logoUrl: template.logoUrl,
    });
  } catch (err) {
    /* Only if this call made it. A directory that was already there — the
       retry case above — is the user's, empty or not. It is empty by the check
       above and by nothing having been written into it, so the recursive
       remove has nothing to take with it. */
    if (created) rmSync(target, { recursive: true, force: true });
    throw err;
  }

  return {
    project,
    prompt: composeBody(renderPrompt(template, { name: project.name, cwd })),
    links: { mcpServerIds: template.mcpServerIds, skillIds: template.skillIds, commandIds: template.commandIds },
  };
}
