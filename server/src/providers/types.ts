/**
 * Generic free-provider interface for the gateway shim.
 *
 * Some providers (opencode-free first) only serve clients that present a
 * specific fingerprint: exact headers, a session id with a valid counter,
 * verbatim tool definitions. The agents we spawn never send that, so the
 * shim applies it per request, behind this interface — adding the next
 * provider (antigravity, claude-code oauth, codex oauth) is a new file
 * plus one `detectProvider` entry, never a shim change.
 */

export interface ProviderContext {
  /** Stable id of the calling thread; sessions derive from it, never minted fresh per request. */
  threadId: string;
  /** Agent id on the thread (e.g. "daedalus"). */
  agentId: string;
  /** Profile row id, for logging. */
  profileId: string;
}

export interface FreeProvider {
  id: string;
  /**
   * Upstream path for this model, appended to the profile's baseUrl.
   * The profile's baseUrl is the provider root (e.g.
   * `https://opencode.ai/inference/v1`); the child asked for a dialect path
   * (`/chat/completions`) the provider may not serve per model.
   */
  upstreamPath(model: string, askedPath: string): string;
  /** Headers to set (overwriting the child's) before forwarding. */
  headers(ctx: ProviderContext): Record<string, string>;
  /** Header names the child may carry that upstream rejects. Dropped always. */
  dropRequestHeaders(): string[];
  /**
   * Rewrite the parsed JSON body in place. Returns true when changed.
   * Must force whatever the provider requires (e.g. `stream: true`).
   */
  transformBody(body: Record<string, unknown>, ctx: ProviderContext): boolean;
}
