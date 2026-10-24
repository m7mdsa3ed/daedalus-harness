/* Resolvers for the git kinds, read as the agent will see them:

     @commit:<sha>      the message, the stat and the (capped) patch
     @branch:<name>     the commits it has over the default branch, and their diff
     @tag:<name>        the tag's message and the commit it points at
     @git:changes       uncommitted work: tracked changes against HEAD, untracked names
     @git:staged        what is in the index
     @git:last-turn     what this thread's last measured turn wrote (turn attribution)
     @git:stash[/N]     one stash entry's patch

   A ref is read from the thread's own repository first, then from every nested
   checkout the project holds; the block names the one it came from, so a short
   sha or a branch name that exists in two of them is never silently the wrong
   one. A ref nothing has answers nothing and the token stays words. Every one
   of these is claimed whether it was found or not — none is ever a path. */
import { desc, eq } from "drizzle-orm";
import { db, sessionTurnChanges } from "../../db/index.js";
import * as git from "../../git.js";
import { EMPTY_TREE } from "../../turn-changes.js";
import { REF_NAME, repoDirs, type RepoDir } from "../git-dirs.js";
import type { MentionBlock, MentionContext, MentionResolution, MentionResolver } from "../types.js";

const SHA = /^[0-9a-f]{7,40}$/;
/** Commits listed for a branch before "and N more". */
const LIST_MAX = 40;
const FORMAT = "%H%n%an <%ae>%n%ad%n%n%B";

/** Cut `text` to `max` with a plain marker; `expandMentions` adds the hint that
    names the tool, this is so a resolver never holds megabytes it will drop. */
const cap = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);

/** A git call that is allowed to fail: not found, bad ref, no commits yet. */
async function tryGit(dir: string, args: string[], allowExit: number[] = []): Promise<string | null> {
  try {
    return (await git.runGit(dir, args, undefined, allowExit)).stdout;
  } catch {
    return null;
  }
}

const verify = async (dir: string, ref: string) =>
  (await tryGit(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]))?.trim() || null;

const where = (repo: RepoDir, repos: RepoDir[]) => (repos.length > 1 ? ` (repository: ${repo.name})` : "");

/** The first repository that `read` answers for. */
async function firstRepo<T>(repos: RepoDir[], read: (repo: RepoDir) => Promise<T | null>): Promise<{ repo: RepoDir; value: T } | null> {
  for (const repo of repos) {
    const value = await read(repo);
    if (value !== null) return { repo, value };
  }
  return null;
}

/** A resolver whose refs are each read on their own, in the shape every kind shares. */
function perRef(
  kind: MentionResolver["kind"],
  read: (ref: string, repos: RepoDir[], ctx: MentionContext, share: number) => Promise<string | null>,
  readMore: string,
): MentionResolver {
  return {
    kind,
    async resolve(refs, ctx): Promise<MentionResolution> {
      const blocks: MentionBlock[] = [];
      const repos = await repoDirs(ctx.projectId, ctx.cwd);
      const share = Math.max(Math.floor(ctx.budget / Math.max(refs.length, 1)), 2_000);
      if (repos.length > 0) {
        for (const ref of refs) {
          const body = await read(ref, repos, ctx, share);
          if (body) blocks.push({ ref, body, readMore });
        }
      }
      return { blocks, claimed: [...refs] };
    },
  };
}

/* ── commits and tags ── */

async function showCommit(dir: string, rev: string, share: number): Promise<string | null> {
  const out = await tryGit(dir, [
    "show",
    "--no-color",
    "--no-ext-diff",
    "-M",
    "--stat",
    "--patch",
    "--first-parent",
    "-m",
    "--date=iso",
    `--format=commit ${FORMAT}`,
    rev,
    "--",
  ]);
  return out === null ? null : cap(out.trim(), share);
}

