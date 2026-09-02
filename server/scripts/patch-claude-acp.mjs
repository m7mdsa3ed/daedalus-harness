#!/usr/bin/env node
/**
 * Teach the installed `@agentclientprotocol/claude-agent-acp` to forward a
 * dynamic workflow's per-agent progress.
 *
 * Claude Code streams a `task_progress` SDK message for every live background
 * task, and for a `local_workflow` task that message carries a
 * `workflow_progress` array: one entry per phase and per agent, with the
 * script's own label, the phase it belongs to, the agent's state, its tokens,
 * its tool count and the last tool it called. That array is the ONLY live
 * source for a run's shape — the journal the runtime writes beside the run
 * (`journal.jsonl`) holds nothing but `started`/`result` lines keyed by an
 * agent hash, and the full snapshot (`workflows/<runId>.json`) is not written
 * until the run reaches a terminal state, so neither can drive a live view.
 *
 * The adapter already handles `task_progress`, but copies only description,
 * summary, last tool name and usage into the `async_task_progress` update it
 * publishes, dropping `workflow_progress` on the floor. This patch adds it to
 * both hops. Nothing else about the adapter is touched.
 *
 * Idempotent: running it twice is a no-op, and it refuses rather than guesses
 * when the upstream source has moved on. Re-run it after every adapter
 * upgrade — `pnpm patch:acp` — until the passthrough lands upstream.
 */
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const PACKAGE = "@agentclientprotocol/claude-agent-acp";

/** Where the adapter is installed. It is a global install (see registry.ts),
    so resolution falls back to the paths node itself would search. */
function adapterDir() {
  const require = createRequire(import.meta.url);
  for (const specifier of [`${PACKAGE}/package.json`, PACKAGE]) {
    try {
      return dirname(require.resolve(specifier));
    } catch {
      /* try the next spelling */
    }
  }
  const roots = (process.env.NODE_PATH ?? "")
    .split(process.platform === "win32" ? ";" : ":")
    .filter(Boolean);
  for (const root of roots) {
    const candidate = join(root, ...PACKAGE.split("/"), "package.json");
    try {
      readFileSync(candidate, "utf8");
      return dirname(candidate);
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/**
 * One edit: find `needle` exactly once and put `replacement` in its place.
 * `done` is what the already-patched file looks like, so a second run is a
 * no-op rather than a failure.
 */
function edit(source, { needle, replacement, done, what }) {
  if (source.includes(done)) return { source, changed: false, what };
  const hits = source.split(needle).length - 1;
  if (hits !== 1) {
    throw new Error(
      `${what}: expected exactly one match against the upstream source, found ${hits}. ` +
        "The adapter has changed — re-read it and update this patch.",
    );
  }
  return { source: source.replace(needle, replacement), changed: true, what };
}

const dir = adapterDir();
if (!dir) {
  console.error(
    `patch:acp — ${PACKAGE} is not installed, so there is nothing to patch.\n` +
      `Install it (npm install -g ${PACKAGE}) and run this again.`,
  );
  process.exit(0);
}

const AGENT_FILE = join(dir, "dist", "acp-agent.js");
const TASKS_FILE = join(dir, "dist", "async-tasks.js");

const edits = [
  {
    file: AGENT_FILE,
    what: "acp-agent.js: carry workflow_progress into the async-task runtime",
    needle: `                                    last_tool_name: message.last_tool_name,
                                    usage: message.usage,
                                });`,
    replacement: `                                    last_tool_name: message.last_tool_name,
                                    usage: message.usage,
                                    workflow_progress: message.workflow_progress,
                                });`,
    done: "workflow_progress: message.workflow_progress,",
  },
  {
    file: TASKS_FILE,
    what: "async-tasks.js: read workflowProgress off the progress message",
    needle: `        const lastToolName = nonBlankString(field(message, "lastToolName", "last_tool_name"));`,
    replacement: `        const lastToolName = nonBlankString(field(message, "lastToolName", "last_tool_name"));
        const rawWorkflowProgress = field(message, "workflowProgress", "workflow_progress");
        const workflowProgress = Array.isArray(rawWorkflowProgress) ? rawWorkflowProgress : undefined;`,
    done: 'const rawWorkflowProgress = field(message,',
  },
  {
    file: TASKS_FILE,
    what: "async-tasks.js: publish it on async_task_progress",
    needle: `            ...(lastToolName ? { lastToolName } : {}),
            ...(usage ? { usage } : {}),`,
    replacement: `            ...(lastToolName ? { lastToolName } : {}),
            ...(usage ? { usage } : {}),
            ...(workflowProgress ? { workflowProgress } : {}),`,
    done: "...(workflowProgress ? { workflowProgress } : {}),",
  },
];

const version = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
const byFile = new Map();
let changedAny = false;

try {
  for (const spec of edits) {
    const current = byFile.get(spec.file) ?? readFileSync(spec.file, "utf8");
    const result = edit(current, spec);
    byFile.set(spec.file, result.source);
    console.log(`  ${result.changed ? "patched" : "already patched"} — ${result.what}`);
    changedAny ||= result.changed;
  }
} catch (err) {
  console.error(`patch:acp — ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

if (changedAny) for (const [file, source] of byFile) writeFileSync(file, source);

console.log(
  changedAny
    ? `patch:acp — ${PACKAGE}@${version} patched at ${dir}.\n` +
        "Restart any running agent processes for it to take effect."
    : `patch:acp — ${PACKAGE}@${version} at ${dir} was already patched; nothing to do.`,
);
