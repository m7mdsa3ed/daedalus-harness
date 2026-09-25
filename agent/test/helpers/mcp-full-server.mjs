/* MCP stdio server exercising every client-facing feature the agent speaks:
   instructions, media and structured results, resource links, templates,
   elicitation, sampling, roots, progress and a tool list that changes.
   Low-level Server, plain JSON schemas — see mcp-echo-server.mjs for why. */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const server = new Server(
  { name: "full", version: "0.0.1" },
  {
    capabilities: { tools: { listChanged: true }, prompts: {}, resources: {}, logging: {}, completions: {} },
    instructions: "Call pic before describing anything.",
  },
);

let grown = false;
const obj = { type: "object", properties: {} };
const tools = () => [
  { name: "pic", inputSchema: obj },
  { name: "struct", inputSchema: obj },
  { name: "link", inputSchema: obj },
  { name: "ask", inputSchema: obj },
  { name: "sample", inputSchema: obj },
  { name: "roots", inputSchema: obj },
  { name: "slow", inputSchema: obj },
  { name: "grow", inputSchema: obj },
  ...(grown ? [{ name: "grown", inputSchema: obj }] : []),
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools() }));

server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const text = (t) => ({ content: [{ type: "text", text: t }] });
  switch (req.params.name) {
    case "pic":
      return { content: [{ type: "text", text: "a dot" }, { type: "image", data: PNG, mimeType: "image/png" }] };
    case "struct":
      return { content: [], structuredContent: { answer: 42 } };
    case "link":
      return { content: [{ type: "resource_link", uri: "mem://a", name: "A" }] };
    case "ask": {
      const r = await server.elicitInput({
        message: "name?",
        requestedSchema: { type: "object", properties: { name: { type: "string" } } },
      });
      return text(`${r.action}:${r.content?.name ?? ""}`);
    }
    case "sample": {
      const r = await server.createMessage({
        messages: [{ role: "user", content: { type: "text", text: "hi" } }],
        maxTokens: 10,
      });
      return text(`sampled:${r.content.text}`);
    }
    case "roots": {
      const r = await server.listRoots();
      return text(r.roots.map((x) => x.uri).join(","));
    }
    case "slow": {
      const token = req.params._meta?.progressToken;
      if (token !== undefined) {
        await extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken: token, progress: 1, total: 2, message: "halfway" },
        });
      }
      return text("done");
    }
    case "grow":
      grown = true;
      await server.sendToolListChanged();
      return text("grew");
    case "grown":
      return text("i am new");
  }
  throw new Error(`unknown tool ${req.params.name}`);
});

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [{ name: "greet", arguments: [{ name: "who", required: true }] }],
}));
server.setRequestHandler(GetPromptRequestSchema, async (req) => ({
  messages: [{ role: "user", content: { type: "text", text: `hello ${req.params.arguments?.who}` } }],
}));
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [{ uri: "mem://a", name: "A" }],
}));
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: [{ uriTemplate: "mem://{key}", name: "any key" }],
}));
server.setRequestHandler(ReadResourceRequestSchema, async (req) => ({
  contents:
    req.params.uri === "mem://img"
      ? [{ uri: req.params.uri, mimeType: "image/png", blob: PNG }]
      : [{ uri: req.params.uri, text: `contents of ${req.params.uri}` }],
}));

server.setRequestHandler(CompleteRequestSchema, async (req) => ({
  completion: { values: ["ada", "alan", "grace"].filter((v) => v.startsWith(req.params.argument.value)) },
}));

await server.connect(new StdioServerTransport());
