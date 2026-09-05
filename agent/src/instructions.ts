import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/* ── Standing instructions a workspace already has ──
   Every other runtime picks these up — `AGENTS.md` for codex and opencode,
   `CLAUDE.md` for Claude Code — so a repo that has spent months accumulating
   house rules hands them to whichever agent opens it. This agent read neither,
   which meant the same repo silently got a worse answer from us than from the
   agent next to us, for no reason a user could see.

   Two rules shape the scan. The **nearest file has the last word**, so the walk
   is emitted outermost-first and a package's own AGENTS.md follows the
   monorepo's. And the **repo is the ceiling**: the walk stops at the directory
   holding `.git`, because above a checkout is somebody's home directory, and
   inheriting instructions from `~/src` is a surprise nobody asked for. The
   user-level `~/.claude/CLAUDE.md` is included deliberately and first — it is
   the weakest voice in the prompt, and it is where "how I like things" lives. */

/* Every spelling the ecosystem actually ships, weakest first within a
   directory. `AGENT.md` is opencode's singular — this repo's own rules file is
   one, and for months it was the file the agent standing in the repo could not
   see while every other runtime read it. Both names are listed rather than
   picked between: a repo that has both means both, and two files with the same
   body dedupe below anyway. */
const NAMES = ["AGENT.md", "AGENTS.md", "CLAUDE.md", "CLAUDE.local.md"];
/**
 * How far up to walk when nothing stops us first.
 *
 * A `.git` is the real ceiling and it is the one that matters; this is only
 * the backstop for a cwd that is *not* in a checkout, where the walk would
 * otherwise run to `/` and read whatever `AGENTS.md` happens to sit in a home
 * directory. Deliberately generous — the cost of one more level is three
 * `statSync` calls, and the cost of being too small is a monorepo's root rules
 * silently missing from a deeply nested package, which is exactly the case
 * this file exists to serve.
 */
const MAX_LEVELS = 24;
/* Characters, not tokens, and generous on purpose. A repo that has written its
   rules down at length is exactly the repo that meant them: at 16k this
   harness's own `CLAUDE.md` (42k) arrived cut off at a third, which reads to
   the model as a rulebook that simply stops — worse than none, because the
   half it kept looked complete. The cost is bounded and it is *cached*: the
   instruction blocks sit ahead of the one volatile line in the system prompt,
   so a session pays for them on its first step and reads them from the
   provider's prefix cache on every step after. */
const FILE_LIMIT = 48_000;
const TOTAL_LIMIT = 80_000;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Paths, in the order they should be read: weakest first. */
export function findInstructionFiles(cwd: string, home = homedir()): string[] {
  const dirs: string[] = [];
  let dir = cwd;
  for (let level = 0; level < MAX_LEVELS; level += 1) {
    dirs.push(dir);
    if (existsSync(join(dir, ".git"))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  dirs.reverse();

  const found = [join(home, ".claude", "CLAUDE.md")];
  for (const d of dirs) for (const name of NAMES) found.push(join(d, name));

  /* Deduped by real path, because `AGENTS.md -> CLAUDE.md` is a symlink half
     the repos in the wild ship, and reading it twice is the same tokens twice. */
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const path of found) {
    if (!isFile(path)) continue;
    let key = path;
    try {
      key = realpathSync(path);
    } catch {
      // Unreadable link: keep the literal path and let the read fail later.
    }
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(path);
  }
  return paths;
}

/** Reads the files fresh, clipped to a budget. One block per file, labelled
    with its path so a rule can be traced back to the file that set it — and so
    the agent can be told to go and edit the right one. */
export function readInstructions(paths: string[]): string[] {
  const blocks: string[] = [];
  const bodies = new Set<string>();
  let budget = TOTAL_LIMIT;
  for (const path of paths) {
    if (budget <= 0) break;
    let text: string;
    try {
      text = readFileSync(path, "utf8").trim();
    } catch {
      continue;
    }
    // Copies rather than symlinks — the same content under two names.
    if (!text || bodies.has(text)) continue;
    bodies.add(text);
    const limit = Math.min(FILE_LIMIT, budget);
    /* A clip says so in the model's own terms — which file, how much is
       missing and that the rest can be read — because an instruction the
       prompt silently dropped is one the model is blamed for not following. */
    const body =
      text.length > limit
        ? `${text.slice(0, limit)}\n\n[…truncated: ${text.length - limit} more characters in ${path}. Read the file if you need the rest.]`
        : text;
    budget -= body.length;
    blocks.push(`Instructions from ${path}:\n\n${body}`);
  }
  return blocks;
}