export const commitResolver = perRef(
  "commit",
  async (ref, repos, _ctx, share) => {
    if (!SHA.test(ref)) return null;
    const hit = await firstRepo(repos, async (repo) => ((await verify(repo.dir, ref)) ? await showCommit(repo.dir, ref, share) : null));
    return hit ? `Commit ${ref}${where(hit.repo, repos)}\n\n${hit.value}` : null;
  },
  "`git show <sha>` in the project",
);

export const tagResolver = perRef(
  "tag",
  async (ref, repos, _ctx, share) => {
    if (!REF_NAME.test(ref)) return null;
    const hit = await firstRepo(repos, async (repo) => {
      const full = `refs/tags/${ref}`;
      if (!(await verify(repo.dir, full))) return null;
      // An annotated tag has a message of its own; a lightweight one is just a name for a commit.
      const message = await tryGit(repo.dir, ["for-each-ref", "--format=%(contents)", full]);
      const commit = await showCommit(repo.dir, `${full}^{commit}`, share);
      return commit === null ? null : `${message?.trim() ? `Tag message:\n${message.trim()}\n\n` : ""}${commit}`;
    });
    return hit ? `Tag ${ref}${where(hit.repo, repos)}\n\n${hit.value}` : null;
  },
  "`git show <tag>` in the project",
);

/* ── branches ── */

export const branchResolver = perRef(
  "branch",
  async (ref, repos, _ctx, share) => {
    if (!REF_NAME.test(ref)) return null;
    const hit = await firstRepo(repos, async (repo) => {
      const tip = (await verify(repo.dir, `refs/heads/${ref}`)) ?? (await verify(repo.dir, `refs/remotes/${ref}`));
      if (!tip) return null;
      const base = await git.branchBase(repo.dir, tip);
      const head = (await tryGit(repo.dir, ["log", "-1", "--format=%h %s (%an, %ad)", "--date=short", tip]))?.trim() ?? "";
      if ("unavailable" in base) {
        return `Tip: ${head}\n\nNo comparison: ${base.unavailable}`;
      }
      const commits = (await tryGit(repo.dir, ["log", `--max-count=${LIST_MAX + 1}`, "--format=%h %s (%an)", `${base.base}..${tip}`]))?.trim().split("\n").filter(Boolean) ?? [];
      const list = commits.slice(0, LIST_MAX).join("\n");
      const more = commits.length > LIST_MAX ? `\n… and more commits (git log ${base.base.slice(0, 8)}..${ref})` : "";
      const stat = (await tryGit(repo.dir, ["diff", "--no-color", "--no-ext-diff", "-M", "--stat", base.base, tip])) ?? "";
      const patch = (await tryGit(repo.dir, ["diff", "--no-color", "--no-ext-diff", "-M", base.base, tip], [1])) ?? "";
      return [
        `Tip: ${head}`,
        `Compared with where it forked from the default branch (${base.base.slice(0, 8)}):`,
        "",
        `Commits (${commits.length > LIST_MAX ? `${LIST_MAX}+` : commits.length}):`,
        list || "(none)",
        more,
        "",
        stat.trim(),
        "",
        cap(patch, Math.max(share - 2_000, 1_000)),
      ].join("\n");
    });
    return hit ? `Branch ${ref}${where(hit.repo, repos)}\n${hit.value}` : null;
  },
  "`git diff <base>..<branch>` in the project",
);

/* ── the working tree ── */

async function changes(dir: string, share: number): Promise<string | null> {
  const status = await tryGit(dir, ["status", "--short", "--untracked-files=all"]);
  if (status === null) return null;
  const hasHead = !!(await verify(dir, "HEAD"));
  // An unborn branch has no HEAD to compare to; what is staged is all there is to diff.
  const patch =
    (await tryGit(dir, hasHead ? ["diff", "--no-color", "--no-ext-diff", "-M", "HEAD"] : ["diff", "--no-color", "--no-ext-diff", "--cached"], [1])) ?? "";
  const untracked = status
    .split("\n")
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.slice(3));
  return [
    "Status:",
    status.trim() || "(clean)",
    untracked.length ? `\nUntracked files are listed above but not diffed (${untracked.length}).` : "",
    "",
    cap(patch, Math.max(share - status.length, 1_000)),
  ].join("\n");
}

