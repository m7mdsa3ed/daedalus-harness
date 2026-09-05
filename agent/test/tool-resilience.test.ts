import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentApp } from "../src/app.js";
import { makeRepairToolCall, resolveToolName } from "../src/tools/repair.js";
import {
  initialize,
  makeClient,
  promptOf,
  scriptedModel,
  testEnv,
  textScript,
  toolCallScript,
} from "./helpers/scripted.js";

function freshCwd(): string {
  return mkdtempSync(join(tmpdir(), "daedalus-agent-resilience-"));
}

/** The result text of the last completed-or-failed tool call. */
function lastToolText(harness: { updatesOf(kind: string): { update: unknown }[] }): string {
  const settled = harness
    .updatesOf("tool_call_update")
    .filter((u) => ["completed", "failed"].includes((u.update as { status?: string }).status ?? ""));
  return JSON.stringify(settled[settled.length - 1]?.update ?? {});
}

async function runTool(cwd: string, name: string, input: Record<string, unknown>): Promise<string> {
  const agent = buildAgentApp({
    env: testEnv(),
    makeModel: scriptedModel([toolCallScript(name, input), textScript("done ")]),
  });
  const { app: client, harness } = makeClient();
  let text = "";
  await client.connectWith(agent, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
    harness.answerPermission("allow");
    await ctx.request("session/prompt", { sessionId, prompt: promptOf("go") });
    text = lastToolText(harness);
  });
  return text;
}

// --- read numbers its lines, and says where it stopped ---
{
  const cwd = freshCwd();
  writeFileSync(join(cwd, "many.txt"), Array.from({ length: 5 }, (_, i) => `line ${i + 1}`).join("\n"));
  const text = await runTool(cwd, "read_file", { path: "many.txt", offset: 2, limit: 2 });
  assert.ok(text.includes("2\\tline 2"), `numbered lines: ${text}`);
  assert.ok(text.includes("lines 2-3 of 5"), `range stated: ${text}`);
  assert.ok(text.includes("offset 4"), `continuation offered: ${text}`);
  console.log("resilience: read numbering ok");
}

// --- a missing file answers with what is there instead ---
{
  const cwd = freshCwd();
  writeFileSync(join(cwd, "server.ts"), "export const x = 1;\n");
  const text = await runTool(cwd, "read_file", { path: "server.tsx" });
  assert.ok(text.includes("No such file"), text);
  assert.ok(text.includes("server.ts"), `suggests the near miss: ${text}`);
  console.log("resilience: read suggestions ok");
}

// --- an edit whose old_string carries read_file's line numbers still lands ---
{
  const cwd = freshCwd();
  writeFileSync(join(cwd, "app.ts"), "const a = 1;\nconst b = 2;\n");
  const text = await runTool(cwd, "edit_file", {
    path: "app.ts",
    old_string: "     2\tconst b = 2;",
    new_string: "const b = 3;",
  });
  assert.equal(readFileSync(join(cwd, "app.ts"), "utf8"), "const a = 1;\nconst b = 3;\n");
  assert.ok(text.includes("line-number"), `says how it matched: ${text}`);
  console.log("resilience: edit strips line numbers ok");
}

// --- indentation the model re-typed at the wrong depth is not a failure ---
{
  const cwd = freshCwd();
  writeFileSync(join(cwd, "deep.ts"), "function f() {\n  if (x) {\n      return 1;\n  }\n}\n");
  await runTool(cwd, "edit_file", {
    path: "deep.ts",
    old_string: "return 1;",
    new_string: "return 2;",
  });
  assert.equal(
    readFileSync(join(cwd, "deep.ts"), "utf8"),
    "function f() {\n  if (x) {\n      return 2;\n  }\n}\n",
    "the indented line was found and replaced in place",
  );
  console.log("resilience: edit indentation tolerance ok");
}

// --- a genuinely absent old_string is answered with the nearest lines ---
{
  const cwd = freshCwd();
  writeFileSync(join(cwd, "near.ts"), "export function handleError(err) {\n  return err;\n}\n");
  const text = await runTool(cwd, "edit_file", {
    path: "near.ts",
    old_string: "export function handleError(error: Error) {",
    new_string: "export function handleError(error: unknown) {",
  });
  assert.ok(text.includes("closest lines"), `points at a place: ${text}`);
  assert.ok(text.includes("handleError"), text);
  console.log("resilience: edit near-miss report ok");
}

