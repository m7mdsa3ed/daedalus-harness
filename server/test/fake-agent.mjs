// Minimal ACP-ish agent: answers requests, streams one update per prompt,
// and exercises modes / config options / usage so the client UI can be tested.
//
// The transcript is developed against this agent, so every branch of the step
// row needs a live sample here. They are grouped into named SCENES (see the
// table above `SCENES` below) — an ordinary prompt streams the whole catalogue,
// and `scene:<name>` streams one of them, which is how a surface gets worked on
// without scrolling past the other twenty. A bare `scene:` lists them.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

/* The `_meta` this agent was handed when its session was created or loaded,
   written to disk rather than echoed as an update: the test needs to assert on
   it, and inventing a transcript row to carry it would change what every other
   assertion in bridge.test.ts sees. One JSON object per line, appended, so a
   respawn's `session/load` is a second line and not a lost first one. */
const RECORD = process.env.DAEDALUS_DATA_DIR
  ? join(process.env.DAEDALUS_DATA_DIR, "fake-session-meta.jsonl")
  : null;
const recordSessionMeta = (method, params) => {
  if (!RECORD) return;
  try {
    appendFileSync(RECORD, JSON.stringify({ method, meta: params?._meta ?? null }) + "\n");
  } catch {
    // The recording is a test convenience; the agent still has to answer.
  }
};

// `category` is what tells the client which selector is the model and which is
// the reasoning level, so those two get promoted out of the generic "Agent
// options" list. The third option deliberately carries no category: unknown and
// missing categories must still render, and this is what proves it.
let configOptions = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "fast",
    options: [
      { value: "fast", name: "Fast" },
      { value: "smart", name: "Smart" },
    ],
  },
  {
    id: "effort",
    name: "Effort",
    category: "thought_level",
    type: "select",
    currentValue: "medium",
    options: [
      { value: "low", name: "Low effort" },
      { value: "medium", name: "Medium effort" },
      { value: "high", name: "High effort" },
    ],
  },
  {
    id: "verbose",
    name: "Verbose logging",
    type: "boolean",
    currentValue: false,
  },
];

/* What the client claimed at initialize. Compaction updates are the one thing
   here an agent is forbidden to send unquestioned — the spec says only when the
   client advertised `session.compaction` — so this is stored and honoured
   rather than assumed, which is what makes the capability itself testable. */
let clientCapabilities = {};

/* A Codex-style fallback-metadata warning, gated on an env var so the bridge
   test can prove a profile opting out of it never sees it. Real codex-acp
   streams the same wording as an `agent_message_chunk`. */
const FALLBACK_WARNING = process.env.FAKE_FALLBACK_WARNING || "";

/** Permission/elicitation request id -> `{promptId, after}`: the prompt whose
    turn is waiting on it, and what the answer makes the agent say. `after` is
    how an answered question becomes a *record* of itself in the transcript —
    the AskUserQuestion tool call carrying what was picked — which is a
    different view from the form the reader just filled in. */
const parkedTurns = new Map();
/** The harness's pause flag, as the daedalus agent keeps it. */
let paused = false;
let permCounter = 0;
/** Per-prompt counters — one names an unpointed fork, the other the turn a
    fork point names (real runtimes stamp message ids on their chunks; one
    id per turn is all a fork point needs, and deterministic enough to
    assert on). */
let forkCounter = 0;
let turnCounter = 0;

/** Park `promptId` on the request `id`, optionally with a follow-up. */
const park = (id, promptId, after) => parkedTurns.set(id, { promptId, after });

const tool = (id, title, kind, status, extra = {}) => ({
  sessionUpdate: "tool_call",
  toolCallId: id,
  title,
  kind,
  status,
  ...extra,
});
const text = (t) => [{ type: "content", content: { type: "text", text: t } }];

function stepUpdates() {
  const plan = (a, b) => ({
    sessionUpdate: "plan",
    entries: [
      { content: "Read the transcript components", status: a, priority: "high" },
      { content: "Redesign the step rows", status: b, priority: "high" },
      { content: "Screenshot the result", status: "pending", priority: "medium" },
    ],
  });
  return [
    // When configured, this is the very first thing a turn says — exactly when
    // codex says it (the warning precedes the turn's work).
    ...(FALLBACK_WARNING
      ? [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: FALLBACK_WARNING } }]
      : []),
    { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "The rail geometry is the risky part.\nMeasure it against the row's own line box." } },
    plan("in_progress", "pending"),
    tool("t1", "ls -la", "execute", "in_progress"),
    { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: text("file-a.txt\nfile-b.txt") },
    tool("t2", "src/lib/store.ts", "read", "completed", {
      locations: [{ path: "src/lib/store.ts", line: 87 }],
      content: text(Array.from({ length: 12 }, (_, i) => `${i + 1} | line of file`).join("\n")),
    }),
    tool("t3", '"applySessionUpdate"', "search", "completed", {
      locations: [
        { path: "src/lib/store.ts", line: 87 },
        { path: "src/components/thread-view.tsx", line: 12 },
      ],
    }),
    tool("t4", "src/index.css", "edit", "completed", {
      content: [
        {
          type: "diff",
          path: "src/index.css",
          oldText: ".harness-rail-top { top: -2px; height: 6px; }",
          newText: ".harness-rail-top { top: -2px; height: 10px; }\n.harness-rail-bottom { top: 20px; bottom: -2px; }",
        },
      ],
    }),
    tool("t5", "pnpm exec tsc -b --force", "execute", "failed", {
      content: text("error TS2322: Type 'string' is not assignable to type 'number'."),
    }),
    plan("completed", "in_progress"),
    tool("t6", "https://example.com/spec", "fetch", "pending"),
    // Parent prose AFTER the subagents: proves it does not coalesce into the
    // child's last chunk (the reducer keys text runs on their owner too).
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Rail lines up. Here's what changed:\n\n- node centre pinned to the row's line box\n- kind demoted to a right-hand column" } },
  ];
}