async function staged(dir: string, share: number): Promise<string | null> {
  const stat = await tryGit(dir, ["diff", "--cached", "--no-color", "--stat"]);
  if (stat === null) return null;
  if (!stat.trim()) return "Nothing is staged.";
  const patch = (await tryGit(dir, ["diff", "--cached", "--no-color", "--no-ext-diff", "-M"], [1])) ?? "";
  return `${stat.trim()}\n\n${cap(patch, Math.max(share - stat.length, 1_000))}`;
}

/** The newest turn of this thread that was measured start to end, as a patch. */
async function lastTurn(repo: RepoDir, ctx: MentionContext, share: number): Promise<string | null> {
  if (!ctx.sessionId) return null;
  const rows = await db
    .select()
    .from(sessionTurnChanges)
    .where(eq(sessionTurnChanges.sessionId, ctx.sessionId))
    .orderBy(desc(sessionTurnChanges.startedAt))
    .limit(20);
  const turn = rows.find((row) => row.startTree && row.endTree && row.files.length > 0);
  if (!turn?.startTree || !turn.endTree) return "The last turn that wrote files has no measurable trees any more (git pruned them).";
  if (!(await git.hasObject(repo.dir, turn.startTree)) || !(await git.hasObject(repo.dir, turn.endTree))) {
    return "The last turn's snapshots are gone from the repository (git pruned them), so its diff can no longer be read.";
  }
  const files = turn.files.map((f) => `${f.status} ${f.path} (+${f.additions} -${f.deletions})${f.shared?.length ? " [also written by another thread]" : ""}`);
  const patch = await git.patchBetween(repo.dir, turn.startTree || EMPTY_TREE, turn.endTree);
  return `Files:\n${files.join("\n")}\n\n${cap(patch, Math.max(share - files.join("\n").length, 1_000))}`;
}

async function stash(dir: string, index: number, share: number): Promise<string | null> {
  const list = await tryGit(dir, ["stash", "list", "--format=%gd: %s"]);
  if (!list?.trim()) return null;
  const entry = list.split("\n").find((line) => line.startsWith(`stash@{${index}}:`));
  if (!entry) return null;
  const patch = await tryGit(dir, ["stash", "show", "-p", "--no-color", "--include-untracked", `stash@{${index}}`]);
  return `${entry}\n\n${cap(patch ?? "", share)}`;
}

export const gitResolver = perRef(
  "git",
  async (ref, repos, ctx, share) => {
    const own = repos[0]!;
    switch (true) {
      case ref === "changes": {
        const hit = await firstRepo(repos, (repo) => changes(repo.dir, share));
        return hit ? `Uncommitted changes${where(hit.repo, repos)}\n\n${hit.value}` : null;
      }
      case ref === "staged": {
        const hit = await firstRepo(repos, (repo) => staged(repo.dir, share));
        return hit ? `Staged changes${where(hit.repo, repos)}\n\n${hit.value}` : null;
      }
      case ref === "last-turn": {
        const body = await lastTurn(own, ctx, share);
        return body ? `What this thread's last turn changed\n\n${body}` : null;
      }
      case /^stash(\/\d+)?$/.test(ref): {
        const index = Number(ref.split("/")[1] ?? 0);
        const hit = await firstRepo(repos, (repo) => stash(repo.dir, index, share));
        return hit ? `Stash ${index}${where(hit.repo, repos)}\n\n${hit.value}` : null;
      }
      default:
        return null;
    }
  },
  "`git status` / `git diff` in the project",
);

export const gitResolvers: MentionResolver[] = [commitResolver, branchResolver, tagResolver, gitResolver];
