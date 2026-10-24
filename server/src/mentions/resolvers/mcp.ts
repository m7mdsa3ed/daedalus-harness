/* Resolver for `@mcp:<serverId>/<uri>`: a resource one of the thread's MCP
   servers serves, read through the harness's own client and inlined — so a
   GitHub PR, a Bugsnag error or a ClickUp task reaches every runtime the same
   way, not only the ones whose MCP client surfaces resources. The server id is
   the library row's; the uri is whatever follows the first `/` (a fixed
   resource's, or a resource template filled in). A server the thread does not
   carry, or a read that fails, leaves the token as words. */
import type { MentionBlock, MentionResolver } from "../types.js";

/** `serverId/uri` → both halves; null when either is empty. */
export function parseMcpRef(ref: string): { serverId: string; uri: string } | null {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return null;
  return { serverId: ref.slice(0, slash), uri: ref.slice(slash + 1) };
}

export const mcpResolver: MentionResolver = {
  kind: "mcp",
  async resolve(refs, ctx) {
    const blocks: MentionBlock[] = [];
    for (const ref of refs) {
      const parsed = parseMcpRef(ref);
      if (!parsed || !ctx.readMcpResource) continue;
      const body = await ctx.readMcpResource(parsed.serverId, parsed.uri);
      if (body === null || !body.trim()) continue;
      blocks.push({ ref, body: `${parsed.uri}\n\n${body}`, readMore: "the MCP server that serves it" });
    }
    return { blocks, claimed: [...refs] };
  },
};
