// Self-check for templates: manifest listing and validation against a fixture
// directory (never the repo's real templates, which another change may be
// mid-edit), the slug, the one-mkdir rules of `prepareTargetDir`, what a copy
// leaves out, and the scaffold — including the cleanup when the row fails —
// plus the project row round-tripping its two new columns.
// Run: pnpm test:templates
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "../src/config.js";
import { ProjectInputSchema, createProject, getProject, updateProject, deleteProject, type ProjectInput } from "../src/projects.js";
import {
  SCRATCH_TEMPLATE_ID,
  TemplateManifestSchema,
  copyTemplate,
  detectCommand,
  detectDevCommand,
  listTemplates,
  getTemplate,
  prepareTargetDir,
  readProjectManifest,
  scaffoldFromScratch,
  scaffoldProject,
  scratchAgentsMd,
  slugify,
} from "../src/templates.js";
import { WorkspaceError } from "../src/workspace-fs.js";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
    })
    .catch((err) => {
      failures.push(`${name}\n    ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    });
}

/* ── fixtures ── */

const root = join(DATA_DIR, "fixtures");
rmSync(root, { recursive: true, force: true });
const templates = join(root, "templates");
const write = (path: string, content = "") => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
};

write(join(templates, "good", "template.json"), JSON.stringify({
  id: "good",
  name: "Good",
  description: "A fixture.",
  tags: ["react"],
  install: "pnpm install",
  dev: "pnpm dev",
  check: "pnpm check",
  sortOrder: 10,
}));
write(join(templates, "good", "package.json"), '{"name":"good"}');
write(join(templates, "good", "AGENTS.md"), "# rules\n");
write(join(templates, "good", "src", "App.tsx"), "export default () => null;\n");
write(join(templates, "good", "src", "nested", "node_modules", "x.js"), "nope");
write(join(templates, "good", "node_modules", "dep", "index.js"), "nope");
write(join(templates, "good", "dist", "bundle.js"), "nope");
write(join(templates, "good", ".git", "HEAD"), "ref: refs/heads/main\n");
write(join(templates, "good", ".gitignore"), "node_modules\n");

write(join(templates, "minimal", "template.json"), JSON.stringify({ id: "minimal", name: "Minimal", dev: "npm start" }));
write(join(templates, "minimal", "index.html"), "<html></html>");

write(join(templates, "broken", "template.json"), "{ not json");
write(join(templates, "mismatch", "template.json"), JSON.stringify({ id: "other", name: "Other", dev: "x" }));
write(join(templates, "nodev", "template.json"), JSON.stringify({ id: "nodev", name: "No dev" }));
mkdirSync(join(templates, "nomanifest"), { recursive: true });
write(join(templates, "scratch", "template.json"), JSON.stringify({ id: "scratch", name: "Impostor", dev: "x" }));
write(join(templates, "stray-file"), "not a dir");

/* ── manifests ── */

await test("listing keeps the valid manifests, applies defaults and sorts", () => {
  const list = listTemplates(templates);
  assert.deepEqual(list.map((t) => t.id), ["minimal", "good"]);
  const minimal = list[0]!;
  assert.deepEqual(minimal, {
    id: "minimal",
    name: "Minimal",
    description: "",
    tags: [],
    install: null,
    dev: "npm start",
    check: null,
    build: null,
    signals: [],
    sortOrder: 0,
  });
  assert.equal(getTemplate("good", templates)?.install, "pnpm install");
  assert.equal(getTemplate(SCRATCH_TEMPLATE_ID, templates), undefined, "the sentinel cannot be shadowed by a directory");
  assert.equal(getTemplate("mismatch", templates), undefined);
  assert.equal(getTemplate("nodev", templates), undefined);
  assert.deepEqual(listTemplates(join(root, "does-not-exist")), []);
});

await test("the manifest schema refuses a bad id and a missing dev", () => {
  assert.equal(TemplateManifestSchema.safeParse({ id: "Bad Id", name: "x", dev: "y" }).success, false);
  assert.equal(TemplateManifestSchema.safeParse({ id: "ok", name: "x" }).success, false);
  assert.equal(TemplateManifestSchema.safeParse({ id: "ok-1", name: "x", dev: "y" }).success, true);
});

await test("slugify", () => {
  assert.equal(slugify("My Todo App"), "my-todo-app");
  assert.equal(slugify("  Café  Ünïcode! "), "cafe-unicode");
  assert.equal(slugify("../../etc"), "etc");
  assert.equal(slugify("...."), "app");
  assert.equal(slugify(""), "app");
  assert.equal(slugify("a".repeat(100)).length, 64);
  assert.equal(slugify("-x-"), "x");
});

/* ── the one mkdir ── */

const parent = join(root, "apps");
mkdirSync(parent, { recursive: true });

const status = (fn: () => unknown): number => {
  try {
    fn();
  } catch (err) {
    if (err instanceof WorkspaceError) return err.status;
    throw err;
  }
  return 0;
};

await test("the parent must be absolute, existing and a directory", () => {
  assert.equal(status(() => prepareTargetDir("relative/dir", "x")), 400);
  assert.equal(status(() => prepareTargetDir(join(root, "missing"), "x")), 404);
  assert.equal(status(() => prepareTargetDir(join(templates, "stray-file"), "x")), 400);
});

await test("a new target is created; an empty one is reused; an occupied one, a file and a symlink are refused", () => {
  const fresh = prepareTargetDir(parent, "Fresh App");
  assert.equal(fresh.dir, join(parent, "fresh-app"));
  assert.equal(fresh.created, true);
  assert.ok(existsSync(fresh.dir));

  const again = prepareTargetDir(parent, "Fresh App");
  assert.equal(again.created, false);

  writeFileSync(join(fresh.dir, "x"), "");
  assert.equal(status(() => prepareTargetDir(parent, "fresh app")), 409);

  writeFileSync(join(parent, "a-file"), "");
  assert.equal(status(() => prepareTargetDir(parent, "a file")), 409);

  mkdirSync(join(root, "elsewhere"));
  symlinkSync(join(root, "elsewhere"), join(parent, "linked"));
  assert.equal(status(() => prepareTargetDir(parent, "linked")), 409);
});

await test("the parent is canonicalised, so a symlinked parent still works", () => {
  symlinkSync(parent, join(root, "apps-link"));
  const made = prepareTargetDir(join(root, "apps-link"), "via link");
  assert.equal(made.dir, join(parent, "via-link"));
  assert.equal(made.created, true);
});

/* ── the copy ── */

await test("copy leaves out the manifest, node_modules, dist and .git at any depth", () => {
  const dest = join(root, "copied");
  mkdirSync(dest);
  copyTemplate(join(templates, "good"), dest);
  const walk = (dir: string, prefix = ""): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
    );
  assert.deepEqual(walk(dest).sort(), [".gitignore", "AGENTS.md", "package.json", "src/App.tsx"]);
});

/* ── the scaffold ── */

const made: ProjectInput[] = [];
const fakeCreate = (input: ProjectInput) => {
  made.push(input);
  return { id: `p-${made.length}`, ...input };
};

await test("scaffold copies, inits git and records the row with the template's dev command", async () => {
  const project = await scaffoldProject(
    { templateId: "good", name: "Todo App", parent, description: "a todo list" },
    { templatesDir: templates, createProject: fakeCreate },
  );
  const dir = join(parent, "todo-app");
  assert.equal(project.cwd, dir);
  assert.equal(project.devCommand, "pnpm dev");
  assert.equal(project.templateId, "good");
  assert.equal(project.description, "a todo list");
  assert.ok(existsSync(join(dir, "src", "App.tsx")));
  assert.ok(!existsSync(join(dir, "template.json")));
  assert.ok(!existsSync(join(dir, "node_modules")));
  assert.ok(!existsSync(join(dir, "dist")));
  assert.ok(existsSync(join(dir, ".git")), "git init ran");
  assert.match(readFileSync(join(dir, ".git", "HEAD"), "utf8"), /^ref: /);
  assert.ok(existsSync(join(dir, ".git", "refs")) && readdirSync(join(dir, ".git")).includes("index"), "first commit staged a tree");
});

await test("an unknown template is a 404 and makes nothing", async () => {
  await assert.rejects(
    () => scaffoldProject({ templateId: "nope", name: "Ghost", parent }, { templatesDir: templates, createProject: fakeCreate }),
    (err: unknown) => err instanceof WorkspaceError && err.status === 404,
  );
  assert.ok(!existsSync(join(parent, "ghost")));
});

await test("a failing row removes a directory this call made, and only empties one it found", async () => {
  const boom = () => {
    throw new Error("db down");
  };
  await assert.rejects(
    () => scaffoldProject({ templateId: "minimal", name: "Made Here", parent }, { templatesDir: templates, createProject: boom }),
    /db down/,
  );
  assert.ok(!existsSync(join(parent, "made-here")), "removed");

  mkdirSync(join(parent, "found-empty"));
  await assert.rejects(
    () => scaffoldProject({ templateId: "minimal", name: "Found Empty", parent }, { templatesDir: templates, createProject: boom }),
    /db down/,
  );
  assert.ok(existsSync(join(parent, "found-empty")), "kept");
  assert.deepEqual(readdirSync(join(parent, "found-empty")), [], "emptied");
});

await test("a second scaffold into an occupied directory is a 409", async () => {
  await assert.rejects(
    () => scaffoldProject({ templateId: "good", name: "Todo App", parent }, { templatesDir: templates, createProject: fakeCreate }),
    (err: unknown) => err instanceof WorkspaceError && err.status === 409,
  );
});

/* ── from scratch ── */

await test("scaffold from scratch writes the rules file, inits git and records a row with no dev command", async () => {
  const project = await scaffoldFromScratch(
    { name: "Inventory API", parent, stack: "Flask", description: null },
    { createProject: fakeCreate },
  );
  const dir = join(parent, "inventory-api");
  assert.equal(project.cwd, dir);
  assert.equal(project.devCommand, null);
  assert.equal(project.templateId, SCRATCH_TEMPLATE_ID);
  assert.deepEqual(readdirSync(dir).sort(), [".git", ".gitignore", "AGENTS.md", "CLAUDE.md"]);
  const rules = readFileSync(join(dir, "AGENTS.md"), "utf8");
  assert.match(rules, /\*\*Flask\*\*/);
  assert.match(rules, /daedalus\.json/);
  assert.match(rules, /BASE_PATH/);
  assert.equal(readFileSync(join(dir, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
  assert.match(scratchAgentsMd("X", null), /Choose the stack/);
});

await test("scaffoldProject with a null or sentinel templateId is the scratch path", async () => {
  const a = await scaffoldProject({ templateId: null, name: "Null One", parent }, { templatesDir: templates, createProject: fakeCreate });
  const b = await scaffoldProject({ templateId: SCRATCH_TEMPLATE_ID, name: "Sentinel One", parent }, { templatesDir: templates, createProject: fakeCreate });
  assert.equal(a.templateId, SCRATCH_TEMPLATE_ID);
  assert.equal(b.templateId, SCRATCH_TEMPLATE_ID);
  assert.equal(a.devCommand, null);
});

await test("the dev command is sensed off the directory: daedalus.json first, then package.json through the lockfile", () => {
  const dir = join(root, "sense");
  mkdirSync(dir, { recursive: true });
  assert.equal(detectDevCommand(dir), null, "nothing there");
  assert.deepEqual(readProjectManifest(dir), { install: null, dev: null, check: null, build: null });

  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { start: "node server.js" } }));
  assert.equal(detectDevCommand(dir), "npm start");
  assert.equal(detectCommand(dir, "install"), "npm install");
  assert.equal(detectCommand(dir, "check"), null);

  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite", start: "x", check: "tsc", build: "vite build" } }));
  writeFileSync(join(dir, "pnpm-lock.yaml"), "");
  assert.equal(detectDevCommand(dir), "pnpm run dev");
  assert.equal(detectCommand(dir, "check"), "pnpm run check");
  assert.equal(detectCommand(dir, "build"), "pnpm run build");
  assert.equal(detectCommand(dir, "install"), "pnpm install");

  writeFileSync(join(dir, "daedalus.json"), JSON.stringify({ dev: "uv run flask run --port $PORT", check: "uv run pyright" }));
  assert.equal(detectDevCommand(dir), "uv run flask run --port $PORT", "the stated answer wins");
  assert.equal(detectCommand(dir, "check"), "uv run pyright");
  assert.equal(detectCommand(dir, "build"), "pnpm run build", "unstated falls through to package.json");

  writeFileSync(join(dir, "daedalus.json"), "{ nope");
  assert.equal(detectDevCommand(dir), "pnpm run dev", "a broken manifest reads as empty");
  writeFileSync(join(dir, "daedalus.json"), JSON.stringify({ dev: 42 }));
  assert.equal(detectDevCommand(dir), "pnpm run dev", "a wrong-typed manifest reads as empty");
});

/* ── the row ── */

await test("ProjectInputSchema defaults the two new columns and the row round-trips them", () => {
  const parsed = ProjectInputSchema.parse({ name: "x", cwd: "/tmp" });
  assert.equal(parsed.devCommand, null);
  assert.equal(parsed.templateId, null);

  const project = createProject({ name: "Row", cwd: root, description: null, devCommand: "pnpm dev", templateId: "good" });
  assert.equal(getProject(project.id)?.devCommand, "pnpm dev");
  assert.equal(getProject(project.id)?.templateId, "good");

  const updated = updateProject(project.id, ProjectInputSchema.parse({ name: "Row", cwd: root, devCommand: "  " }));
  assert.equal(updated?.devCommand, null, "blank clears it");
  assert.equal(updated?.templateId, null, "an update without it clears it");
  const legacy = createProject({ name: "Legacy", cwd: root, description: null });
  assert.equal(legacy.devCommand, null);
  assert.equal(legacy.templateId, null);
  deleteProject(project.id);
  deleteProject(legacy.id);
});

rmSync(root, { recursive: true, force: true });

console.log(`templates: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.error(`  ✗ ${f}`);
process.exit(failures.length ? 1 : 0);
