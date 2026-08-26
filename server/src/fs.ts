import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Directory listing for the client's path autocomplete. The cwd a project
// names lives on THIS machine, so the only way a browser can suggest one is to
// ask us. Deliberately unrestricted: the server already spawns arbitrary agent
// processes for whoever holds the bearer token, so hiding `ls` from that same
// token would be theater.

export interface FsEntry {
  name: string;
  type: "dir" | "file";
}

export interface FsListing {
  /** The resolved absolute path that was actually listed. */
  cwd: string;
  /** null at the filesystem root. */
  parent: string | null;
  entries: FsEntry[];
  /** True when the listing was cut at MAX_ENTRIES. */
  truncated: boolean;
}

const MAX_ENTRIES = 500;

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

/** List one directory, dirs first. "" lists the home directory. */
export function listDirectory(rawPath: string): FsListing {
  const path = rawPath.trim() === "" ? homedir() : resolve(rawPath.trim());
  let stat;
  try {
    stat = statSync(path); // follows symlinks — a linked dir lists like any other
  } catch {
    throw fail(404, `no such directory: ${path}`);
  }
  if (!stat.isDirectory()) throw fail(400, `not a directory: ${path}`);

  const entries: FsEntry[] = [];
  for (const dirent of readdirSync(path, { withFileTypes: true })) {
    let isDir = dirent.isDirectory();
    if (dirent.isSymbolicLink()) {
      try {
        isDir = statSync(join(path, dirent.name)).isDirectory();
      } catch {
        continue; // broken symlink — nothing to offer
      }
    }
    entries.push({ name: dirent.name, type: isDir ? "dir" : "file" });
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));

  const parent = dirname(path);
  return {
    cwd: path,
    parent: parent === path ? null : parent,
    entries: entries.slice(0, MAX_ENTRIES),
    truncated: entries.length > MAX_ENTRIES,
  };
}
