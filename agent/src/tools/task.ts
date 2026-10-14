import { tool } from "ai";
import { z } from "zod";
import type { ToolMeta, ToolRuntime } from "./context.js";
import { inputOf } from "./context.js";

export const taskMeta: ToolMeta = {
  kind: "other",
  title: (input) => `Subagent: ${String(inputOf(input).description ?? "task")}`,
  announcesOwnSession: true,
};

const TASK_DESCRIPTION =
  "Launch a subagent to handle a self-contained multi-step task. It works in the same directory with the same tools (minus this one) and returns a final report — give it a complete brief, it cannot ask follow-ups.";

/* The roles clause is generated from the table so it cannot drift from what
   `resolveModel` actually accepts. A role with no description prints its label
   alone; with no roles at all there is no clause, because a capability not
   advertised is one the model does not use. */
function rolesClause(rt: ToolRuntime): string {
  const roles = rt.env.modelRoles;
  if (roles.length === 0) return "";
  const list = roles
    .map((r) => (r.description ? `\`${r.id}\` (${r.label} — ${r.description})` : `\`${r.id}\` (${r.label})`))
    .join(", ");
  return ` Run it on a named role instead of the session model: ${list}. Pass an exact \`model\` to override the role; with neither it runs on the session model.`;
}

/* `model` wins outright — the escape hatch, passed through as written. Else
   `role` is matched against an id, then case-insensitively against a label, and
   the role's env model is used. A role naming nothing is an *answer* (a string
   error the model can act on), never a throw, and never a crash. */
function resolveModel(
  rt: ToolRuntime,
  model?: string,
  role?: string,
): { modelId?: string; roleId?: string } | { error: string } {
  if (model) return { modelId: model };
  if (role) {
    const roles = rt.env.modelRoles;
    const wanted = role.toLowerCase();
    const found =
      roles.find((r) => r.id === role) ?? roles.find((r) => r.label.toLowerCase() === wanted);
    if (!found) {
      const known = roles.map((r) => r.id);
      const ids = known.length ? known.join(", ") : "(none)";
      return { error: `Unknown role '${role}'. Known roles: ${ids}.` };
    }
    /* An unassigned role ships `""` — the session model, made explicit. */
    return { modelId: found.model || undefined, roleId: found.id };
  }
  return {};
}

export function makeTaskTool(rt: ToolRuntime) {
  return tool({
    description: TASK_DESCRIPTION + rolesClause(rt),
    inputSchema: z.object({
      description: z.string().describe("A short (3-5 word) description of the task"),
      prompt: z.string().describe("The full task brief for the subagent"),
      role: z
        .string()
        .optional()
        .describe("Role to run the subagent on (see the roles listed in this tool's description)."),
      model: z.string().optional().describe("Exact model id to run the subagent on; overrides role."),
    }),
    execute: async ({ description, prompt, role, model }, options) => {
      const resolved = resolveModel(rt, model, role);
      if ("error" in resolved) return resolved.error;
      return rt.runSubagent(description, prompt, options.toolCallId, resolved.modelId, resolved.roleId);
    },
  });
}
