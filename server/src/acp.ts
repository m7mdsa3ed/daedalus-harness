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
import { createRequire } from "node:module";

export * from "@agentclientprotocol/sdk/unstable";

/** The SDK's published schema, the one place its `SessionUpdate` union is
    spelled as data. Resolved from here because this is the one file that
    names the package; a data file of the SDK is still the SDK. */
const SDK_SCHEMA = "@agentclientprotocol/sdk/schema/v1/schema.unstable.json";

interface SchemaVariant {
  properties?: { sessionUpdate?: { const?: unknown } };
}
interface SdkSchema {
  $defs?: Record<string, { oneOf?: SchemaVariant[]; anyOf?: SchemaVariant[] }>;
  definitions?: Record<string, { oneOf?: SchemaVariant[]; anyOf?: SchemaVariant[] }>;
}

/** Every `sessionUpdate` tag the SDK's `SessionUpdate` union carries, read off
    the schema. Throws if the schema no longer has the shape — a silent empty
    set would reroute every update and blind the bridge's typed path. Server
    only: the client imports this barrel type-only, so the `node:module`
    import is erased there and never bundled. */
export function readSdkSessionUpdateTags(): ReadonlySet<string> {
  const schema = createRequire(import.meta.url)(SDK_SCHEMA) as SdkSchema;
  const def = (schema.$defs ?? schema.definitions)?.SessionUpdate;
  const variants = def?.oneOf ?? def?.anyOf;
  if (!Array.isArray(variants)) throw new Error(`${SDK_SCHEMA}: no SessionUpdate oneOf/anyOf`);
  const tags = variants
    .map((v) => v.properties?.sessionUpdate?.const)
    .filter((tag): tag is string => typeof tag === "string");
  if (tags.length === 0 || tags.length !== variants.length) {
    throw new Error(`${SDK_SCHEMA}: SessionUpdate variants without a sessionUpdate const`);
  }
  return new Set(tags);
}
