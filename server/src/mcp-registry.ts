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
  /** Publisher-supplied server icon, when present. */
  logoUrl: string | null;
  /** npm / pypi / oci / remote — what the reader is about to run. */
  via: string;
  /** Which source listed it (`SOURCES[].id`). */
  source: SourceId;
  /** The source's own popularity figure (Smithery uses, npm weekly downloads),
      for ordering and for the card; null where the source has none. */
  popularity: number | null;
  /** The source vouches for the publisher (Smithery's badge). */
  verified: boolean;
  /** Ready for `POST /api/mcp-servers`, placeholders and all. */
  server: McpServerInput;
  /** `{placeholder}` tokens left in the command, args, headers or env, and the
      env vars the publisher marked required: what the form has to be filled in
      with before this works. Said, not silently shipped. */
  needs: string[];
}

/** Where the browse page can look. All three answer without a key; a source
    that needs one (Glama) is not listed rather than listed and broken. */
export const SOURCES = [
  { id: "official", label: "Official", hint: "The MCP Registry: servers their publishers registered." },
  { id: "smithery", label: "Smithery", hint: "Hosted remote servers, ordered by use." },
  { id: "npm", label: "npm", hint: "Every npm package tagged mcp-server, including unregistered ones." },
] as const;
export type SourceId = (typeof SOURCES)[number]["id"];

