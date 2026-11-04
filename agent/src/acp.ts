/**
 * The one place the agent names the ACP SDK — see the server's twin,
 * `server/src/acp.ts`, and docs/protocol.md ("The SDK seam") for what the
 * runtime relies on. The `/unstable` entry is deliberate: it is the one whose
 * `ClientCapabilities` types `subagents` and `plan`, so `initialize` can be
 * registered on the SDK's own parser and the capability literal survives it.
 */
export * from "@agentclientprotocol/sdk/unstable";
