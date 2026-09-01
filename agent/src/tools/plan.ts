import { tool } from "ai";
import { z } from "zod";
import type { ToolMeta, ToolRuntime } from "./context.js";

export const planMeta: ToolMeta = {
  kind: "think",
  title: () => "Update the todo list",
};

export function makePlanTool(rt: ToolRuntime) {
  return tool({
    description:
      "Write the current todo list for this task. Replaces the whole list; keep exactly one item in_progress while working.",
    inputSchema: z.object({
      todos: z
        .array(
          z.object({
            content: z.string().describe("The todo, in imperative form"),
            status: z.enum(["pending", "in_progress", "completed"]),
            priority: z.enum(["high", "medium", "low"]).optional(),
          }),
        )
        .min(1),
    }),
    execute: async ({ todos }) => {
      await rt.emit.update({
        sessionUpdate: "plan",
        entries: todos.map((t) => ({
          content: t.content,
          status: t.status,
          priority: t.priority ?? "medium",
        })),
      });
      return "Todo list updated.";
    },
  });
}
