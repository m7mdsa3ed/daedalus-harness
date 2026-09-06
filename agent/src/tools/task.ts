import { tool } from "ai";
import { z } from "zod";
import type { ToolMeta, ToolRuntime } from "./context.js";
import { inputOf } from "./context.js";

export const taskMeta: ToolMeta = {
  kind: "other",
  title: (input) => `Subagent: ${String(inputOf(input).description ?? "task")}`,
};

export function makeTaskTool(rt: ToolRuntime) {
  return tool({
    description:
      "Launch a subagent to handle a self-contained multi-step task. It works in the same directory with the same tools (minus this one) and returns a final report — give it a complete brief, it cannot ask follow-ups.",
    inputSchema: z.object({
      description: z.string().describe("A short (3-5 word) description of the task"),
      prompt: z.string().describe("The full task brief for the subagent"),
    }),
    execute: async ({ description, prompt }) => rt.runSubagent(description, prompt),
  });
}