/* An update that belongs to a subagent's OWN session (the RFD's shape): the
   prompt loop sends it under `sessionId` instead of the thread's. Everything
   else in `promptUpdates` is a bare update on the thread's session. */
const on = (sessionId, update) => ({ sessionId, update });

/**
 * Two subagents, one per mechanism the harness understands, so both code
 * paths have a live sample:
 *
 * 1. claude-agent-acp's: a `Task` tool call on the thread's session, and the
 *    child's work as further updates on the SAME session stamped
 *    `_meta.claudeCode.parentToolUseId`. The child's prose is sent only when
 *    the client claimed `_meta["subagent-transcript"]` — what the real agent
 *    does — so the capability is what the test observes. `t7a` arrives with no
 *    parent and acquires it on its update, which is the attribution race the
 *    real agent documents as best-effort. The `user_message_chunk` is the
 *    tool-result echo the real agent forwards; the client drops it.
 * 2. The RFD's: `subagent_spawned` on the thread's session, the child's
 *    updates on the child's session, `subagent_state_update` back on the
 *    thread's. Sent only when the client claimed `subagents`, as the RFD
 *    requires — an agent MUST NOT send these to a client that did not.
 */
function subagentUpdates() {
  const out = [];
  const child = (update) => ({ ...update, _meta: { claudeCode: { parentToolUseId: "t7" } } });
  const transcript = clientCapabilities._meta?.["subagent-transcript"] === true;
  out.push(
    tool("t7", "Review the store reducer", "think", "in_progress", {
      rawInput: {
        description: "Review the store reducer",
        prompt: "Read src/lib/store.tsx and report whether applySessionUpdate handles every variant.",
        subagent_type: "code-reviewer",
      },
      content: text("Read src/lib/store.tsx and report whether applySessionUpdate handles every variant."),
      _meta: { claudeCode: { toolName: "Task", subagent: true } },
    }),
  );
  if (transcript) {
    out.push(child({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Starting with the reducer's switch." } }));
  }
  out.push(
    tool("t7a", "src/lib/store.tsx", "read", "in_progress"),
    child({ sessionUpdate: "tool_call_update", toolCallId: "t7a", status: "completed", content: text("export function applySessionUpdate(") }),
    child(tool("t7b", "grep -n applySessionUpdate src", "execute", "completed", { content: text("src/lib/store.tsx:297") })),
  );
  if (transcript) {
    out.push(
      child({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Every variant is handled; the default arm drops unknown ones." } }),
      child({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "[tool result echo — a client must not render this]" } }),
    );
  }
  out.push({
    sessionUpdate: "tool_call_update",
    toolCallId: "t7",
    status: "completed",
    rawOutput: "Every variant is handled; the default arm drops unknown ones.",
    _meta: { claudeCode: { toolName: "Task", toolResponse: { subagentType: "code-reviewer", elapsedTimeSeconds: 4 } } },
  });

  if (clientCapabilities.subagents) {
    out.push(
      { sessionUpdate: "subagent_spawned", subagentSessionId: "sub-1", name: "explorer", task: "Find every caller of groupToolRuns", capabilities: {} },
      on("sub-1", tool("s1", "rg groupToolRuns", "search", "completed", { content: text("src/components/thread-view.tsx:47") })),
      on("sub-1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "One caller, in thread-view." } }),
      { sessionUpdate: "subagent_state_update", subagentSessionId: "sub-1", state: "completed" },
      /* Two more, side by side and named alike: consecutive subagent rows fold
         into one `SubagentBatch` ("2 × explorer"), which is the ad-hoc half of
         the run row a workflow draws the other half of. One of them fails,
         because a batch that always succeeds never shows its failure line. */
      { sessionUpdate: "subagent_spawned", subagentSessionId: "sub-2", name: "explorer", task: "Map the theme tokens", capabilities: { cancel: true } },
      { sessionUpdate: "subagent_spawned", subagentSessionId: "sub-3", name: "explorer", task: "Map the shortcut table", capabilities: { cancel: true } },
      on("sub-2", tool("s2", "src/styles/themes.css", "read", "completed", { content: text("--radius: 0.5rem;") })),
      on("sub-3", tool("s3", "src/lib/shortcuts.ts", "read", "failed", { content: text("ENOENT: no such file") })),
      on("sub-2", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Nine tokens, all generated." } }),
      { sessionUpdate: "subagent_state_update", subagentSessionId: "sub-2", state: "completed" },
      { sessionUpdate: "subagent_state_update", subagentSessionId: "sub-3", state: "failed" },
    );
  }
  /* The AIR async-task lifecycle, as claude-agent-acp publishes a dynamic
     workflow — sent only to a client that claimed `asyncTasks` under
     `_meta.jetbrains.air`, exactly as the adapter gates it. Three frames the
     SDK's closed union knows nothing about; the bridge test asserts all three
     reach the browser with the progress array intact. */
  const air = clientCapabilities?._meta?.jetbrains?.air;
  if (Array.isArray(air?.capabilities) && air.capabilities.includes("asyncTasks")) {
    out.push(
      { sessionUpdate: "async_task_spawned", asyncTaskId: "wt-1", name: "fake-audit", taskType: "workflow", description: "Audit the fake repo", showInTranscript: true, canStop: true, toolCallId: "t7" },
      {
        sessionUpdate: "async_task_progress",
        asyncTaskId: "wt-1",
        usage: { totalTokens: 4242, toolUses: 3, durationMs: 1200 },
        lastToolName: "Bash",
        workflowProgress: [
          { type: "workflow_phase", index: 1, title: "Map" },
          { type: "workflow_agent", index: 1, label: "read:server", phaseIndex: 1, phaseTitle: "Map", agentId: "a1", state: "done", tokens: 4242, toolCalls: 3, lastToolName: "Bash", resultPreview: "one finding" },
        ],
      },
      { sessionUpdate: "async_task_state_update", asyncTaskId: "wt-1", state: "completed", summary: "1 agent, 1 finding" },
    );
  }
  return out;
}

/**
 * A harness workflow run, as the *server* stamps one.
 *
 * A real run is the harness's own machinery — the workflow MCP server drives
 * the engine, which creates a thread per step and mirrors each one onto the
 * parent as an RFD spawn carrying `_meta.daedalus.workflow`. No agent emits
 * this. It is faked here anyway because the run row (`WorkflowRun`) is drawn
 * entirely from those spawns, and a UI that can only be seen by running a real
 * multi-step workflow against a real provider is a UI nobody iterates on.
 *
 * What the shape has to carry, since the row reads all of it: the run id every
 * step merges by, the definition's whole outline (`plan`, repeated on every
 * spawn — that is what draws the steps that have not started yet as pending
 * rows), the phase a step was written under, and the per-step cost, which
 * arrives as `_daedalus/subagent_usage` because a child's `turn_ended` is
 * never mirrored.
 *
 * The definition deliberately outruns the run: `docs` is in the outline and
 * never spawns, so the pending row has a sample, and `review:client` fails, so
 * the failed-step caption does.
 */
function workflowUpdates() {
  // A run is spawns, and the RFD forbids sending those to a client that did not
  // ask for them — so say why the scene is empty rather than ending in silence.
  if (!clientCapabilities.subagents) {
    return [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "(no run: this client did not claim the `subagents` capability)" } }];
  }
  const runId = `wf-${Date.now().toString(36)}`;
  const plan = [
    { name: "Review", steps: ["review:server", "review:client"] },
    { name: "Fix", steps: ["apply-fixes"] },
    { name: "Report", steps: ["docs"] },
  ];
  const total = plan.reduce((n, phase) => n + phase.steps.length, 0);
  const index = (step) => plan.flatMap((p) => p.steps).indexOf(step);
  const spawn = (sessionId, step, phase, task) => ({
    sessionUpdate: "subagent_spawned",
    subagentSessionId: sessionId,
    name: step,
    task,
    capabilities: { cancel: true },
    _meta: {
      daedalus: {
        workflow: {
          runId,
          name: "Review and repair",
          step,
          index: index(step),
          total,
          phase: { index: plan.findIndex((p) => p.name === phase), name: phase },
          plan,
        },
      },
    },
  });
  const usage = (sessionId, totalTokens) => ({
    sessionUpdate: "_daedalus/subagent_usage",
    subagentSessionId: sessionId,
    usage: { totalTokens, inputTokens: Math.round(totalTokens * 0.8), outputTokens: Math.round(totalTokens * 0.2) },
  });
  const done = (sessionId, state) => ({ sessionUpdate: "subagent_state_update", subagentSessionId: sessionId, state });

  return [
    { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Four steps, three phases. The review halves can run together." } },
    // Both review steps spawn before either reports: a run's steps are
    // scheduled, not sequenced, and the row has to survive interleaving.
    spawn(`${runId}-1`, "review:server", "Review", "Review server/src for dangling ids"),
    spawn(`${runId}-2`, "review:client", "Review", "Review client/src for unowned state"),
    on(`${runId}-1`, tool("w1", "rg 'ON DELETE' server/src", "search", "completed", { content: text("server/src/db/schema.ts:112") })),
    on(`${runId}-2`, tool("w2", "pnpm exec tsc -b", "execute", "failed", { content: text("error TS2554: Expected 2 arguments, but got 1.") })),
    on(`${runId}-1`, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: '{"issues": 0}' } }),
    on(`${runId}-2`, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "the step's turn failed to typecheck" } }),
    usage(`${runId}-1`, 4_200),
    usage(`${runId}-2`, 1_100),
    done(`${runId}-1`, "completed"),
    done(`${runId}-2`, "failed"),
    spawn(`${runId}-3`, "apply-fixes", "Fix", "Apply the reviewers' findings"),
    on(`${runId}-3`, tool("w3", "server/src/queue.ts", "edit", "completed", {
      content: [{ type: "diff", path: "server/src/queue.ts", oldText: "drain(session)", newText: "drain(session, { reason })" }],
    })),
    usage(`${runId}-3`, 8_800),
    done(`${runId}-3`, "completed"),
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Two of four steps landed; `review:client` failed on a typecheck and `docs` never ran." } },
  ];
}

/**
 * Questions, as the transcript keeps them.
 *
 * The *live* question is an `elicitation/create` and is driven by `ask:` /
 * `elicit:` below — this is the settled record that stays behind, which is a
 * different view (`extractQuestions`) and used to render as a JSON dump of the
 * very form the reader had just filled in. The answer is half of the record,
 * so each sample carries one: keyed by question text on `rawOutput.answers`,
 * with `annotations` for the free text a reader added beside their pick.
 *
 * Four shapes, because each is a different row: one answered single-select,
 * one call asking two questions at once, a multi-select whose last pick is the
 * "Other" nobody offered, and one still waiting.
 */
function questionUpdates() {
  const ask = (id, title, status, questions, answers, annotations) =>
    tool(id, title, "think", status, {
      _meta: { claudeCode: { toolName: "AskUserQuestion" } },
      rawInput: { questions },
      ...(answers ? { rawOutput: { answers, ...(annotations ? { annotations } : {}) } } : {}),
    });
  const backend = "Which storage backend should the queue use?";
  const surfaces = "Which surfaces should show the badge?";
  const naming = "What should the drain event be called?";
  return [
    ask("q1", "Choose a storage backend", "completed",
      [{
        question: backend,
        header: "Storage",
        multiSelect: false,
        options: [
          { label: "SQLite (Recommended)", description: "One file, synchronous reads, already the harness's own store." },
          { label: "Postgres", description: "A second process to run and a connection pool to tune." },
          { label: "In-memory", description: "Fastest, and the queue does not survive a restart." },
        ],
      }],
      { [backend]: "SQLite (Recommended)" },
      { [backend]: { notes: "Keep the door open for Postgres — no raw SQL in the routes." } },
    ),
    ask("q2", "Two decisions", "completed",
      [
        {
          question: surfaces,
          header: "Surfaces",
          multiSelect: true,
          options: [
            { label: "Composer", description: "Under the send button." },
            { label: "Thread header", description: "Beside the model chip." },
            { label: "Sidebar row", description: "On the thread's own row." },
          ],
        },
        {
          question: naming,
          header: "Naming",
          multiSelect: false,
          options: [
            { label: "drain", description: "What the server already calls it." },
            { label: "flush", description: "What the journal calls its own." },
          ],
        },
      ],
      // A pick the question never offered is the free-text "Other" — the row
      // has to show it as an answer, not drop it for failing to match.
      { [surfaces]: ["Composer", "Sidebar row", "A pinned toast"], [naming]: "drain" },
    ),
    ask("q3", "Pick a migration window", "in_progress",
      [{
        question: "When should the schema push run?",
        header: "Window",
        multiSelect: false,
        options: [
          { label: "Now", description: "One instance, fork mode — the restart is a second." },
          { label: "After the release", description: "Nothing else is queued behind it." },
        ],
      }],
    ),
  ];
}

/**
 * Every other view a tool call can get, one sample each — the tail of
 * `toolViewOf`'s switch, which is where a runtime's own tool lands when nobody
 * has taught the client about it, plus the named views a step row draws
 * instead of the generic one.
 *
 * Order here is the order they appear in the transcript, not the order the
 * switch evaluates them in: a reader working on one of these wants it beside
 * the others, and the switch's priorities are asserted in the client, not
 * here.
 */
function otherUpdates() {
  const todos = (a, b, c) => tool(`o1-${a[0]}${b[0]}${c[0]}`, "Update the checklist", "other", "completed", {
    _meta: { claudeCode: { toolName: "TodoWrite" } },
    rawInput: {
      todos: [
        { content: "Read the transcript components", activeForm: "Reading the transcript components", status: a },
        { content: "Redesign the step rows", activeForm: "Redesigning the step rows", status: b },
        { content: "Write the docs page", activeForm: "Writing the docs page", status: c },
      ],
    },
  });
  return [
    // A checklist beats its `other` kind — and it is the most repeated call in
    // a long thread, so it gets two updates, which is what a reader sees.
    todos("in_progress", "pending", "pending"),
    todos("completed", "in_progress", "pending"),

    // A search of the WEB, not of the repo: the harness's own MCP server, whose
    // numbered blocks carry the snippet under each link.
    tool("o2", "mcp__web-search__web_search", "fetch", "completed", {
      rawInput: { query: "container queries panel layout", allowed_domains: ["developer.mozilla.org", "web.dev"] },
      content: text([
        "1. Using container queries",
        "https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_containment/Container_queries",
        "Container queries let a component ask about the size of its own container rather than the viewport.",
        "2. Say hello to CSS container queries",
        "https://web.dev/cq-stable/",
        "The `@container` rule ships in every evergreen browser; `inline-size` is the containment you almost always want.",
        "",
        "Both agree that `inline-size` is the containment to declare for a panel.",
      ].join("\n")),
    }),
    // A page read off the web, answering a question rather than returning the page.
    tool("o3", "https://web.dev/cq-stable/", "fetch", "completed", {
      _meta: { claudeCode: { toolName: "WebFetch" } },
      rawInput: { url: "https://web.dev/cq-stable/", prompt: "Which containment value does a panel want?" },
      content: text("The page recommends `container-type: inline-size` for layout that reacts to its own width.\n\n> Height containment forces a size, which is almost never what a panel wants."),
    }),

    // An MCP call in both forms runtimes send it in: Claude Code/OpenCode
    // flatten the server into the name, Codex keeps them apart and files the
    // whole thing under `execute`.
    tool("o4", "mcp__linear__create_issue", "other", "completed", {
      rawInput: { team: "Harness", title: "Rail geometry drifts on wrap", labels: ["ui", "transcript"] },
      rawOutput: { id: "HAR-412", url: "https://linear.app/harness/issue/HAR-412" },
    }),
    tool("o5", "mcp.notion.append_block", "execute", "failed", {
      rawInput: { server: "notion", tool: "append_block", arguments: { page: "Design log", text: "Rail geometry" } },
      rawOutput: { error: { code: 401, message: "token expired — reauthorize the server" } },
    }),

    // Codex's shell: the content block is a HANDLE, and the bytes arrive
    // through `_meta` deltas afterwards, so the whole run has to be
    // accumulated onto the item rather than read off `content`.
    tool("o6", "pnpm build", "execute", "in_progress", {
      content: [{ type: "terminal", terminalId: "term-1" }],
    }),
    { sessionUpdate: "tool_call_update", toolCallId: "o6", _meta: { terminal_output_delta: { data: "vite v7.1.0 building for production...\n" } } },
    { sessionUpdate: "tool_call_update", toolCallId: "o6", _meta: { terminal_output_delta: { data: "transforming (412) src/lib/store.tsx\n✓ 1204 modules transformed.\n" } } },
    { sessionUpdate: "tool_call_update", toolCallId: "o6", status: "completed", _meta: { terminal_exit: { exit_code: 0 } } },

    // A packaged workflow the agent pulled in, and a review's results — a
    // table, not prose.
    tool("o7", "Skill", "other", "completed", {
      _meta: { claudeCode: { toolName: "Skill" } },
      rawInput: { skill: "artifact-design", args: "--effort high" },
    }),
    tool("o8", "ReportFindings", "other", "completed", {
      _meta: { claudeCode: { toolName: "ReportFindings" } },
      rawInput: {
        findings: [
          { file: "server/src/queue.ts", line: 118, category: "correctness", verdict: "CONFIRMED", severity: "high", short_summary: "Drain runs after a cancelled turn", summary: "A queue drain follows a turn that ended in `cancelled`, so a stopped thread sends the next prompt anyway." },
          { file: "client/src/lib/store.tsx", line: 767, category: "simplification", verdict: "PLAUSIBLE", short_summary: "workflow meta re-read per spawn", summary: "`workflowInfoOf` runs on every restated spawn where the existing value would do." },
        ],
      },
    }),
    // The plan an agent asks permission to run — markdown, and the whole point
    // of the call. (The *live* approval is `plan:`, a permission request.)
    tool("o9", "ExitPlanMode", "switch_mode", "completed", {
      _meta: { claudeCode: { toolName: "ExitPlanMode" } },
      rawInput: {
        plan: [
          "## Rail geometry",
          "",
          "1. Pin the node centre to the row's own line box.",
          "2. Demote `kind` to a right-hand column.",
          "3. Regenerate the themes (`pnpm themes`) so the radius steps stay multiples.",
        ].join("\n"),
      },
    }),

    // A tool nobody has taught the client about, with no `kind` worth the
    // name: the generic layout, which is the one every new runtime lands in.
    tool("o10", "sync_design_tokens", "other", "completed", {
      rawInput: { source: "figma://file/abc", dry_run: true },
      rawOutput: { changed: 3, skipped: 41, tokens: ["--radius", "--radius-pill", "--tracking-tight"] },
    }),

    /* The end of a background task, injected as a synthetic USER turn — nobody
       typed it, and left alone it is a bubble full of XML. */
    { sessionUpdate: "user_message_chunk", content: { type: "text", text: [
      "<task-notification>",
      "<task-id>wf_2f1c</task-id>",
      "<status>completed</status>",
      "<summary>Reviewed 12 changed files across four dimensions.</summary>",
      "<result>null</result>",
      "<failures>",
      "[audit:server] failed: timed out after 600s",
      "</failures>",
      "<usage><agent_count>4</agent_count><agents_done>3</agents_done><agents_error>1</agents_error><subagent_tokens>48200</subagent_tokens><tool_uses>37</tool_uses><duration_ms>184000</duration_ms></usage>",
      "<diagnostics>journal at /tmp/daedalus-tasks/wf_2f1c/journal.jsonl</diagnostics>",
      "</task-notification>",
    ].join("\n") } },
  ];
}

/* ── Scenes ──
   One name per surface, so `scene:<name>` drives the one being worked on
   without the other forty rows above it.

   An ordinary prompt streams `default` — the step rows and the subagents —
   and NOT the whole catalogue, deliberately: a turn is the unit the replay
   window is measured in (`REPLAY_WINDOW_BYTES`), so a fake turn heavy enough
   to blow that budget changes what every windowing test is testing. The rest
   are asked for by name; `all` is everything. */
const SCENES = {
  steps: stepUpdates,
  subagents: subagentUpdates,
  workflow: workflowUpdates,
  questions: questionUpdates,
  other: otherUpdates,
  default: () => [...stepUpdates(), ...subagentUpdates()],
  all: () => [
    ...stepUpdates(),
    ...subagentUpdates(),
    ...questionUpdates(),
    ...otherUpdates(),
    ...workflowUpdates(),
  ],
};

const promptUpdates = () => SCENES.default();

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    clientCapabilities = msg.params?.clientCapabilities ?? {};
    out({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: 1,
        /* `promptCapabilities` is what the attachment decision reads: this
           agent can carry an image and an embedded text resource, and cannot
           carry audio — which is exactly the spread `attachments:` below needs
           to report all four branches. */
        agentCapabilities: {
          loadSession: true,
          /* `session/fork`, with the jetbrains.air fork point (`_meta`), is
             what a rewind's conversation half is built on — see
             `AcpBridge.forkAt`. The fork handler below answers a derived id
             that `session/load` accepts. */
          sessionCapabilities: { fork: {} },
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          /* The harness's pause pair (the daedalus agent's): answered below
             with a flag and nothing else — a parked turn here is parked on a
             question, not on a step, so the flag is all the bridge test needs. */
          _meta: { "daedalus/pause": true },
        },
      },
    });
  }
  else if (msg.method === "session/new") {
    recordSessionMeta("session/new", msg.params);
    out({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessionId: "acp-123",
        modes: {
          currentModeId: "default",
          availableModes: [
            { id: "default", name: "Always ask" },
            { id: "acceptEdits", name: "Accept edits" },
            { id: "bypassPermissions", name: "Bypass" },
          ],
        },
        configOptions,
      },
    });
  }
  else if (msg.method === "session/load") {
    recordSessionMeta("session/load", msg.params);
    const sid = msg.params?.sessionId;
    /* A fork answers a derived id (`session/fork` below); it loads as a short
       stub conversation, observably different from the original so a test can
       tell a rewound thread from an untouched one. */
    const forked = typeof sid === "string" && sid.startsWith("acp-123-fork-");
    /* A session this agent has no record of. Real agents answer exactly like
       this — codex says "no rollout found for thread id …" — and it is the
       failure that used to cost a thread its history, because the client's
       fallback `session/new` overwrote the id it had just failed to load. */
    if (sid !== "acp-123" && !forked) {
      out({
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: -32603,
          message: "Internal error",
          data: { details: `no rollout found for thread id ${sid}` },
        },
      });
      return;
    }
    // Replay a tiny conversation, then answer — mirrors ACP loadSession.
    out({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: sid, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: forked ? "(forked conversation)" : "hello fake agent" } } },
    });
    out({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: forked ? "(forked reply)" : "hi" } } },
    });
    // The RFD's replay: the child tree comes back inside the parent's load, in
    // its original order and under its original ids, with an orphan (no
    // terminal update on record) closed as `disconnected`.
    if (clientCapabilities.subagents) {
      const send = (sessionId, update) =>
        out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
      send("acp-123", { sessionUpdate: "subagent_spawned", subagentSessionId: "sub-0", name: "explorer", task: "Earlier delegated work", capabilities: {} });
      send("sub-0", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "(replayed child prose)" } });
      send("acp-123", { sessionUpdate: "subagent_state_update", subagentSessionId: "sub-0", state: "disconnected" });
    }
    out({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Always ask" }, { id: "acceptEdits", name: "Accept edits" }] },
        configOptions,
      },
    });
  } else if (msg.method === "session/fork") {
    recordSessionMeta("session/fork", msg.params);
    /* The id says where it was cut, deterministically, so a test can assert
       the fork landed. A request with no readable fork point still answers —
       a numbered fork rather than an error — because the spec's response is
       only ever a session id, and a malformed `_meta` is the caller's mistake
       to notice, not the stub's to crash on. */
    const point = msg.params?._meta?.jetbrains?.air?.fork?.messageId;
    const sessionId = typeof point === "string" && point.trim()
      ? `acp-123-fork-${point}`
      : `acp-123-fork-unpointed-${(forkCounter += 1)}`;
    out({ jsonrpc: "2.0", id: msg.id, result: { sessionId } });
  } else if (msg.method === "session/set_config_option") {
    configOptions = configOptions.map((o) =>
      o.id === msg.params.configId ? { ...o, currentValue: msg.params.value } : o
    );
    out({ jsonrpc: "2.0", id: msg.id, result: { configOptions } });
  } else if (msg.method === "session/prompt") {
    const asked = (msg.params.prompt ?? []).map((b) => b.text ?? "").join(" ");
    /* A prompt starting with "echo:" streams the remainder back as one message
       chunk and ends the turn — a deterministic answer, which is what the
       workflow test needs to check template rendering and JSON output. Checked
       first so an echoed text may mention any of the keywords below. */
    /* `attachments:` reports the block kinds it received, one per line, so a
       test can assert what the bridge decided without reading the agent's
       stdin itself. Checked before `echo:` so the two never collide. */
    if (asked.startsWith("attachments:")) {
      const kinds = (msg.params.prompt ?? [])
        .map((block) => (block.type === "text" ? null : block.type))
        .filter(Boolean)
        .join(",");
      out({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "acp-123",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `blocks:${kinds}` },
          },
        },
      });
      out({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn", usage: { totalTokens: 5 } } });
      return;
    }
    if (asked.startsWith("echo:")) {
      const text = asked.slice("echo:".length);
      out({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "acp-123",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        },
      });
      out({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn", usage: { totalTokens: 5 } } });
      return;
    }
    /* `scene:<name>` streams one scene and ends the turn — the whole point of
       the table: a surface gets iterated on without the other twenty rows
       above it. A bare `scene:` (or a name nobody registered) answers with the
       list rather than with silence. */
    if (asked.startsWith("scene:")) {
      const name = asked.slice("scene:".length).trim().split(/\s/)[0];
      const scene = SCENES[name];
      const send = (update) =>
        out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "acp-123", update } });
      if (!scene) {
        send({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `Scenes: ${Object.keys(SCENES).join(", ")}.\n\nAsk for one as \`scene:<name>\`.` },
        });
      } else {
        for (const entry of scene()) {
          const { sessionId, update } = "update" in entry ? entry : { sessionId: "acp-123", update: entry };
          out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
        }
      }
      out({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn", usage: { totalTokens: 12 } } });
      return;
    }
    /* `ask:` is the LIVE question — an AskUserQuestion as its bridges send one,
       which is an elicitation and not a permission request: titled options with
       descriptions and a preview, an "Other" box marked as the companion of the
       select it belongs to, a multi-select and a boolean. The answer is then
       said back as the settled `AskUserQuestion` tool call, because the record
       the transcript keeps is a different view from the form. */
    if (asked.startsWith("ask:")) {
      const elicitId = `ask-${++permCounter}`;
      const question = asked.slice("ask:".length).trim() || "Which way should the composer go?";
      const layout = [
        { const: "stacked", title: "Stacked (Recommended)", description: "Attachments above the input, send on its own row.", _meta: { "_claude/askUserQuestionOption": { preview: "┌──────────────┐\n│ ▣ ▣ ▣        │\n│ type here…   │\n│         [↵]  │\n└──────────────┘" } } },
        { const: "inline", title: "Inline", description: "One row: attachments, input and send together.", _meta: { "_claude/askUserQuestionOption": { preview: "┌──────────────┐\n│ ▣ type… [↵]  │\n└──────────────┘" } } },
      ];
      park(elicitId, msg.id, (answer) => {
        const content = answer?.content ?? {};
        /* The record is keyed by what the reader SAW: the form answers with an
           option's `const`, and a row that lists "Stacked (Recommended)" and
           reports "stacked" is quoting a different vocabulary back. Free text
           (the "Other" box) matches nothing and stays verbatim, which is what
           marks it as the typed answer. */
        const picked =
          layout.find((o) => o.const === content.layout)?.title ?? content.layout_other ?? content.layout;
        return [
          tool(`t-${elicitId}`, "Ask the user", "think", "completed", {
            _meta: { claudeCode: { toolName: "AskUserQuestion" } },
            rawInput: {
              questions: [{
                question,
                header: "Composer",
                multiSelect: false,
                options: layout.map((o) => ({ label: o.title, description: o.description })),
              }],
            },
            rawOutput: { answers: { [question]: picked ?? "(declined)" } },
          }),
        ];
      });
      out({
        jsonrpc: "2.0",
        id: elicitId,
        method: "elicitation/create",
        params: {
          sessionId: "acp-123",
          toolCallId: `t-${elicitId}`,
          mode: "form",
          message: question,
          requestedSchema: {
            type: "object",
            properties: {
              layout: { type: "string", title: "Composer layout", description: "How the attachments sit against the input.", oneOf: layout },
              /* Deliberately unnamespaced, and pointing at the field above:
                 the pair renders as ONE question with a type-your-own box. */
              layout_other: { type: "string", title: "Other", _meta: { _askUserQuestionCustomAnswer: { isCustomAnswer: true, questionId: "layout" } } },
              surfaces: {
                type: "array",
                title: "Which surfaces show the badge?",
                items: { anyOf: [
                  { const: "composer", title: "Composer" },
                  { const: "header", title: "Thread header" },
                  { const: "sidebar", title: "Sidebar row" },
                ] },
              },
              every_thread: { type: "boolean", title: "Apply to every thread?", default: false },
            },
            required: ["layout"],
          },
        },
      });
      return;
    }
    /* `plan:` is a plan approval — a permission request whose tool call is a
       `switch_mode` carrying markdown, which is exactly how codex asks. Left
       generic it renders the plan as a JSON dump inside the approval card. */
    if (asked.startsWith("plan:")) {
      const permId = `perm-${++permCounter}`;
      park(permId, msg.id);
      out({
        jsonrpc: "2.0",
        id: permId,
        method: "session/request_permission",
        params: {
          sessionId: "acp-123",
          toolCall: {
            toolCallId: `t-${permId}`,
            title: "Implement this plan?",
            kind: "switch_mode",
            rawInput: {
              plan: [
                "## Rail geometry",
                "",
                "1. Pin the node centre to the row's own line box.",
                "2. Demote `kind` to a right-hand column.",
                "3. Regenerate the themes so the radius steps stay multiples of `--radius`.",
              ].join("\n"),
            },
          },
          options: [
            { optionId: "allow", name: "Yes, and auto-accept edits", kind: "allow_always" },
            { optionId: "allow-once", name: "Yes, and ask each time", kind: "allow_once" },
            { optionId: "reject", name: "No, keep planning", kind: "reject_once" },
          ],
        },
      });
      return;
    }
    /* `perm:<kind>` parks the turn on a permission request whose tool call
       carries that ACP kind, which is the field an autonomy policy is keyed on
       — so the per-kind split can be driven from the prompt. `perm:none` omits
       the kind entirely: an agent saying nothing must fall to `default` rather
       than to a guess. Checked before the plain "permission" branch below,
       which bridge.test.ts still drives and which must keep its exact shape. */
    if (asked.startsWith("perm:")) {
      const kind = asked.slice("perm:".length).split(/\s/)[0];
      const permId = `perm-${++permCounter}`;
      park(permId, msg.id);
      out({
        jsonrpc: "2.0",
        id: permId,
        method: "session/request_permission",
        params: {
          sessionId: "acp-123",
          toolCall: {
            toolCallId: `t-${permId}`,
            title: `tool of kind ${kind}`,
            ...(kind === "none" ? {} : { kind }),
          },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "allow-all", name: "Allow every time", kind: "allow_always" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        },
      });
      return;
    }
    /* A permission request offering nothing allow-shaped. The harness may only
       ever select an option the agent itself advertised, so an `allow` stance
       has nothing to send and has to fall through to a real park — this is what
       proves it does rather than inventing an optionId. */
    if (asked.startsWith("perm-noallow")) {
      const permId = `perm-${++permCounter}`;
      park(permId, msg.id);
      out({
        jsonrpc: "2.0",
        id: permId,
        method: "session/request_permission",
        params: {
          sessionId: "acp-123",
          toolCall: { toolCallId: `t-${permId}`, title: "rm -rf /", kind: "execute" },
          options: [{ optionId: "reject", name: "Reject", kind: "reject_once" }],
        },
      });
      return;
    }
    /* `elicit:` asks the user a form question and parks the turn on the answer,
       the same way a permission does — the two are one code path in the bridge
       and an autonomy policy answers both, so both need a live sample. */
    if (asked.startsWith("elicit:")) {
      const elicitId = `elicit-${++permCounter}`;
      park(elicitId, msg.id);
      out({
        jsonrpc: "2.0",
        id: elicitId,
        method: "elicitation/create",
        params: {
          sessionId: "acp-123",
          toolCallId: `t-${elicitId}`,
          mode: "form",
          message: asked.slice("elicit:".length) || "Which way?",
          requestedSchema: {
            type: "object",
            properties: { choice: { type: "string", title: "Choice" } },
          },
        },
      });
      return;
    }
    // A prompt mentioning "permission" parks the turn on a permission request,
    // so both the UI and the multi-peer arbitration have something to exercise.
    if (asked.includes("permission")) {
      const permId = `perm-${++permCounter}`;
      park(permId, msg.id);
      out({
        jsonrpc: "2.0",
        id: permId,
        method: "session/request_permission",
        params: {
          sessionId: "acp-123",
          toolCall: { toolCallId: `t-${permId}`, title: "rm -rf ./build", kind: "execute" },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        },
      });
      return;
    }
    // A prompt mentioning "fail" answers with a bare JSON-RPC internal error
    // after printing a stack to stderr — exactly the shape that used to reach
    // the UI as an unexplained "RequestError: Internal error". The server
    // splices the stderr into the error's `data`, and the client renders it.
    if (asked.includes("fail")) {
      process.stderr.write("Error: the model provider returned 529\n    at Agent.prompt (agent.js:42:11)\n");
      // Give the stderr pipe a tick to land before the answer overtakes it.
      setTimeout(() => {
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Internal error" } });
      }, 20);
      return;
    }
    // A prompt mentioning "crash" kills the agent mid-turn: nothing ever
    // answers, which is what failPendingRequests exists to clean up.
    if (asked.includes("crash")) {
      process.stderr.write("Fatal: agent died holding the turn\n");
      setTimeout(() => process.exit(3), 20);
      return;
    }
    /* A prompt mentioning "compact" runs a context compaction: the in_progress
       upsert, the summary streamed as chunks, then a terminal update carrying
       neither `summary` nor `error` — the shape that proves the client patches
       instead of replacing, since treating the omission as empty would wipe the
       summary it just streamed. Silent when the client never claimed the
       capability, exactly as the spec requires. */
    if (asked.includes("compact")) {
      if (clientCapabilities.session?.compaction) {
        const send = (update) =>
          out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "acp-123", update } });
        send({ sessionUpdate: "compaction_update", compactionId: "c1", status: "in_progress" });
        for (const line of ["Rewrote the transcript step rows.", "Left the rail geometry alone."]) {
          send({
            sessionUpdate: "compaction_summary_chunk",
            compactionId: "c1",
            content: { type: "text", text: line },
          });
        }
        send({ sessionUpdate: "compaction_update", compactionId: "c1", status: "completed" });
      }
      out({
        jsonrpc: "2.0",
        id: msg.id,
        result: { stopReason: "end_turn", usage: { totalTokens: 40 } },
      });
      return;
    }
    // One of every step kind, in order — this is what the transcript UI is
    // developed against, so every branch of the step row has a live sample.
    const turnMessageId = `msg-${(turnCounter += 1)}`;
    for (const entry of promptUpdates()) {
      const { sessionId, update } = "update" in entry ? entry : { sessionId: "acp-123", update: entry };
      /* Every assistant chunk of the turn shares one messageId — the ACP
         contract, and the fork point a rewind to the NEXT turn cuts at. */
      const stamped = sessionId === "acp-123" && update.sessionUpdate === "agent_message_chunk"
        ? { ...update, messageId: turnMessageId }
        : update;
      out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: stamped } });
    }
    out({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "acp-123", update: { sessionUpdate: "usage_update", used: 12_000, size: 200_000 } },
    });
    out({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        stopReason: "end_turn",
        usage: { totalTokens: 10_500, inputTokens: 1000, outputTokens: 500, cachedReadTokens: 9000 },
      },
    });
  } else if (msg.method === "_daedalus/session/pause" || msg.method === "_daedalus/session/resume") {
    paused = msg.method.endsWith("pause");
    out({ jsonrpc: "2.0", id: msg.id, result: { paused, turnActive: parkedTurns.size > 0 } });
  } else if (msg.method === "session/cancel") {
    paused = false;
    /* A cancel is a notification, and the spec's answer to it is a SUCCESS:
       every prompt still open is answered with `stopReason: "cancelled"`. Only
       a parked turn can be open here — an ordinary prompt answers itself in
       the same tick — so those are the ones released. */
    for (const { promptId } of parkedTurns.values()) {
      out({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled", usage: { totalTokens: 1 } } });
    }
    parkedTurns.clear();
  } else if (msg.method === undefined && parkedTurns.has(msg.id)) {
    /* The answer to a permission or an elicitation — finish the turn it was
       blocking, and say what the answer was, because for an auto-answered
       question that is the only place the selected option is visible from the
       agent's side. Spelled generically: an elicitation's answer carries an
       `action` where a permission's carries an `outcome`. */
    const { promptId, after } = parkedTurns.get(msg.id);
    parkedTurns.delete(msg.id);
    // The record of the answer, when the question wanted one — sent BEFORE the
    // prose, because the tool call is what the reader looks back at and the
    // sentence is a footnote under it.
    for (const update of after?.(msg.result ?? msg.error) ?? []) {
      out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "acp-123", update } });
    }
    out({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "acp-123",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `answered: ${JSON.stringify(msg.result ?? msg.error)}` } },
      },
    });
    out({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn", usage: { totalTokens: 10 } } });
  } else if (msg.method === undefined) {
    // A response to something we asked and no longer wait on (a permission
    // answered after the cancel released its turn). Nothing to say back —
    // echoing a response as a response would be a frame the SDK never asked for.
  } else if (msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, result: {} });
});
