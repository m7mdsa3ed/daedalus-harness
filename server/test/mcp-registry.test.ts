// Self-check for the marketplace mapping (src/mcp-registry.ts): a registry
// `server.json` becomes the library's own `McpServerInput`.
//
// The two fixtures are verbatim captures from registry.modelcontextprotocol.io
// — one npm/stdio package with required and secret environment variables, one
// hosted remote whose header carries a `{placeholder}` the user must fill.
// Pure function, no network.
// Run: pnpm test:mcp-registry
import "./require-temp-data.js";
import assert from "node:assert/strict";

const { entriesOf } = await import("../src/mcp-registry.js");

/* ── an npm package ── */
const [pkg] = entriesOf({
  name: "com.pulsemcp/remote-filesystem",
  description: "MCP server for remote filesystem operations on cloud storage.",
  repository: { url: "https://github.com/pulsemcp/mcp-servers" },
  version: "0.1.5",
  icons: [
    { src: "http://insecure.example/logo.png", theme: "light" },
    { src: "https://cdn.example/logo.png", theme: "light" },
    { src: "https://cdn.example/logo-dark.png", theme: "dark" },
  ],
  packages: [
    {
      registryType: "npm",
      identifier: "remote-filesystem-mcp-server",
      version: "0.1.5",
      runtimeHint: "npx",
      transport: { type: "stdio" },
      runtimeArguments: [{ value: "-y", type: "positional" }],
      environmentVariables: [
        { name: "GCS_BUCKET", isRequired: true },
        { name: "GCS_MAKE_PUBLIC", default: "false" },
      ],
    },
  ],
});

assert.equal(pkg.via, "npm");
assert.equal(pkg.qualifiedName, "com.pulsemcp/remote-filesystem");
assert.equal(pkg.logoUrl, "https://cdn.example/logo.png");
assert.equal(pkg.server.type, "stdio");
assert.equal(pkg.server.name, "remote-filesystem", "the agent gets the tail, not the reverse-DNS name");
if (pkg.server.type !== "stdio") throw new Error("unreachable");
assert.equal(pkg.server.logoUrl, pkg.logoUrl, "the icon rides the server row too");
assert.equal(pkg.server.command, "npx");
// Runtime arguments come before the package, and the package is pinned.
assert.deepEqual(pkg.server.args, ["-y", "remote-filesystem-mcp-server@0.1.5"]);
assert.deepEqual(pkg.server.env, [
  { name: "GCS_BUCKET", value: "" },
  { name: "GCS_MAKE_PUBLIC", value: "false" },
]);
// A required variable with nothing to fill it from is said, not shipped blank in silence.
assert.deepEqual(pkg.needs, ["GCS_BUCKET"]);

/* ── a hosted remote ── */
const [remote] = entriesOf({
  name: "ai.smithery/Hint-Services-obsidian-github-mcp",
  description: "Connect AI assistants to your GitHub-hosted Obsidian vault.",
  version: "0.4.0",
  remotes: [
    {
      type: "streamable-http",
      url: "https://server.smithery.ai/@Hint-Services/obsidian-github-mcp/mcp",
      headers: [{ name: "Authorization", value: "Bearer {smithery_api_key}", isRequired: true, isSecret: true }],
    },
  ],
});

assert.equal(remote.via, "remote");
assert.equal(remote.server.type, "http");
if (remote.server.type !== "http") throw new Error("unreachable");
assert.equal(remote.server.url, "https://server.smithery.ai/@Hint-Services/obsidian-github-mcp/mcp");
assert.deepEqual(remote.server.headers, [{ name: "Authorization", value: "Bearer {smithery_api_key}" }]);
// Never read from the registry: the save path's probe is what decides this.
assert.equal(remote.server.auth, "none");
assert.deepEqual(remote.needs, ["smithery_api_key"]);

/* ── a container ── */
const [oci] = entriesOf({
  name: "io.github.acme/thing",
  version: "2.0.0",
  packages: [
    {
      registryType: "oci",
      identifier: "acme/thing",
      version: "2.0.0",
      environmentVariables: [{ name: "API_KEY", isRequired: true, isSecret: true }],
    },
  ],
});
if (oci.server.type !== "stdio") throw new Error("unreachable");
assert.equal(oci.server.command, "docker");
// The env has to cross the container boundary as flags; the values still travel as env.
assert.deepEqual(oci.server.args, ["run", "-i", "--rm", "-e", "API_KEY", "acme/thing:2.0.0"]);
assert.deepEqual(oci.server.env, [{ name: "API_KEY", value: "" }]);

/* A server with neither a package we can run nor a remote contributes no rows
   rather than a broken one. */
assert.deepEqual(entriesOf({ name: "io.github.acme/nothing", packages: [{ registryType: "mcpb" }] }), []);
assert.equal(
  entriesOf({
    name: "io.github.acme/data-icon",
    icons: [{ src: "data:image/png;base64,AAAA" }],
    remotes: [{ url: "https://example.com/mcp" }],
  })[0]?.logoUrl,
  null,
  "data icons are not rendered as external registry URLs",
);

console.log("mcp-registry: ok");
