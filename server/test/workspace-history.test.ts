import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceSnapshotService } from "../src/workspace-history.js";

const root = mkdtempSync(join(tmpdir(), "daedalus-history-"));
const outside = join(root, "outside.txt");
const workspace = join(root, "workspace");
mkdirSync(workspace);
writeFileSync(outside, "outside\n");
writeFileSync(join(workspace, ".hidden"), "hidden\n");
writeFileSync(join(workspace, "binary.bin"), Buffer.from([0, 1, 2, 255]));
writeFileSync(join(workspace, "delete.txt"), "restore me\n");
writeFileSync(join(workspace, "mode.sh"), "#!/bin/sh\n");
chmodSync(join(workspace, "mode.sh"), 0o755);
symlinkSync(outside, join(workspace, "outside-link"));

const snapshots = new WorkspaceSnapshotService();
const snapshot = snapshots.capture(workspace);
writeFileSync(join(workspace, ".hidden"), "changed\n");
rmSync(join(workspace, "binary.bin"));
rmSync(join(workspace, "delete.txt"));
rmSync(join(workspace, "outside-link"));
writeFileSync(join(workspace, "created.txt"), "remove me\n");
snapshots.restore(workspace, snapshot.id);

assert.equal(readFileSync(join(workspace, ".hidden"), "utf8"), "hidden\n");
assert.deepEqual([...readFileSync(join(workspace, "binary.bin"))], [0, 1, 2, 255]);
assert.equal(readFileSync(join(workspace, "delete.txt"), "utf8"), "restore me\n");
assert.equal(existsSync(join(workspace, "created.txt")), false);
assert.equal(lstatSync(join(workspace, "mode.sh")).mode & 0o777, 0o755);
assert.equal(readlinkSync(join(workspace, "outside-link")), outside);
assert.equal(readFileSync(outside, "utf8"), "outside\n", "an external symlink target is never followed");

const git = (args: string[]) => execFileSync("git", ["-C", workspace, ...args], { encoding: "utf8" }).trim();
git(["init"]);
git(["config", "user.email", "history@example.test"]);
git(["config", "user.name", "History Test"]);
writeFileSync(join(workspace, "tracked.txt"), "committed\n");
git(["add", "."]);
git(["commit", "-m", "base"]);
writeFileSync(join(workspace, "tracked.txt"), "staged\n");
git(["add", "tracked.txt"]);
writeFileSync(join(workspace, "tracked.txt"), "working\n");
const head = git(["rev-parse", "HEAD"]);
const gitSnapshot = snapshots.capture(workspace);

git(["commit", "-am", "later"]);
writeFileSync(join(workspace, "tracked.txt"), "different\n");
git(["add", "tracked.txt"]);
snapshots.restore(workspace, gitSnapshot.id);

assert.equal(git(["rev-parse", "HEAD"]), head);
assert.equal(readFileSync(join(workspace, "tracked.txt"), "utf8"), "working\n");
assert.equal(git(["show", ":tracked.txt"]), "staged");

// Ignored paths are outside the snapshot in both directions: never captured,
// and never deleted by a restore that did not capture them.
mkdirSync(join(workspace, "node_modules", "left-pad"), { recursive: true });
writeFileSync(join(workspace, "node_modules", "left-pad", "index.js"), "module.exports = 1\n");
writeFileSync(join(workspace, "ignored.log"), "noise\n");
writeFileSync(join(workspace, ".gitignore"), "ignored.log\nnode_modules/\n");
git(["add", ".gitignore"]);
const scoped = snapshots.capture(workspace);
assert.equal(
  scoped.entries.some((entry) => entry.path.startsWith("node_modules") || entry.path === "ignored.log"),
  false,
  "gitignored paths are not captured",
);
writeFileSync(join(workspace, "tracked.txt"), "after\n");
writeFileSync(join(workspace, "ignored.log"), "more noise\n");
snapshots.restore(workspace, scoped.id);
assert.equal(readFileSync(join(workspace, "tracked.txt"), "utf8"), "working\n");
assert.equal(readFileSync(join(workspace, "ignored.log"), "utf8"), "more noise\n", "a restore leaves ignored files alone");
assert.equal(existsSync(join(workspace, "node_modules", "left-pad", "index.js")), true);

const tiny = new WorkspaceSnapshotService(8);
assert.throws(
  () => tiny.capture(workspace),
  (error: Error) => error.name === "WorkspaceSnapshotLimitError" && /checkpoint limit/.test(error.message),
  "an oversized workspace throws the named limit error",
);

rmSync(root, { recursive: true, force: true });
console.log("workspace-history: passed");