// --- ambiguity names its occurrences instead of counting them ---
{
  const cwd = freshCwd();
  writeFileSync(join(cwd, "dup.ts"), "let x = 1;\nlet y = 2;\nlet x = 1;\n");
  const text = await runTool(cwd, "edit_file", { path: "dup.ts", old_string: "let x = 1;", new_string: "let x = 9;" });
  assert.ok(text.includes("2 times"), text);
  assert.ok(text.includes("lines 1, 3"), `names where: ${text}`);
  console.log("resilience: edit ambiguity ok");
}

// --- overwriting an unread file is refused, not done quietly ---
{
  const cwd = freshCwd();
  writeFileSync(join(cwd, "precious.ts"), "a lot of work\n");
  const text = await runTool(cwd, "write_file", { path: "precious.ts", content: "oops" });
  assert.ok(text.includes("has not been read"), text);
  assert.equal(readFileSync(join(cwd, "precious.ts"), "utf8"), "a lot of work\n");
  console.log("resilience: write guards an unread file ok");
}

// --- a mistyped glob root is an error, never an empty answer ---
{
  const cwd = freshCwd();
  const text = await runTool(cwd, "glob", { pattern: "**/*.ts", path: "nope" });
  assert.ok(text.includes("No such directory"), text);
  console.log("resilience: glob missing root ok");
}

// --- a bare glob matches by basename, not only at the root ---
{
  const cwd = freshCwd();
  writeFileSync(join(cwd, "top.ts"), "");
  const text = await runTool(cwd, "glob", { pattern: "*.ts" });
  assert.ok(text.includes("top.ts"), text);
  console.log("resilience: glob basename ok");
}

// --- tool-call repair: names, parameters, encodings ---
{
  const repair = makeRepairToolCall();
  const tools = { read_file: {}, edit_file: {}, bash: {}, glob: {} } as never;
  const schemas: Record<string, unknown> = {
    read_file: { properties: { path: { type: "string" }, offset: { type: "number" } }, required: ["path"] },
    edit_file: {
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["path", "old_string", "new_string"],
    },
    bash: { properties: { command: { type: "string" }, timeout_ms: { type: "number" } }, required: ["command"] },
    glob: { properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] },
  };
  const call = (toolName: string, input: string, step = 0) =>
    repair({
      toolCall: { type: "tool-call", toolCallId: "c1", toolName, input },
      tools,
      inputSchema: async ({ toolName: t }: { toolName: string }) => schemas[t],
      error: new Error("invalid"),
      messages: Array.from({ length: step }, () => ({ role: "user", content: [] })),
      system: undefined,
      instructions: undefined,
    } as never);

  assert.equal(resolveToolName("Read", ["read_file", "bash"]), "read_file");
  assert.equal(resolveToolName("functions.Bash", ["read_file", "bash"]), "bash");
  assert.equal(resolveToolName("wholly_unknown", ["read_file"]), null);

  const renamed = await call("Edit", JSON.stringify({ file_path: "a.ts", old_str: "x", new_str: "y" }));
  assert.equal(renamed?.toolName, "edit_file");
  assert.deepEqual(JSON.parse(renamed?.input ?? "{}"), { path: "a.ts", old_string: "x", new_string: "y" });

  const nested = await call("read_file", JSON.stringify({ input: { path: "b.ts", offset: "3" } }));
  assert.deepEqual(JSON.parse(nested?.input ?? "{}"), { path: "b.ts", offset: 3 });

  const doubled = await call("bash", JSON.stringify(JSON.stringify({ cmd: "ls -a" })));
  assert.deepEqual(JSON.parse(doubled?.input ?? "{}"), { command: "ls -a" });

  const fenced = await call("glob", '```json\n{"pattern": "**/*.ts"}\n```');
  assert.deepEqual(JSON.parse(fenced?.input ?? "{}"), { pattern: "**/*.ts" });

  const scalar = await call("glob", '"src/**/*.ts"');
  assert.deepEqual(JSON.parse(scalar?.input ?? "{}"), { pattern: "src/**/*.ts" });

  /* Two calls whose argument deltas were merged into one buffer: the first
     one lands, the second is the model's to reissue. */
  const merged = await call("read_file", '{"path":"client/src/components/thread-rail.tsx"}{"path":"client/src/components/composer.tsx"}');
  assert.deepEqual(JSON.parse(merged?.input ?? "{}"), { path: "client/src/components/thread-rail.tsx" });

  const trailing = await call("bash", '{"command":"echo \\"a}b\\""}\n{"command":"ls"}');
  assert.deepEqual(JSON.parse(trailing?.input ?? "{}"), { command: 'echo "a}b"' });

  const prose = await call("glob", 'Let me look: {"pattern":"**/*.ts"} — that should do it.');
  assert.deepEqual(JSON.parse(prose?.input ?? "{}"), { pattern: "**/*.ts" });

  /* On their own — a fresh step, so nothing salvaged earlier is in reach —
     these two are exactly as unrepairable as they look. */
  assert.equal(await call("edit_file", "{ this is not json at all", 1), null, "unrepairable stays an error");
  assert.equal(await call("read_file", JSON.stringify({ unrelated: 1 }), 2), null, "a missing requirement stays an error");
  console.log("resilience: tool-call repair ok");
}

