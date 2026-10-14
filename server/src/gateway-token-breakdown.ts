import { countTokens } from "gpt-tokenizer";

export interface GatewayPromptBreakdown {
  source: "gateway";
  total: number;
  system: number;
  tools: number;
  mcp: number;
  conversation: number;
  user: number;
  assistant: number;
  results: number;
  overhead: number;
  items: {
    system: { name: string; tokens: number }[];
    tools: { name: string; tokens: number }[];
    mcp: { name: string; tokens: number }[];
  };
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : null;

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    const item = record(part);
    if (!item) return "";
    if (typeof item.text === "string") return item.text;
    if (item.type === "tool_use") return JSON.stringify(item.input ?? {});
    if (item.type === "function_call") return JSON.stringify(item.arguments ?? {});
    if (item.type === "function_call_output") return textOf(item.output);
    if (item.type === "tool_result") return textOf(item.content ?? item.output);
    return "";
  }).join(" ");
}

function requestParts(body: Json): {
  system: string[];
  tools: Json[];
  messages: { user: number; assistant: number; results: number };
} {
  const system: string[] = [];
  const tools: Json[] = [];
  const messages = { user: 0, assistant: 0, results: 0 };
  const addMessage = (role: string, text: unknown) => {
    const tokens = countTokens(textOf(text));
    if (role === "user") messages.user += tokens;
    else if (role === "tool" || role === "function") messages.results += tokens;
    else messages.assistant += tokens;
  };

  if (typeof body.system === "string") system.push(body.system);
  else if (Array.isArray(body.system)) system.push(textOf(body.system));
  if (typeof body.instructions === "string") system.push(body.instructions);

  if (Array.isArray(body.messages)) {
    for (const raw of body.messages) {
      const message = record(raw);
      if (!message) continue;
      const role = typeof message.role === "string" ? message.role : "assistant";
      if (role === "system" || role === "developer") system.push(textOf(message.content));
      else addMessage(role, message.content ?? message);
    }
  }
  if (Array.isArray(body.input)) {
    for (const raw of body.input) {
      if (typeof raw === "string") {
        addMessage("user", raw);
        continue;
      }
      const item = record(raw);
      if (!item) continue;
      if (item.type === "message") {
        const role = typeof item.role === "string" ? item.role : "user";
        if (role === "system" || role === "developer") system.push(textOf(item.content));
        else addMessage(role, item.content);
      } else if (item.type === "function_call" || item.type === "computer_call") {
        addMessage("assistant", item.arguments ?? item);
      } else if (item.type === "function_call_output" || item.type === "computer_call_output") {
        addMessage("tool", item.output ?? item);
      } else if (item.type === "input_text" || item.type === "output_text") {
        addMessage("user", item.text);
      }
    }
  }
  if (Array.isArray(body.tools)) {
    for (const raw of body.tools) {
      const tool = record(raw);
      if (!tool) continue;
      if (tool.type === "function" && record(tool.function)) {
        tools.push({
          ...record(tool.function),
          name: record(tool.function)!.name ?? tool.name,
          type: "function",
        });
        continue;
      }
      if (tool.type === "namespace" && Array.isArray(tool.tools)) {
        for (const member of tool.tools) {
          const entry = record(member);
          if (entry) tools.push({ ...entry, name: `${String(tool.name ?? "")}.${String(entry.name ?? "")}` });
        }
      } else tools.push(tool);
    }
  }
  return { system, tools, messages };
}

function promptTotal(value: unknown): number | null {
  const root = record(value);
  if (!root) return null;
  const response = record(root.response) ?? root;
  const message = record(response.message) ?? response;
  const usage = record(response.usage) ?? record(message.usage) ?? record(root.usage);
  if (!usage) return null;
  if (usage.prompt_tokens !== undefined) {
    const total = Number(usage.prompt_tokens);
    if (!Number.isFinite(total) || total < 0) return null;
    const details = record(usage.prompt_tokens_details);
    return total + Number(details?.cache_creation_tokens ?? 0);
  }
  const input = Number(usage.input_tokens);
  if (!Number.isFinite(input) || input < 0) return null;
  return input + Number(usage.cache_read_input_tokens ?? 0) + Number(usage.cache_creation_input_tokens ?? 0);
}

