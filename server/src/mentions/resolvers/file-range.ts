/* Resolver for `@path:from-to` (and `@path:line`): those lines of a file,
   numbered, inlined — an ACP `resource_link` cannot carry a range, so the lines
   travel in the `<context>` block while the file still goes as a link
   (`mentions.ts`). The path is read the way a plain `@path` is linked: anywhere
   the machine can see, relative to the thread's directory. Binary and very large
   files answer nothing; a range past the end is cut to the file. */
import { readFile, stat } from "node:fs/promises";
import { mentionedPath } from "../../mentions.js";
import { parseRangeToken } from "../grammar.js";
import type { MentionBlock, MentionResolver } from "../types.js";

/** A source file past this is not one a person is quoting lines of. */
const MAX_BYTES = 2 * 1024 * 1024;
/** Lines one mention may inline, whatever the range asked for. */
const MAX_LINES = 600;

export const fileRangeResolver: MentionResolver = {
  kind: "file",
  async resolve(refs, ctx) {
    const blocks: MentionBlock[] = [];
    const claimed: string[] = [];
    for (const ref of refs) {
      const range = parseRangeToken(ref);
      if (!range) continue;
      const absolute = mentionedPath(range.path, ctx.cwd);
      try {
        const info = await stat(absolute);
        if (!info.isFile() || info.size > MAX_BYTES) continue;
        const bytes = await readFile(absolute);
        if (bytes.includes(0)) continue; // binary
        const lines = bytes.toString("utf8").split("\n");
        if (lines.at(-1) === "") lines.pop();
        if (range.from > lines.length) continue;
        const to = Math.min(range.to, lines.length, range.from + MAX_LINES - 1);
        const width = String(to).length;
        const body = lines
          .slice(range.from - 1, to)
          .map((line, i) => `${String(range.from + i).padStart(width)}| ${line}`)
          .join("\n");
        const cut = to < range.to && to < lines.length ? ` (cut at ${MAX_LINES} lines)` : "";
        blocks.push({
          ref,
          body: `${range.path} lines ${range.from}-${to} of ${lines.length}${cut}\n\n${body}`,
          readMore: `reading ${range.path}`,
        });
        claimed.push(ref);
      } catch {
        // Missing, unreadable: the token stays words, and `mentionLinks` decides on the file.
      }
    }
    return { blocks, claimed };
  },
};