// --- the sibling a merge starved gets its arguments back ---
{
  const repair = makeRepairToolCall();
  const tools = { read_file: {}, bash: {} } as never;
  const schemas: Record<string, unknown> = {
    read_file: { properties: { path: { type: "string" }, limit: { type: "number" } }, required: ["path"] },
    bash: { properties: { command: { type: "string" } }, required: ["command"] },
  };
  const call = (toolName: string, input: string, step = 0) =>
    repair({
      toolCall: { type: "tool-call", toolCallId: "c1", toolName, input },
      tools,
      inputSchema: async ({ toolName: t }: { toolName: string }) => schemas[t],
      error: new Error("invalid"),
      messages: Array.from({ length: step }, () => ({ role: "user", content: [] })),
      system: undefined,
      instructions: undefined,
    } as never);

  /* The shape the transcripts actually show: two parallel calls, one buffer.
     The first call takes the first object and the second — which arrived with
     nothing at all — takes what the first did not use, instead of failing on
     an empty arguments object and costing the model a whole round trip. */
  const first = await call("read_file", '{"path":"a.tsx"}{"limit":80,"path":"b.tsx"}');
  assert.deepEqual(JSON.parse(first?.input ?? "{}"), { path: "a.tsx" });
  const starved = await call("read_file", "{}");
  assert.deepEqual(JSON.parse(starved?.input ?? "{}"), { path: "b.tsx", limit: 80 });

  // Salvage belongs to its step: the next step never inherits it.
  await call("bash", '{"command":"ls"}{"command":"pwd"}', 3);
  assert.equal(await call("read_file", "{}", 4), null, "a new step starts empty");
  console.log("resilience: starved sibling recovery ok");
}

// --- an edit that forgot its path is placed by the text it is replacing ---
{
  const cwd = freshCwd();
  writeFileSync(join(cwd, "one.ts"), "export const alpha = 1;\n");
  writeFileSync(join(cwd, "two.ts"), "export const beta = 2;\n");
  const readFiles = new Map([
    [join(cwd, "one.ts"), 1],
    [join(cwd, "two.ts"), 2],
  ]);
  const repair = makeRepairToolCall({ readFiles });
  const tools = { edit_file: {}, write_file: {} } as never;
  const schemas: Record<string, unknown> = {
    edit_file: {
      properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } },
      required: ["path", "old_string", "new_string"],
    },
    write_file: {
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  };
  const call = (toolName: string, input: Record<string, unknown>, messages: unknown[] = []) =>
    repair({
      toolCall: { type: "tool-call", toolCallId: "c1", toolName, input: JSON.stringify(input) },
      tools,
      inputSchema: async ({ toolName: t }: { toolName: string }) => schemas[t],
      error: new Error("invalid"),
      messages,
      system: undefined,
      instructions: undefined,
    } as never);

  /* Only one of the two files read this session can hold that text, so the
     path is not a guess — it is the only file the edit could have meant. */
  const placed = await call("edit_file", { old_string: "export const beta = 2;", new_string: "export const beta = 3;" });
  assert.equal(JSON.parse(placed?.input ?? "{}").path, join(cwd, "two.ts"));

  /* Text that is in both files is ambiguous, and an edit landing in the wrong
     file is damage — so this stays a plain error. */
  const ambiguous = await call("edit_file", { old_string: "export const", new_string: "export let" }, []);
  assert.equal(ambiguous, null, "an ambiguous path is not guessed");

  /* Nothing to check a guess against, and a write would overwrite whatever it
     landed on outright: never filled. */
  const written = await call("write_file", { content: "nope" });
  assert.equal(written, null, "write_file is never given a path it did not name");

  /* The transcript is the other half: the file the model named a moment ago,
     when the replaced text is nowhere. edit_file cannot succeed wrongly — it
     answers with the file it looked in, which is the answer the model needs. */
  const messages = [
    { role: "assistant", content: [{ type: "tool-call", input: { path: join(cwd, "one.ts") } }] },
  ];
  const fromTranscript = await call("edit_file", { old_string: "gone", new_string: "here" }, messages);
  assert.equal(JSON.parse(fromTranscript?.input ?? "{}").path, join(cwd, "one.ts"));
  console.log("resilience: missing path recovery ok");
}

console.log("tool-resilience.test.ts passed");
