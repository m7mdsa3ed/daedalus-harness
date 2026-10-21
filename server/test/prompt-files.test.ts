// Self-check for the saved-file prompt readers (`prompt-files.ts`): what each
// runtime's own file says its request held, read from where it stopped, and —
// the point of the `missing` list — what it does not say. Fixtures use the
// record shapes of the real files (Claude Code's `prompt_snapshot` and context
// attachments, Codex's rollout, OpenCode's `instruction_state`), written to a
// temp home so nothing on this machine is read.
// Run: pnpm test:prompt-files
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readPromptPrefixNow, refreshPromptPrefix, promptPrefixOf, resetPromptFiles } from "../src/prompt-files.js";

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

const home = mkdtempSync(join(tmpdir(), "prompt-files-"));
process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
process.env.CODEX_HOME = join(home, "codex");
process.env.XDG_DATA_HOME = join(home, "share");
const jsonl = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const attach = (attachment: unknown) => ({ type: "attachment", attachment });
const words = (n: number, w = "alpha") => Array(n).fill(w).join(" ");

/* ── Claude Code ── */

const claudeFile = join(home, "claude", "projects", "-work-app", "sess-claude.jsonl");
mkdirSync(join(home, "claude", "projects", "-work-app"), { recursive: true });
writeFileSync(
  claudeFile,
  jsonl(
    { type: "user", message: { content: "hello" } },
    attach({ type: "prompt_snapshot", systemPrompt: [`You are an agent. ${words(40)}`, "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__", `# Rules\n${words(80)}`] }),
    attach({
      type: "prompt_snapshot",
      systemPrompt: [`You are an agent. ${words(40)}`, "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__", `# Rules\n${words(80)}`],
      cliPrefix: "You are Claude Code.",
      tools: [
        { name: "Bash", description: words(30), schema: { type: "object" } },
        { name: "mcp__docs__search", description: words(20), schema: { type: "object" } },
      ],
    }),
    attach({ type: "deferred_tools_delta", addedNames: ["CronCreate", "mcp__x__y"], removedNames: [] }),
    attach({ type: "mcp_instructions_delta", addedNames: ["docs"], addedBlocks: [`## docs ${words(25)}`], removedNames: [] }),
    attach({ type: "skill_listing", content: `- a: ${words(60)}`, isInitial: true }),
    attach({ type: "instructions", files: [{ path: "/p/CLAUDE.md", type: "Project", content: words(50) }] }),
  ),
);

await test("claude: system, tools and MCP are split from the saved snapshot, nothing missing", () => {
  resetPromptFiles();
  const p = readPromptPrefixNow("claude-jsonl", "sess-claude")!;
  assert.ok(p, "found the session file by id");
  assert.deepEqual(p.missing, []);
  assert.ok(p.system > 0 && p.tools > 0 && p.mcp > 0);
  const names = (list: { name: string }[]) => list.map((i) => i.name);
  assert.ok(names(p.items.system).some((n) => n.startsWith("System prompt › ")));
  assert.ok(names(p.items.system).includes("Skills › listing"));
  assert.ok(names(p.items.system).some((n) => n.startsWith("Project rules › ")));
  assert.ok(names(p.items.tools).includes("Bash"));
  assert.ok(names(p.items.tools).some((n) => n.startsWith("Deferred tool names")));
  assert.ok(names(p.items.mcp).includes("mcp__docs__search"), "an mcp__ tool is the MCP part's");
  assert.ok(names(p.items.mcp).includes("docs instructions"));
  assert.equal(p.system, p.items.system.reduce((n, i) => n + i.tokens, 0));
  assert.ok(!names(p.items.system).some((n) => n.includes("DYNAMIC_BOUNDARY")), "the boundary marker is not a prompt section");
});

await test("claude: a file with no tool list says tool schemas are missing; none at all says both", () => {
  const bare = join(home, "claude", "projects", "-work-app", "sess-bare.jsonl");
  writeFileSync(bare, jsonl(attach({ type: "prompt_snapshot", systemPrompt: [words(30)] })));
  assert.deepEqual(readPromptPrefixNow("claude-jsonl", "sess-bare")!.missing, ["tool schemas"]);
  const none = join(home, "claude", "projects", "-work-app", "sess-none.jsonl");
  writeFileSync(none, jsonl({ type: "user", message: { content: "hi" } }));
  assert.deepEqual(readPromptPrefixNow("claude-jsonl", "sess-none")!.missing, ["the system prompt", "tool schemas"]);
});

await test("claude: only what was appended is read, and a delta removes what it removes", () => {
  resetPromptFiles();
  refreshPromptPrefix("claude-jsonl", "sess-claude");
  return new Promise<void>((resolve, reject) =>
    setTimeout(() => {
      try {
        const first = promptPrefixOf("claude-jsonl", "sess-claude")!;
        assert.ok(first && first.version >= 1);
        appendFileSync(claudeFile, jsonl(attach({ type: "mcp_instructions_delta", addedNames: [], addedBlocks: [], removedNames: ["docs"] })));
        const next = readPromptPrefixNow("claude-jsonl", "sess-claude")!;
        assert.ok(next.mcp < first.mcp, "removed server instructions leave the prompt");
        resolve();
      } catch (e) {
        reject(e);
      }
    }, 50),
  );
});

