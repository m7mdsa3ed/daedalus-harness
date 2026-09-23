import type { McpServerInput } from "./library.js";
import { HttpError } from "./http-error.js";
import { getConfig } from "./config.js";

/*
 * The marketplace: search an MCP Registry and hand back rows already shaped
 * like the library's own.
 *
 * **We index nothing.** The official registry
 * (`registry.modelcontextprotocol.io`) is an open spec — a `server.json` per
 * server, listing `packages` (stdio) and `remotes` (http) — so the whole
 * feature is one fetch and the mapping below. A catalog of our own would be a
 * second thing to keep fresh, and `config.mcpRegistryUrl` is what points this
 * at a private registry implementing the same spec.
 *
 * The proxy is server-side because it is the side that holds the config, and
 * because the browser's credential here is our bearer token, not a CORS
 * grant from someone else's host.
 *
 * What this never answers is **how a remote authenticates**: `mcp_servers.auth`
 * is a probed answer (see `mcp-oauth.ts`), and a registry saying "streamable
 * http" says nothing about a 401. A browsed row lands as `auth: "none"` and
 * the save path's probe decides, exactly as a typed one does.
 */

const DEFAULT_REGISTRY = "https://registry.modelcontextprotocol.io";

/** One installable thing: a registry server crossed with one of its packages
    or remotes. Most have exactly one, so the cross is usually the identity —
    but a server offering both an npm package and a hosted remote is two real
    choices and flattening them is what lets the reader make it. */
export interface RegistryEntry {
  /** Stable enough to key a list on; not an id the registry knows. */
  id: string;
  /** Reverse-DNS registry name, e.g. `io.github.acme/search`. */
  qualifiedName: string;
  description: string;
  version: string;
  /** Where the code lives — the one provenance signal worth drawing. */
  repositoryUrl: string | null;
  /** npm / pypi / oci / remote — what the reader is about to run. */
  via: string;
  /** Ready for `POST /api/mcp-servers`, placeholders and all. */
  server: McpServerInput;
  /** `{placeholder}` tokens left in the command, args, headers or env, and the
      env vars the publisher marked required: what the form has to be filled in
      with before this works. Said, not silently shipped. */
  needs: string[];
}

export interface RegistrySearch {
  entries: RegistryEntry[];
  nextCursor: string | null;
}

/* ── the registry's own shapes, narrowed to what we read ── */
interface RegistryArgument {
  type?: string;
  name?: string;
  value?: string;
  isRequired?: boolean;
  /** The publisher saying this is a credential. Read only as documentation for
      now: the form masks nothing, because every other env row in the library is
      typed in plain and a secret that looks different only here would read as a
      guarantee we do not make. */
  isSecret?: boolean;
  default?: string;
}
interface RegistryPackage {
  registryType?: string;
  identifier?: string;
  version?: string;
  runtimeHint?: string;
  transport?: { type?: string };
  runtimeArguments?: RegistryArgument[];
  packageArguments?: RegistryArgument[];
  environmentVariables?: RegistryArgument[];
}
interface RegistryRemote {
  type?: string;
  url?: string;
  headers?: RegistryArgument[];
}
interface RegistryServer {
  name?: string;
  description?: string;
  version?: string;
  repository?: { url?: string };
  packages?: RegistryPackage[];
  remotes?: RegistryRemote[];
}

/** `io.github.acme/web-search` -> `web-search`. The agent addresses a server
    by this name, and a reverse-DNS string is not a name anybody types into a
    prompt. Sanitised, never empty. */
function shortName(qualified: string): string {
  const tail = qualified.split("/").pop() ?? qualified;
  return tail.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "") || "mcp-server";
}

/** The runtime that runs this package, when the publisher did not name one.
    `runtimeHint` is the publisher's own answer and always wins. */
const RUNTIME: Record<string, string> = {
  npm: "npx",
  pypi: "uvx",
  oci: "docker",
  nuget: "dnx",
};

/** `pkg@1.2.3` for npm, `pkg==1.2.3` for PyPI, `image:1.2.3` for a container —
    three ecosystems, three separators, and pinning matters more here than
    anywhere else in the library: this is a command somebody is about to run. */
function pinned(pkg: RegistryPackage): string {
  const id = pkg.identifier ?? "";
  if (!pkg.version) return id;
  if (pkg.registryType === "pypi") return `${id}==${pkg.version}`;
  if (pkg.registryType === "oci") return `${id}:${pkg.version}`;
  return `${id}@${pkg.version}`;
}

/** `{positional|named}` -> argv. A named argument with no value is a flag. */
function argv(args: RegistryArgument[] | undefined): string[] {
  const out: string[] = [];
  for (const a of args ?? []) {
    const value = a.value ?? a.default ?? "";
    if (a.type === "named" && a.name) {
      out.push(a.name);
      if (value) out.push(value);
    } else if (value) {
      out.push(value);
    }
  }
  return out;
}

