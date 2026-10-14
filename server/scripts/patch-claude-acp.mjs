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
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

const PACKAGE = "@agentclientprotocol/claude-agent-acp";

/** Where the adapter is installed: the package behind the `claude-agent-acp`
    binary on PATH, since that is exactly what the harness spawns (registry.ts —
    global binary, never npx). Not `require.resolve` or `npm root -g`: the dev
    shell points npm_config_prefix at server/, so both can land inside the repo.
    `CLAUDE_AGENT_ACP_DIR` overrides it. */
function adapterDir() {
  if (process.env.CLAUDE_AGENT_ACP_DIR) return process.env.CLAUDE_AGENT_ACP_DIR;
  for (const bin of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of ["claude-agent-acp", "claude-agent-acp.cmd"]) {
      let target;
      try {
        target = realpathSync(join(bin, name));
      } catch {
        continue;
      }
      // .../claude-agent-acp/dist/index.js -> the package root holding package.json.
      for (let dir = dirname(target); dir !== dirname(dir); dir = dirname(dir)) {
        if (!existsSync(join(dir, "package.json"))) continue;
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        if (pkg.name === PACKAGE) return dir;
      }
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
const NATIVE_FILE = join(dir, "dist", "native-subagents.js");

const edits = [
  {
    file: AGENT_FILE,
    what: "acp-agent.js: carry workflow_progress into the async-task runtime",
    // 0.82+ added tool_use_id after usage; the anchor is the whole task_progress call's tail.
    needle: `                                    last_tool_name: message.last_tool_name,
                                    usage: message.usage,
                                    tool_use_id: message.tool_use_id,
                                });`,
    replacement: `                                    last_tool_name: message.last_tool_name,
                                    usage: message.usage,
                                    tool_use_id: message.tool_use_id,
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
  /*
   * Subagents across a restart. A `session/load` replays each Agent launch as
   * a `:replay-subagent:` child, but never registers it in the live registry
   * under the SDK's agent id. So when the model resumes one with SendMessage
   * after the load, `taskResumed` finds no previous child and does nothing.
   * The resumed child then runs with nobody announcing it, and every frame it
   * sends is buffered under its launch tool id and never delivered: the
   * harness sees no subagent at all. The next three edits close that.
   */
  {
    file: AGENT_FILE,
    what: "acp-agent.js: a background launch's result is not its end",
    // The launch answers "Async agent launched" at once, which the replay read
    // as `completed`. A child killed mid-run then looks finished; with no
    // result, the replay's own fallback says `disconnected`.
    needle: `function replaySubagentTerminalState(block) {
    if (block.is_error !== true)
        return "completed";`,
    replacement: `function replaySubagentTerminalState(block) {
    if (block.is_error !== true)
        return /^\\s*Async agent launched\\b/.test(replayContentText(block.content)) ? undefined : "completed";`,
    done: "/^\\s*Async agent launched\\b/.test(",
  },
  {
    file: AGENT_FILE,
    what: "acp-agent.js: register replayed subagents under their agent id",
    needle: `                        state: child.reconstructable
                            ? (child.notifiedState ?? child.terminalState ?? "disconnected")
                            : "disconnected",
                    },
                }));
            }
        }`,
    replacement: `                        state: child.reconstructable
                            ? (child.notifiedState ?? child.terminalState ?? "disconnected")
                            : "disconnected",
                    },
                }));
            }
            // daedalus: a finished child under its SDK agent id, so a SendMessage
            // resume after this load opens a new generation (subagent_spawned)
            // and the turn holds for it, as a live resume does.
            const liveState = replayState();
            if (liveState) {
                const liveChildren = (liveState.nativeSubagentsByTaskId ??= new Map());
                const resumable = (liveState.resumableSubagents ??= new Map());
                for (const [toolUseId, child] of replayChildren) {
                    const agentId = subagents.ids.get(toolUseId);
                    if (!agentId || !child.announced || liveChildren.has(agentId))
                        continue;
                    liveChildren.set(agentId, {
                        sessionId: child.sessionId,
                        parentSessionId: sessionId,
                        parentToolUseId: toolUseId,
                        name: child.name,
                        task: child.task,
                        announced: true,
                        terminalState: child.reconstructable
                            ? (child.notifiedState ?? child.terminalState ?? "disconnected")
                            : "disconnected",
                    });
                    resumable.set(agentId, { parentToolUseId: toolUseId });
                }
            }
        }`,
    done: "// daedalus: a finished child under its SDK agent id",
  },
  {
    file: AGENT_FILE,
    what: "acp-agent.js: the loaded session keeps what the replay registered",
    // The replay runs while the CLI starts, into the pending state; the session
    // record is built from it. Created up front so both hold the same maps
    // whichever finishes first.
    needle: `                cwd: params.cwd,
                taskState: new Map(),
                forwardSubagentText: this.forwardsSubagentText(params._meta),`,
    replacement: `                cwd: params.cwd,
                taskState: new Map(),
                nativeSubagentsByTaskId: new Map(),
                resumableSubagents: new Map(),
                forwardSubagentText: this.forwardsSubagentText(params._meta),`,
    done: `                nativeSubagentsByTaskId: new Map(),
                resumableSubagents: new Map(),
                forwardSubagentText:`,
  },
  {
    file: AGENT_FILE,
    what: "acp-agent.js: the session record adopts the replay's subagent maps",
    needle: `                liveBackgroundTasks: new Map(),
                nativeSubagentsByTaskId: new Map(),`,
    replacement: `                liveBackgroundTasks: new Map(),
                nativeSubagentsByTaskId: creationOpts.replayState?.nativeSubagentsByTaskId ?? new Map(),
                resumableSubagents: creationOpts.replayState?.resumableSubagents,`,
    done: "nativeSubagentsByTaskId: creationOpts.replayState?.nativeSubagentsByTaskId ?? new Map(),",
  },
  /*
   * A resume speaks two ids, restart or not. The SDK names a resumed task by
   * the SendMessage call that woke it (`task_started` and `task_notification`
   * carry that id), but the child's own frames keep the id of the Agent call
   * that first launched it. Upstream keys the new generation on the
   * SendMessage id, so every frame the child sends is "unattributed" and
   * dropped once the pending buffer fills, and its end is never matched, so
   * the row says running forever.
   */
  {
    file: NATIVE_FILE,
    what: "native-subagents.js: a resumed generation keeps its launch's tool id",
    needle: `            parentToolUseId: task.toolUseId ?? undefined,`,
    replacement: `            parentToolUseId: previous?.parentToolUseId ?? task.toolUseId ?? undefined,`,
    done: "parentToolUseId: previous?.parentToolUseId ?? task.toolUseId ?? undefined,",
  },
  {
    file: NATIVE_FILE,
    what: "native-subagents.js: a resumed task's end is matched by its task id",
    needle: `        const child = toolUseId ? this.childByParentToolUse.get(toolUseId) : this.children.get(taskId);
        if (child && toolUseId && this.taskByToolUse.get(toolUseId) !== taskId)
            return;`,
    replacement: `        // daedalus: a resumed task ends under the SendMessage id, which owns no child.
        const child = (toolUseId && this.childByParentToolUse.get(toolUseId)) || this.children.get(taskId);
        const toolOwner = toolUseId ? this.taskByToolUse.get(toolUseId) : undefined;
        if (toolOwner !== undefined && toolOwner !== taskId)
            return;`,
    done: "// daedalus: a resumed task ends under the SendMessage id",
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