/** Extract provider prompt counts from OpenAI, Anthropic, and Responses events. */
export function gatewayPromptTotal(value: unknown): number | null {
  const root = record(value);
  if (!root) return null;
  if (root.type === "message_start") return promptTotal(root.message);
  if (root.type === "response.completed" || root.type === "response.done") return promptTotal(root.response);
  return promptTotal(root);
}

/** Estimate request parts using the sent payload and provider's reported total. */
export function estimateGatewayPrompt(body: Json, total: number): GatewayPromptBreakdown {
  const input = requestParts(body);
  const systemItems = input.system.map((text, index) => ({
    name: index ? `System instructions ${index + 1}` : "System instructions",
    tokens: countTokens(text),
  }));
  const toolItems = input.tools.map((tool) => ({
    name: String(tool.name ?? tool.type ?? "Tool"),
    tokens: countTokens(JSON.stringify(tool)),
  }));
  const mcpItems = toolItems.filter((item) => /(^|[._])mcp__|^mcp__/.test(item.name.toLowerCase()));
  const builtins = toolItems.filter((item) => !mcpItems.includes(item));
  const rawSystem = systemItems.reduce((sum, item) => sum + item.tokens, 0);
  const rawTools = builtins.reduce((sum, item) => sum + item.tokens, 0);
  const rawMcp = mcpItems.reduce((sum, item) => sum + item.tokens, 0);
  const rawHistory = input.messages.user + input.messages.assistant + input.messages.results;
  const estimated = rawSystem + rawTools + rawMcp + rawHistory;
  const scale = estimated > total && estimated > 0 ? total / estimated : 1;
  const system = Math.round(rawSystem * scale);
  const mcp = Math.min(total - system, Math.round(rawMcp * scale));
  const tools = Math.min(total - system - mcp, Math.round(rawTools * scale));
  const afterPrefix = Math.max(0, total - system - tools - mcp);
  const conversation = Math.min(afterPrefix, Math.round(rawHistory * scale));
  const user = rawHistory ? Math.round(conversation * input.messages.user / rawHistory) : 0;
  const assistant = rawHistory
    ? Math.min(conversation - user, Math.round(conversation * input.messages.assistant / rawHistory))
    : 0;
  const results = conversation - user - assistant;
  const scaledItems = (items: { name: string; tokens: number }[]) =>
    items.map((item) => ({ ...item, tokens: Math.round(item.tokens * scale) }));
  return {
    source: "gateway",
    total,
    system,
    tools,
    mcp,
    conversation,
    user,
    assistant,
    results,
    overhead: Math.max(0, total - system - tools - mcp - conversation),
    items: { system: scaledItems(systemItems), tools: scaledItems(builtins), mcp: scaledItems(mcpItems) },
  };
}

const pending = new Map<string, GatewayPromptBreakdown[]>();

/** Store only token counts; request contents are never retained. */
export function recordGatewayPrompt(sessionId: string, body: Json, total: number): void {
  const rows = pending.get(sessionId) ?? [];
  rows.push(estimateGatewayPrompt(body, total));
  if (rows.length > 32) rows.splice(0, rows.length - 32);
  pending.set(sessionId, rows);
}

export function takeGatewayPrompt(sessionId: string, total: number): GatewayPromptBreakdown | undefined {
  const rows = pending.get(sessionId);
  const index = rows?.findIndex((row) => row.total === total) ?? -1;
  if (!rows || index < 0) return undefined;
  const [row] = rows.splice(index, 1);
  if (rows.length === 0) pending.delete(sessionId);
  return row;
}

export function clearGatewayPrompts(sessionId: string): void {
  pending.delete(sessionId);
}

/** Inspect SSE events while passing the original bytes through unchanged. */
export function tapGatewaySse(
  body: ReadableStream<Uint8Array>,
  onUsage: (total: number) => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let carry = "";
  let found: number | null = null;
  const inspect = (text: string, flush = false) => {
    carry += text;
    const lines = carry.split(/\r?\n/);
    const remainder = lines.pop() ?? "";
    carry = flush ? "" : remainder;
    if (flush && remainder) lines.push(remainder);
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        found = gatewayPromptTotal(JSON.parse(data)) ?? found;
      } catch {
        // Non-JSON SSE data is not a usage event.
      }
    }
  };
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      inspect(decoder.decode(chunk, { stream: true }));
      controller.enqueue(chunk);
    },
    flush() {
      inspect(decoder.decode(), true);
      if (found !== null) onUsage(found);
    },
  }));
}
