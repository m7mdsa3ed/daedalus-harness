/* ── `@` mentions ──
 *
 * A mention is written into the prompt as plain text (`@src/index.ts`), and it
 * stays plain text everywhere the harness handles it: the draft, the queue, the
 * journal, the retry row and the prompt-history walk are all strings, and none
 * of them had to learn a second shape. What this file adds is the *protocol*
 * half — ACP's `resource_link` content block, sent alongside the text so an
 * agent knows the path is a reference to a real file rather than a word that
 * happens to start with an at-sign.
 *
 * Both halves travel, deliberately. The text is what every runtime understands
 * (Claude Code and Codex both read `@path` in prose), and the links are what a
 * runtime that reads the protocol can resolve without guessing. Dropping the
 * text in favour of the links would make the transcript — which is the text —
 * stop saying what the user typed.
 *
 * The rule for what becomes a link is the conservative one: a token only counts
 * if it resolves to something that **exists inside the project's cwd**. Prose
 * is full of at-signs (an email address, a handle, a decorator), and inventing
 * a file reference for one is worse than missing it — the agent would go
 * looking for a path nobody meant.
 */
import { existsSync, realpathSync } from "node:fs";
import { normalize, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type * as acp from "./acp.js";

/** A token after a whitespace boundary: `@` then a run of non-space. The
    boundary is what keeps `user@example.com` from reading as a mention. */
const MENTION_RE = /(?:^|[\s(])@([^\s@]+)/g;

/** Punctuation a sentence puts after a path but which is never part of one. */
const TRAILING = /[.,;:!?)\]}'"]+$/;

/** Past this a prompt is not mentioning files, it is pasting a list of them. */
const MAX_LINKS = 20;

/** Every distinct `@token` in `text`, cleaned of trailing punctuation. */
export function mentionPaths(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(MENTION_RE)) {
    const raw = match[1].replace(TRAILING, "");
    if (raw !== "") seen.add(raw);
  }
  return [...seen];
}

/**
 * The `resource_link` blocks for a prompt, in the order they were mentioned.
 *
 * Containment is checked the same way `workspace-fs` checks it — lexically and
 * then against the real path — because a mention is user input that names a
 * file for an agent, and `@../../.ssh/id_rsa` must not become a link the agent
 * is invited to open. A path that escapes, or does not exist, simply is not a
 * link; the text still says what the user typed.
 */
export function mentionLinks(cwd: string, text: string): acp.ContentBlock[] {
  let root: string;
  try {
    root = realpathSync(cwd);
  } catch {
    return [];
  }
  const links: acp.ContentBlock[] = [];
  for (const path of mentionPaths(text)) {
    if (links.length >= MAX_LINKS) break;
    if (path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path)) continue;
    const absolute = resolve(root, normalize(path));
    if (absolute !== root && !absolute.startsWith(root + sep)) continue;
    if (!existsSync(absolute)) continue;
    let real: string;
    try {
      real = realpathSync(absolute);
    } catch {
      continue;
    }
    if (real !== root && !real.startsWith(root + sep)) continue;
    links.push({
      type: "resource_link",
      name: path,
      uri: pathToFileURL(absolute).href,
    });
  }
  return links;
}
