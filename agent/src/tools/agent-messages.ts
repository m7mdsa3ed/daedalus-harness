import { tool } from "ai";
import { z } from "zod";
import type { ToolRuntime } from "./context.js";

export function makeAgentMessageTools(rt: ToolRuntime) {
  return {
    list_agents: tool({
      description:
        "List subagents delegated from this session, including their stable IDs and whether they are running, completed, stopped, or failed. Use the ID with send_message to continue one.",
      inputSchema: z.object({}),
      execute: async () => rt.listSubagents(),
    }),
    send_message: tool({
      description:
        "Send a follow-up message to a subagent by ID or name. A stopped or failed subagent resumes from its saved conversation, with this message as its next prompt. A running subagent cannot receive a message until it finishes or is stopped.",
      inputSchema: z.object({
        agent: z.string().describe("Subagent ID or name from list_agents"),
        message: z.string().describe("The follow-up message for the subagent"),
      }),
      execute: async ({ agent, message }) => rt.sendMessage(agent, message),
    }),
  };
}