export interface RegistrySearch {
  entries: RegistryEntry[];
  nextCursor: string | null;
  source: SourceId;
  sources: { id: SourceId; label: string; hint: string }[];
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
interface RegistryIcon {
  src?: string;
  theme?: "light" | "dark";
}
interface RegistryServer {
  name?: string;
  description?: string;
  version?: string;
  repository?: { url?: string };
  icons?: RegistryIcon[];
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

function fromPackage(name: string, pkg: RegistryPackage): Extract<McpServerInput, { type: "stdio" }> | null {
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

function fromRemote(name: string, remote: RegistryRemote): Extract<McpServerInput, { type: "http" }> | null {
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
function logoOf(icons: RegistryIcon[] | undefined): string | null {
  const candidates = icons ?? [];
  const preferred = [
    ...candidates.filter((icon) => !icon.theme),
    ...candidates.filter((icon) => icon.theme === "light"),
    ...candidates.filter((icon) => icon.theme === "dark"),
  ];
  for (const icon of preferred) {
    if (!icon.src) continue;
    try {
      const url = new URL(icon.src);
      if (url.protocol === "https:") return url.toString();
    } catch {
      // Try the next published variant.
    }
  }
  return null;
}

export function entriesOf(raw: RegistryServer): RegistryEntry[] {
  const qualifiedName = raw.name ?? "";
  if (!qualifiedName) return [];
  const name = shortName(qualifiedName);
  const common = {
    qualifiedName,
    description: raw.description ?? "",
    version: raw.version ?? "",
    repositoryUrl: raw.repository?.url ?? null,
    logoUrl: logoOf(raw.icons),
  };
  const out: RegistryEntry[] = [];
  for (const [i, pkg] of (raw.packages ?? []).entries()) {
    const server = fromPackage(name, pkg);
    if (server) {
      out.push({
        ...common,
        id: `${qualifiedName}#pkg${i}`,
        source: "official",
        popularity: null,
        verified: false,
        via: pkg.registryType ?? "package",
        server: { ...server, logoUrl: common.logoUrl ?? undefined },
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
        source: "official",
        popularity: null,
        verified: false,
        via: "remote",
        server: { ...server, logoUrl: common.logoUrl ?? undefined },
        needs: needsOf(server, remote.headers),
      });
    }
  }
  return out;
}

async function getJson<T>(url: URL, what: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new HttpError(`Couldn't reach ${what} at ${url.origin}: ${(err as Error).message}`, 502);
  }
  if (!res.ok) throw new HttpError(`${what} answered ${res.status} ${res.statusText}`, 502);
  return (await res.json()) as T;
}

/** One page of the MCP Registry (or a private one at `config.mcpRegistryUrl`).
    `version=latest` is not optional: without it the registry returns every
    published version as its own row, and a search for something popular comes
    back as twenty copies of one server. */
async function official(query: string, cursor?: string): Promise<Omit<RegistrySearch, "source" | "sources">> {
  const base = (getConfig().mcpRegistryUrl ?? DEFAULT_REGISTRY).replace(/\/+$/, "");
  const url = new URL(`${base}/v0/servers`);
  url.searchParams.set("version", "latest");
  url.searchParams.set("limit", "30");
  if (query) url.searchParams.set("search", query);
  if (cursor) url.searchParams.set("cursor", cursor);
  const body = await getJson<{ servers?: { server?: RegistryServer }[]; metadata?: { nextCursor?: string } }>(
    url,
    "the MCP registry",
  );
  return {
    entries: (body.servers ?? []).flatMap((row) => entriesOf(row.server ?? {})),
    nextCursor: body.metadata?.nextCursor ?? null,
  };
}

/** Smithery lists hosted servers. Its `qualifiedName` is also the path of the
    streamable-http endpoint; whether that endpoint wants OAuth is the save
    path's probe, as everywhere. */
async function smithery(query: string, cursor?: string): Promise<Omit<RegistrySearch, "source" | "sources">> {
  const page = Number(cursor) || 1;
  const url = new URL("https://registry.smithery.ai/servers");
  url.searchParams.set("pageSize", "30");
  url.searchParams.set("page", String(page));
  if (query) url.searchParams.set("q", query);
  const body = await getJson<{
    servers?: {
      qualifiedName: string;
      displayName?: string;
      description?: string;
      iconUrl?: string;
      homepage?: string;
      verified?: boolean;
      useCount?: number;
      remote?: boolean;
    }[];
    pagination?: { currentPage?: number; totalPages?: number };
  }>(url, "Smithery");
  const entries = (body.servers ?? [])
    .filter((s) => s.remote && s.qualifiedName)
    .map<RegistryEntry>((s) => ({
      id: `smithery:${s.qualifiedName}`,
      qualifiedName: s.qualifiedName,
      description: s.description ?? "",
      version: "",
      repositoryUrl: s.homepage ?? null,
      logoUrl: s.iconUrl?.startsWith("https://") ? s.iconUrl : null,
      via: "remote",
      source: "smithery",
      popularity: s.useCount ?? null,
      verified: Boolean(s.verified),
      server: {
        type: "http",
        name: shortName(s.qualifiedName),
        url: `https://server.smithery.ai/${s.qualifiedName}/mcp`,
        headers: [],
        auth: "none",
        logoUrl: s.iconUrl?.startsWith("https://") ? s.iconUrl : undefined,
      },
      needs: [],
    }));
  const { currentPage = page, totalPages = page } = body.pagination ?? {};
  return { entries, nextCursor: currentPage < totalPages ? String(currentPage + 1) : null };
}

/** npm packages tagged `mcp-server`: the long tail the registry has not seen.
    Run with `npx`, so the same pinning as a registry package. The cursor is
    the offset. Nothing declares env vars, so `needs` is empty — the README is
    the only place those live, and the repository link is the way to it. */
async function npm(query: string, cursor?: string): Promise<Omit<RegistrySearch, "source" | "sources">> {
  const from = Number(cursor) || 0;
  const url = new URL("https://registry.npmjs.org/-/v1/search");
  url.searchParams.set("text", `keywords:mcp-server ${query}`.trim());
  url.searchParams.set("size", "30");
  url.searchParams.set("from", String(from));
  const body = await getJson<{
    objects?: {
      downloads?: { weekly?: number };
      package: { name: string; version?: string; description?: string; links?: { repository?: string } };
    }[];
    total?: number;
  }>(url, "npm");
  const objects = body.objects ?? [];
  const entries = objects.map<RegistryEntry>(({ package: p, downloads }) => ({
    id: `npm:${p.name}`,
    qualifiedName: p.name,
    description: p.description ?? "",
    version: p.version ?? "",
    repositoryUrl: p.links?.repository?.replace(/^git\+/, "").replace(/\.git$/, "") ?? null,
    logoUrl: null,
    via: "npm",
    source: "npm",
    popularity: downloads?.weekly ?? null,
    verified: false,
    server: {
      type: "stdio",
      name: shortName(p.name),
      command: "npx",
      args: ["-y", p.version ? `${p.name}@${p.version}` : p.name],
      env: [],
    },
    needs: [],
  }));
  const next = from + objects.length;
  return { entries, nextCursor: objects.length > 0 && next < (body.total ?? 0) ? String(next) : null };
}

const SEARCH: Record<SourceId, typeof official> = { official, smithery, npm };

export async function searchRegistry(query: string, cursor?: string, source: string = "official"): Promise<RegistrySearch> {
  const id = SOURCES.some((s) => s.id === source) ? (source as SourceId) : "official";
  return { ...(await SEARCH[id](query, cursor)), source: id, sources: [...SOURCES] };
}

export interface RegistryDetail {
  /** Markdown, or null when the source has no readable one. */
  readme: string | null;
  /** What the server offers, where the source publishes it (Smithery does);
      null means "not published", never "none". Registry entries say nothing of
      tools, and finding out would mean running someone else's code. */
  tools: { name: string; description: string }[] | null;
}

const text = async (url: string) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return res.ok ? (await res.text()).slice(0, 200_000) : null;
  } catch {
    return null;
  }
};

/** The README and, where published, the tool list for one result. Inputs are
    only ever interpolated into the three hosts below, and a repository URL is
    parsed down to `owner/repo` on github.com — nothing here fetches a
    caller-supplied URL. */
export async function registryDetail(source: string, name: string, repo: string | null): Promise<RegistryDetail> {
  let tools: RegistryDetail["tools"] = null;
  let readme: string | null = null;
  if (source === "smithery") {
    try {
      const res = await fetch(`https://registry.smithery.ai/servers/${name.split("/").map(encodeURIComponent).join("/")}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const body = (await res.json()) as { tools?: { name: string; description?: string }[] };
        tools = (body.tools ?? []).map((t) => ({ name: t.name, description: t.description ?? "" }));
      }
    } catch {
      // Detail is a bonus; the page still draws without it.
    }
  }
  const gh = repo?.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/|$)/);
  if (gh) {
    for (const file of ["README.md", "readme.md", "Readme.md"]) {
      readme = await text(`https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/HEAD/${file}`);
      if (readme) break;
    }
  }
  if (!readme && source === "npm") {
    try {
      const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) readme = ((await res.json()) as { readme?: string }).readme ?? null;
    } catch {
      // as above
    }
  }
  return { readme, tools };
}
