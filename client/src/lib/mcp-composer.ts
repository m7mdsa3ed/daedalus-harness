import type * as acp from "@daedalus/acp"
import { api, type McpCallResult, type McpCheckEntry, type ServerSettings, type ThreadMcpServer } from "@/lib/settings"

/* ── A thread's MCP servers, in the composer ──

   The harness reads its own MCP client for every runtime, so a thread's
   servers offer their prompts as `/server:prompt` and their resources in the
   `@` menu whether or not the agent's own client surfaces them.

   A prompt is named `server:prompt` — the name the Daedalus agent advertises
   its own copy under — so where the agent already offers it, its command wins
   the collision the way it does for every harness command, and the prompt is
   not offered twice. Picking one fills the composer with the rendered text
   rather than sending it: the words are the server's, and the person sees them
   before the agent does. */

/** The prompts every server offers, as `/` rows. */
export function mcpPromptCommands(servers: ThreadMcpServer[]): acp.AvailableCommand[] {
  return servers.flatMap((server) =>
    server.prompts.map((p) => ({
      name: `${server.name}:${p.name}`,
      description: p.description || `Prompt from ${server.name}`,
      ...(p.arguments?.length
        ? { input: { hint: p.arguments.map((a) => (a.required ? a.name : `${a.name}?`)).join(" ") } }
        : {}),
    })),
  )
}

/** Read a composed line as an MCP prompt: `/srv:greet who=ada` → the server,
    the prompt and its arguments — or null, including for a name the agent
    advertises itself. */
export function mcpPromptFor(
  text: string,
  servers: ThreadMcpServer[],
  agentCommands: acp.AvailableCommand[],
): { server: ThreadMcpServer; prompt: McpCheckEntry; args: Record<string, string> } | null {
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(text.trim())
  if (!m) return null
  const [, name, line] = m
  if (agentCommands.some((c) => c.name === name)) return null
  for (const server of servers) {
    const prefix = `${server.name}:`
    if (!name.startsWith(prefix)) continue
    const prompt = server.prompts.find((p) => p.name === name.slice(prefix.length))
    if (prompt) return { server, prompt, args: promptArgs(prompt.arguments ?? [], line) }
  }
  return null
}

/* The agent's reading of a slash line (agent/src/mcp.ts `promptArgs`), so a
   prompt answers the same whether the harness or the agent expands it:
   `key=value` tokens for named arguments, the rest to the first one unfilled. */
export function promptArgs(declared: { name: string; required?: boolean }[], line: string): Record<string, string> {
  const args: Record<string, string> = {}
  const names = new Set(declared.map((d) => d.name))
  const rest: string[] = []
  for (const token of line.split(/\s+/).filter(Boolean)) {
    const eq = token.indexOf("=")
    const key = eq > 0 ? token.slice(0, eq) : ""
    if (names.has(key)) args[key] = token.slice(eq + 1)
    else rest.push(token)
  }
  const first = declared.find((d) => d.required && !(d.name in args)) ?? declared.find((d) => !(d.name in args))
  if (first && rest.length) args[first.name] = rest.join(" ")
  return args
}

async function invoke(
  settings: ServerSettings,
  sessionId: string,
  serverId: string,
  body: { kind: "prompt" | "resource"; name: string; args?: Record<string, string> },
): Promise<unknown> {
  const answer = await api<McpCallResult>(settings, `/api/sessions/${sessionId}/mcp/${serverId}/invoke`, {
    method: "POST",
    body: JSON.stringify(body),
  })
  if (!answer.ok) throw new Error(answer.error ?? "the server did not answer")
  return answer.result
}

/** A prompt's messages as the text the composer is filled with. */
export async function renderMcpPrompt(
  settings: ServerSettings,
  sessionId: string,
  serverId: string,
  name: string,
  args: Record<string, string>,
): Promise<string> {
  const result = (await invoke(settings, sessionId, serverId, { kind: "prompt", name, args })) as {
    messages?: { content?: unknown }[]
  }
  return (result.messages ?? [])
    .map((m) => contentText(m.content))
    .filter(Boolean)
    .join("\n\n")
}

function contentText(content: unknown): string {
  if (!content || typeof content !== "object") return ""
  const c = content as { type?: string; text?: unknown; resource?: { text?: unknown; uri?: unknown } }
  if (typeof c.text === "string") return c.text
  if (c.type === "resource" && typeof c.resource?.text === "string") return c.resource.text
  if (c.type === "resource_link") return `@${String((c as { uri?: unknown }).uri ?? "")}`
  return ""
}

/**
 * One resource, read and handed back as a `File` — so it goes through the
 * attachment path every other file does: uploaded, chipped, and delivered by
 * `resolveDelivery` as an image, an embedded resource or a link, per runtime
 * and model. Nothing downstream learns that it came from MCP.
 */
export async function readMcpResourceFile(
  settings: ServerSettings,
  sessionId: string,
  serverId: string,
  uri: string,
  fallbackName: string,
): Promise<File> {
  const result = (await invoke(settings, sessionId, serverId, { kind: "resource", name: uri })) as {
    contents?: { uri?: string; mimeType?: string; text?: string; blob?: string }[]
  }
  const first = result.contents?.[0]
  if (!first) throw new Error(`${uri} is empty`)
  const name = fileNameOf(uri) || fallbackName
  if (typeof first.blob === "string") {
    const bytes = Uint8Array.from(atob(first.blob), (ch) => ch.charCodeAt(0))
    return new File([bytes], name, { type: first.mimeType ?? "application/octet-stream" })
  }
  /* A multi-part resource is one text file, parts in order. */
  const text = (result.contents ?? []).map((c) => c.text ?? "").join("\n")
  return new File([text], name, { type: first.mimeType ?? "text/plain" })
}

function fileNameOf(uri: string): string {
  const tail = uri.replace(/[?#].*$/, "").split("/").filter(Boolean).pop() ?? ""
  return decodeURIComponent(tail).replace(/[^\w.@-]+/g, "_").slice(0, 120)
}
