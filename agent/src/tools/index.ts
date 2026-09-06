import type { Tool, ToolSet } from "ai";
import type { ToolMeta, ToolRuntime } from "./context.js";
import { inputOf } from "./context.js";
import { checkPermission } from "../permissions.js";
import { makeReadTool, makeWriteTool, makeEditTool, readMeta, writeMeta, editMeta } from "./fs-tools.js";
import { makeBashTool, bashMeta } from "./bash.js";
import { makeGlobTool, makeGrepTool, globMeta, grepMeta } from "./search.js";
import { makeAskUserTool, askUserMeta } from "./ask-user.js";
import { makePlanTool, planMeta } from "./plan.js";
import { makeTaskTool, taskMeta } from "./task.js";

export type { ToolMeta, ToolRuntime } from "./context.js";

export interface BuiltTools {
  tools: ToolSet;
  meta: Record<string, ToolMeta>;
}

const MCP_META: ToolMeta = {
  kind: "other",
  title: () => "MCP tool",
};

export function metaFor(meta: Record<string, ToolMeta>, toolName: string): ToolMeta {
  const found = meta[toolName];
  if (found) return found;
  if (toolName.startsWith("mcp__")) {
    const leaf = toolName.split("__").pop() ?? toolName;
    return {
      kind: /fetch|http|url/.test(leaf) ? "fetch" : /search/.test(leaf) ? "search" : "other",
      title: () => toolName,
    };
  }
  return MCP_META;
}

export interface BuildToolsOptions {
  /** Plan mode strips everything that writes; a subagent loop strips `task`. */
  subagent?: boolean;
}

export function buildTools(rt: ToolRuntime, opts: BuildToolsOptions = {}): BuiltTools {
  const meta: Record<string, ToolMeta> = {
    read_file: readMeta,
    write_file: writeMeta,
    edit_file: editMeta,
    bash: bashMeta,
    glob: globMeta,
    grep: grepMeta,
    ask_user: askUserMeta,
    write_todos: planMeta,
    task: taskMeta,
  };

  const planOnly = rt.session.mode === "plan";
  const tools: Record<string, Tool> = {
    read_file: makeReadTool(rt),
    glob: makeGlobTool(rt),
    grep: makeGrepTool(rt),
    write_todos: makePlanTool(rt),
  };
  if (!planOnly) {
    tools.write_file = makeWriteTool(rt);
    tools.edit_file = makeEditTool(rt);
    tools.bash = makeBashTool(rt);
    for (const [name, t] of Object.entries(rt.session.mcp?.tools ?? {})) {
      tools[name] = withMcpGate(rt, name, t);
    }
  }
  /* A client that never claimed elicitation.form cannot answer the question,
     so the tool is not offered at all — same bargain claude-agent-acp makes. */
  if (rt.clientCaps?.elicitation?.form && !opts.subagent) {
    tools.ask_user = makeAskUserTool(rt);
  }
  if (!opts.subagent && !planOnly) {
    tools.task = makeTaskTool(rt);
  }
  return { tools, meta };
}

/* MCP tools are built at connect time, before any turn or context exists —
   the permission gate has to wrap here, where both are in hand. Same gate as
   the built-ins, under the "mcp" group, so sticky always-answers and the
   permission modes apply; plan mode is handled above by not offering them. */
function withMcpGate(rt: ToolRuntime, name: string, t: Tool): Tool {
  const m = metaFor({}, name);
  return {
    ...t,
    execute: async (input, options) => {
      await checkPermission(rt.ctx, rt.session, "mcp", {
        toolCallId: options.toolCallId,
        toolName: name,
        title: m.title(input),
        kind: m.kind,
        rawInput: inputOf(input),
      });
      return t.execute!(input, options);
    },
  };
}
