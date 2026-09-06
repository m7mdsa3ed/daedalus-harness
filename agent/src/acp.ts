/**
 * The one place the agent names the ACP SDK — see the server's twin,
 * `server/src/acp.ts`, and docs/protocol.md ("The SDK seam") for what the
 * runtime relies on and why the `initialize` parser in `app.ts` bypasses the
 * SDK's schema.
 */
export * from "@agentclientprotocol/sdk";
