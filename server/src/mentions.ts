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
 * A mention may name **any path the machine can see**, not only one inside the
 * project's cwd: `~/`, an absolute path, or a relative one that climbs out with
 * `../`. The scope is the person's to choose — they may be pointing an agent at
 * a log file, a dot config or a sibling checkout — and it is no more reach than
 * the agent already has through its own tools, which run as this same user. What
 * is still required is that the path **exists**: prose is full of at-signs (an
 * email address, a handle, a decorator), and a token that names nothing real is
 * not a link, so the agent is never sent after a path nobody named.
 *
 * `@kind:ref` (`mentions/grammar.ts`) is the other shape a token takes: a typed
 * reference the composer expands into a `<context>` block at send. It is never
 * linked as a path.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type * as acp from "./acp.js";
import { MENTION_RE, TRAILING, parseKindToken, parseRangeToken } from "./mentions/grammar.js";

/* The token grammar lives in `mentions/grammar.ts` beside the `@kind:ref`
   half; these two stay exported from here for the callers that had them. */
export { MENTION_RE, TRAILING };

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

/** The absolute path a mention names: `~/x` is home-relative, `/x` (or a Windows
    drive) is absolute, and anything else is relative to the session's cwd. */
export function mentionedPath(raw: string, cwd: string): string {
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return resolve(homedir(), raw.slice(2));
  if (isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw)) return normalize(raw);
  return resolve(cwd, normalize(raw));
}

/**
 * The `resource_link` blocks for a prompt, in the order they were mentioned.
 *
 * A token becomes a link when it names a path that **exists**, anywhere on the
 * machine — see the header for why the old cwd-containment rule is gone. A path
 * that does not exist simply is not a link; the text still says what the user
 * typed.
 */
export function mentionLinks(cwd: string, text: string, claimed?: ReadonlySet<string>): acp.ContentBlock[] {
  let root: string;
  try {
    root = realpathSync(cwd);
  } catch {
    root = cwd;
  }
  const links: acp.ContentBlock[] = [];
  for (const path of mentionPaths(text)) {
    if (links.length >= MAX_LINKS) break;
    /* `@kind:ref` is a typed reference, never a path — whether or not a
       resolver took it (`claimed`, from `expandMentions`). */
    if (claimed?.has(path) || parseKindToken(path)) continue;
    let absolute = mentionedPath(path, root);
    try {
      realpathSync(absolute);
    } catch {
      /* `path:40-80` names lines of a file, and a link cannot carry lines: it
         points at the file, and the lines themselves are in the `<context>`
         block. A file that really is called `a.ts:40` was found above. */
      const range = parseRangeToken(path);
      if (!range) continue; // does not exist — nothing to link
      absolute = mentionedPath(range.path, root);
      try {
        realpathSync(absolute);
      } catch {
        continue;
      }
    }
    links.push({
      type: "resource_link",
      name: path,
      uri: pathToFileURL(absolute).href,
    });
  }
  return links;
}
