/**
 * The one place the server names the ACP SDK. Everything else imports `acp`
 * from here — type-only in most files, at runtime in `acp-bridge.ts`,
 * `probe.ts` and `session-list.ts` — so the vendor dependency is a one-line
 * change here rather than a sweep of forty files. The client reaches the same
 * vocabulary through `@daedalus/acp` (a tsconfig path onto this file) and the
 * agent has its own `agent/src/acp.ts`; both resolve to the identical types.
 *
 * This is a rename shim, not an abstraction: it makes swapping the package
 * cheap, not swapping its shapes. What the bridge actually needs from an SDK
 * — and what any replacement must carry — is written down in
 * docs/protocol.md ("The SDK seam").
 */
export * from "@agentclientprotocol/sdk";
