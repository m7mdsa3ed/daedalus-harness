import { tool } from "ai";
import { z } from "zod";
import type * as acp from "@agentclientprotocol/sdk";
import type { ToolMeta, ToolRuntime } from "./context.js";

export const askUserMeta: ToolMeta = {
  kind: "other",
  title: () => "Ask the user",
};

/* AskUserQuestion rides ACP's elicitation: a form-mode request whose
   requestedSchema is a JSON Schema of primitive properties. Options become a
   titled oneOf enum (what the harness's stepper renders as choices); a
   question without options is a free-text field. `decline` means the user
   skipped — a real answer, the turn continues. */
export function makeAskUserTool(rt: ToolRuntime) {
  return tool({
    description:
      "Ask the user one or more questions when you are blocked on a decision that is genuinely theirs to make. Prefer acting on sensible defaults over asking.",
    inputSchema: z.object({
      questions: z
        .array(
          z.object({
            question: z.string().describe("The full question to ask"),
            options: z
              .array(z.object({ label: z.string(), description: z.string().optional() }))
              .optional()
              .describe("Choices to offer; omit for free-text"),
          }),
        )
        .min(1)
        .max(4),
    }),
    execute: async ({ questions }) => {
      const properties: Record<string, unknown> = {};
      questions.forEach((q, i) => {
        const key = `q${i + 1}`;
        properties[key] = q.options?.length
          ? {
              type: "string",
              title: q.question,
              oneOf: q.options.map((o) => ({
                const: o.label,
                title: o.label,
                ...(o.description ? { description: o.description } : {}),
              })),
            }
          : { type: "string", title: q.question };
      });
      const response = await rt.ctx.request("elicitation/create", {
        sessionId: rt.session.id,
        mode: "form",
        message: questions.length === 1 ? (questions[0] as { question: string }).question : "The agent has questions",
        requestedSchema: { type: "object", properties } as never,
      } as acp.CreateElicitationRequest);
      if (response.action === "decline") return "The user skipped the question.";
      if (response.action !== "accept") throw new Error("The user cancelled the question.");
      const content = (response as { content?: Record<string, unknown> }).content ?? {};
      const answers = questions.map((q, i) => `${q.question}\n→ ${String(content[`q${i + 1}`] ?? "(no answer)")}`);
      return answers.join("\n\n");
    },
  });
}
