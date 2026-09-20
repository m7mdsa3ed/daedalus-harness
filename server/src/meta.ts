/* The app's version and changelog, served by GET /api/meta.
   The harness is one product deployed together (`pnpm pm2:start` builds the
   server, the client and the agent), so the version is one number — the root
   package.json's — and the changelog is one file beside it. Both are resolved
   off this module's own URL, so the answer is the same whether tsx is running
   src/ or node is running dist/. */
import { readFileSync, statSync } from "node:fs";

/* One release, its body kept as the markdown the file holds. The client renders
   it, so the file's own formatting — bold lead-ins, inline code, links, a table —
   reaches the dialog instead of being flattened into titles and bullets here. */
export type ChangelogEntry = { version: string; date: string | null; markdown: string };

const packageUrl = new URL("../../package.json", import.meta.url);
const changelogUrl = new URL("../../CHANGELOG.md", import.meta.url);

/* Parsed once per file mtime, not once per boot: the changelog is edited far
   more often than the server restarts, and a dev server should show an edit
   without one. */
let versionCache: { mtime: number; version: string } | null = null;
let changelogCache: { mtime: number; entries: ChangelogEntry[] } | null = null;

export function appVersion(): string {
  const mtime = statSync(packageUrl).mtimeMs;
  if (versionCache?.mtime === mtime) return versionCache.version;
  const pkg = JSON.parse(readFileSync(packageUrl, "utf8")) as { version?: string };
  versionCache = { mtime, version: pkg.version ?? "0.0.0" };
  return versionCache.version;
}

export function changelog(): ChangelogEntry[] {
  const mtime = statSync(changelogUrl).mtimeMs;
  if (changelogCache?.mtime === mtime) return changelogCache.entries;
  const text = readFileSync(changelogUrl, "utf8");
  const entries: ChangelogEntry[] = [];
  let entry: ChangelogEntry | null = null;
  let body: string[] = [];
  for (const line of text.split("\n")) {
    const heading = /^## \[([^\]]+)\](?: - (\S+))?/.exec(line);
    if (heading) {
      if (entry) {
        entry.markdown = body.join("\n").trim();
        entries.push(entry);
      }
      entry = { version: heading[1], date: heading[2] ?? null, markdown: "" };
      body = [];
      continue;
    }
    /* Everything above the first `## [version]` is the file's own preamble, not
       a release's, so it is dropped rather than handed to the first entry. */
    if (entry) body.push(line);
  }
  if (entry) {
    entry.markdown = body.join("\n").trim();
    entries.push(entry);
  }
  changelogCache = { mtime, entries };
  return entries;
}