await test("claude: a half-written last line waits for its newline", () => {
  const f = join(home, "claude", "projects", "-work-app", "sess-partial.jsonl");
  writeFileSync(f, jsonl(attach({ type: "prompt_snapshot", systemPrompt: [words(10)], tools: [] })) + '{"type":"attachment","attach');
  assert.ok(readPromptPrefixNow("claude-jsonl", "sess-partial")!);
});

await test("claude: an unknown session id is no reading, not an error", () => {
  assert.equal(readPromptPrefixNow("claude-jsonl", "nope"), null);
});

/* ── Codex ── */

mkdirSync(join(home, "codex", "sessions", "2026", "10", "21"), { recursive: true });
writeFileSync(
  join(home, "codex", "sessions", "2026", "10", "21", "rollout-2026-10-21T10-00-00-sess-codex.jsonl"),
  jsonl(
    { type: "session_meta", payload: { id: "sess-codex", base_instructions: words(200) } },
    { type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: `## Drawing an answer\n${words(60)}` }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `<environment_context>\n  <cwd>/x</cwd>\n</environment_context>` }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `${words(500)} a real prompt a person typed` }] } },
  ),
);

await test("codex: base instructions, developer and environment messages count; a person's words do not", () => {
  const p = readPromptPrefixNow("codex-rollout", "sess-codex")!;
  assert.ok(p, "found the rollout by thread id under the dated directories");
  assert.deepEqual(p.missing, ["tool schemas"]);
  assert.equal(p.tools, 0);
  assert.equal(p.mcp, 0);
  const names = p.items.system.map((i) => i.name);
  assert.ok(names.includes("System prompt › Base instructions"));
  assert.ok(names.some((n) => n.startsWith("Developer instructions › ")));
  assert.ok(names.some((n) => n.startsWith("Context › ")));
  assert.equal(names.length, 3, "the typed message is the transcript's, not the prompt's prefix");
});

await test("codex: no base instructions says the system prompt is missing too", () => {
  mkdirSync(join(home, "codex", "sessions", "2026", "10", "22"), { recursive: true });
  writeFileSync(join(home, "codex", "sessions", "2026", "10", "22", "rollout-2026-10-22T10-00-00-sess-codex2.jsonl"), jsonl({ type: "session_meta", payload: { id: "sess-codex2" } }));
  assert.deepEqual(readPromptPrefixNow("codex-rollout", "sess-codex2")!.missing, ["the system prompt", "tool schemas"]);
});

/* ── OpenCode ── */

mkdirSync(join(home, "share", "opencode"), { recursive: true });
const db = new DatabaseSync(join(home, "share", "opencode", "opencode.db"));
db.exec("create table instruction_state (session_id text primary key, current_values text not null)");
db.exec("create table instruction_blob (hash text primary key, value text)");
const blob = (hash: string, value: unknown) => db.prepare("insert into instruction_blob values (?, ?)").run(hash, JSON.stringify(value));
blob("h-env", `<env>\n  Working directory: /x\n</env>`);
blob("h-date", "Wed Oct 14 2026");
blob("h-skills", [{ id: "a", name: "a", description: words(40) }]);
blob("h-mcp", [{ server: "docs", instructions: words(30) }, { server: "agents", instructions: words(10) }]);
blob("h-tools", { total: 3, namespaces: [{ name: "opencode", entries: [] }] });
db.prepare("insert into instruction_state values (?, ?)").run(
  "ses_oc",
  JSON.stringify({ "core/environment": "h-env", "core/date": "h-date", "core/skill-guidance": "h-skills", "core/mcp-guidance": "h-mcp", "core/codemode": "h-tools" }),
);
db.close();

await test("opencode: injected context is split by key, and its own prompt and tool schemas are missing", () => {
  const p = readPromptPrefixNow("opencode-sqlite", "ses_oc")!;
  assert.ok(p, "read opencode.db read-only");
  assert.deepEqual(p.missing, ["its own system prompt", "tool schemas"]);
  assert.deepEqual(p.items.system.map((i) => i.name).sort(), ["Date", "Environment", "Skills › listing"]);
  assert.deepEqual(p.items.mcp.map((i) => i.name).sort(), ["agents instructions", "docs instructions"], "MCP guidance is one row a server");
  assert.deepEqual(p.items.tools.map((i) => i.name), ["Tool listing"]);
  assert.ok(p.system > 0 && p.mcp > 0 && p.tools > 0);
});

await test("opencode: a session with no saved instructions is no reading", () => {
  assert.equal(readPromptPrefixNow("opencode-sqlite", "ses_missing"), null);
});

console.log(`prompt-files: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.error(`  ✗ ${f}`);
process.exit(failures.length ? 1 : 0);