const pairs = (args: RegistryArgument[] | undefined) =>
  (args ?? [])
    .filter((a): a is RegistryArgument & { name: string } => Boolean(a.name))
    .map((a) => ({ name: a.name, value: a.value ?? a.default ?? "" }));

/** Every `{placeholder}` the publisher left for the user to fill, plus the env
    vars marked required with nothing to fill them from. */
function needsOf(server: McpServerInput, env: RegistryArgument[] | undefined): string[] {
  const text = JSON.stringify(server);
  const placeholders = [...text.matchAll(/\{([a-z0-9_]+)\}/gi)].map((m) => m[1]);
  const required = (env ?? [])
    .filter((e) => e.isRequired && !e.value && !e.default && e.name)
    .map((e) => e.name as string);
  return [...new Set([...placeholders, ...required])];
}

function fromPackage(name: string, pkg: RegistryPackage): McpServerInput | null {
  // Only stdio packages become a library row: a package declaring an http
  // transport is reached through its `remotes` entry, not by us spawning it.
  if (pkg.transport?.type && pkg.transport.type !== "stdio") return null;
  const command = pkg.runtimeHint ?? RUNTIME[pkg.registryType ?? ""] ?? null;
  if (!command || !pkg.identifier) return null;
  const env = pairs(pkg.environmentVariables);
  const args = [...argv(pkg.runtimeArguments)];
  /* A container does not inherit our environment, so what would be `env` for a
     spawned process has to cross the boundary as `-e NAME` flags — the values
     still travel as env, which is what keeps a secret out of the argv a `ps`
     would show. */
  if (command === "docker") {
    if (!args.includes("run")) args.unshift("run", "-i", "--rm");
    for (const { name: key } of env) args.push("-e", key);
  }
  args.push(pinned(pkg), ...argv(pkg.packageArguments));
  return { type: "stdio", name, command, args, env };
}

function fromRemote(name: string, remote: RegistryRemote): McpServerInput | null {
  if (!remote.url) return null;
  return {
    type: "http",
    name,
    url: remote.url,
    headers: pairs(remote.headers),
    // Probed on save, never read from the registry. See the header comment.
    auth: "none",
  };
}

/** One `server.json` -> the rows the browse page draws. Exported for the
    self-check: this mapping is the whole feature, and it is the half that
    cannot be verified by looking at it. */
export function entriesOf(raw: RegistryServer): RegistryEntry[] {
  const qualifiedName = raw.name ?? "";
  if (!qualifiedName) return [];
  const name = shortName(qualifiedName);
  const common = {
    qualifiedName,
    description: raw.description ?? "",
    version: raw.version ?? "",
    repositoryUrl: raw.repository?.url ?? null,
  };
  const out: RegistryEntry[] = [];
  for (const [i, pkg] of (raw.packages ?? []).entries()) {
    const server = fromPackage(name, pkg);
    if (server) {
      out.push({
        ...common,
        id: `${qualifiedName}#pkg${i}`,
        via: pkg.registryType ?? "package",
        server,
        needs: needsOf(server, pkg.environmentVariables),
      });
    }
  }
  for (const [i, remote] of (raw.remotes ?? []).entries()) {
    const server = fromRemote(name, remote);
    if (server) {
      out.push({
        ...common,
        id: `${qualifiedName}#remote${i}`,
        via: "remote",
        server,
        needs: needsOf(server, remote.headers),
      });
    }
  }
  return out;
}

/**
 * One page of the registry.
 *
 * `version=latest` is not optional: without it the registry returns every
 * published version as its own row, and a search for something popular comes
 * back as twenty copies of one server.
 */
export async function searchRegistry(query: string, cursor?: string): Promise<RegistrySearch> {
  const base = (getConfig().mcpRegistryUrl ?? DEFAULT_REGISTRY).replace(/\/+$/, "");
  const url = new URL(`${base}/v0/servers`);
  url.searchParams.set("version", "latest");
  url.searchParams.set("limit", "30");
  if (query) url.searchParams.set("search", query);
  if (cursor) url.searchParams.set("cursor", cursor);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new HttpError(`Couldn't reach the MCP registry at ${base}: ${(err as Error).message}`, 502);
  }
  if (!res.ok) throw new HttpError(`The MCP registry answered ${res.status} ${res.statusText}`, 502);
  const body = (await res.json()) as {
    servers?: { server?: RegistryServer }[];
    metadata?: { nextCursor?: string };
  };
  return {
    entries: (body.servers ?? []).flatMap((row) => entriesOf(row.server ?? {})),
    nextCursor: body.metadata?.nextCursor ?? null,
  };
}
