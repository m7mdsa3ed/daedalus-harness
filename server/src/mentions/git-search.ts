/* What the `@commit:` / `@branch:` / `@tag:` / `@git:` menus offer: matches for
   what was typed after the colon, across the repositories a mention can name
   (`git-dirs.ts`). Names and subjects only — the content is `resolvers/git.ts`'s,
   at send. */
import * as git from "../git.js";
import { repoDirs, type RepoDir } from "./git-dirs.js";

export type GitSearchKind = "commit" | "branch" | "tag" | "git";

export interface GitMatch {
  /** What follows `@kind:` in the token. */
  ref: string;
  label: string;
  description?: string;
  aside?: string;
  /** Set when the project holds more than one repository. */
  repo?: string;
}

const LIMIT = 12;
const FIELD = "\x1f";

async function tryGit(dir: string, args: string[]): Promise<string> {
  try {
    return (await git.runGit(dir, args)).stdout;
  } catch {
    return "";
  }
}

const tag = (repo: RepoDir, repos: RepoDir[]) => (repos.length > 1 ? repo.name : undefined);

async function commits(repos: RepoDir[], q: string): Promise<GitMatch[]> {
  const out: GitMatch[] = [];
  for (const repo of repos) {
    // A hash prefix is a lookup, not a search: `--grep` would never find it.
    const byHash = /^[0-9a-f]{4,40}$/i.test(q);
    const args = [
      "log",
      "--no-color",
      `--max-count=${LIMIT}`,
      `--format=%H${FIELD}%h${FIELD}%s${FIELD}%an${FIELD}%ar`,
      ...(q && !byHash ? ["-i", "--fixed-strings", `--grep=${q}`, "--all-match"] : []),
      ...(q && !byHash ? ["--branches", "--remotes", "--tags", "HEAD"] : ["HEAD"]),
    ];
    const text = await tryGit(repo.dir, args);
    for (const line of text.split("\n")) {
      const [hash, short, subject, author, ago] = line.split(FIELD);
      if (!hash || !short) continue;
      if (byHash && !hash.startsWith(q.toLowerCase())) continue;
      out.push({ ref: short, label: subject ?? short, description: `${short} · ${author ?? ""}`.trim(), aside: ago, repo: tag(repo, repos) });
    }
  }
  return out.slice(0, LIMIT);
}

async function refs(repos: RepoDir[], q: string, prefix: "refs/heads" | "refs/remotes" | "refs/tags"): Promise<GitMatch[]> {
  const needle = q.toLowerCase();
  const out: GitMatch[] = [];
  for (const repo of repos) {
    const sort = prefix === "refs/tags" ? "-creatordate" : "-committerdate";
    const text = await tryGit(repo.dir, ["for-each-ref", `--sort=${sort}`, `--format=%(refname:short)${FIELD}%(subject)${FIELD}%(committerdate:relative)`, prefix]);
    const head = prefix === "refs/heads" ? (await git.currentBranch(repo.dir).catch(() => null)) : null;
    for (const line of text.split("\n")) {
      const [name, subject, ago] = line.split(FIELD);
      if (!name || name.endsWith("/HEAD")) continue;
      if (needle && !name.toLowerCase().includes(needle)) continue;
      out.push({
        ref: name,
        label: name,
        description: subject,
        aside: name === head ? "current" : ago,
        repo: tag(repo, repos),
      });
    }
  }
  // The checked-out branch leads, then newest first (for-each-ref's own order).
  return out.sort((a, b) => Number(b.aside === "current") - Number(a.aside === "current")).slice(0, LIMIT);
}

async function working(repos: RepoDir[], q: string): Promise<GitMatch[]> {
  const first = repos[0];
  const rows: GitMatch[] = [
    { ref: "changes", label: "changes", description: "Uncommitted changes: tracked diff and untracked names" },
    { ref: "staged", label: "staged", description: "What is in the index" },
    { ref: "last-turn", label: "last-turn", description: "What this thread's last turn wrote" },
  ];
  if (first) {
    const stashes = (await tryGit(first.dir, ["stash", "list", "--format=%gd%x1f%s"])).split("\n").filter(Boolean);
    stashes.slice(0, 5).forEach((line, i) => rows.push({ ref: `stash/${i}`, label: `stash/${i}`, description: line.split(FIELD)[1] ?? "Stash" }));
  }
  const needle = q.toLowerCase();
  return needle ? rows.filter((row) => `${row.label} ${row.description ?? ""}`.toLowerCase().includes(needle)) : rows;
}

export async function searchGit(projectId: string, cwd: string, kind: GitSearchKind, q: string): Promise<GitMatch[]> {
  const repos = await repoDirs(projectId, cwd);
  if (repos.length === 0) return [];
  switch (kind) {
    case "commit":
      return commits(repos, q.trim());
    case "tag":
      return refs(repos, q.trim(), "refs/tags");
    case "branch": {
      const local = await refs(repos, q.trim(), "refs/heads");
      return local.length >= LIMIT ? local : [...local, ...(await refs(repos, q.trim(), "refs/remotes"))].slice(0, LIMIT);
    }
    case "git":
      return working(repos, q.trim());
  }
}
