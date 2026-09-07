/* The app's version and changelog, served by GET /api/meta.
   The harness is one product deployed together (`pnpm pm2:start` builds the
   server, the client and the agent), so the version is one number — the root
   package.json's — and the changelog is one file beside it. Both are resolved
   off this module's own URL, so the answer is the same whether tsx is running
   src/ or node is running dist/. */
import { readFileSync, statSync } from "node:fs";

export type ChangelogSection = { title: string; items: string[] };
export type ChangelogEntry = { version: string; date: string | null; sections: ChangelogSection[] };

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
  let section: ChangelogSection | null = null;
  for (const line of text.split("\n")) {
    const heading = /^## \[([^\]]+)\](?: - (\S+))?/.exec(line);
    if (heading) {
      entry = { version: heading[1], date: heading[2] ?? null, sections: [] };
      entries.push(entry);
      section = null;
      continue;
    }
    if (!entry) continue;
    const sub = /^### (.+)$/.exec(line);
    if (sub) {
      section = { title: sub[1].trim(), items: [] };
      entry.sections.push(section);
      continue;
    }
    const item = /^- (.+)$/.exec(line.trim());
    if (item && section) section.items.push(item[1].trim());
  }
  changelogCache = { mtime, entries };
  return entries;
}
