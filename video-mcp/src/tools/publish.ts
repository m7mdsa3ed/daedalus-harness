import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { MAX_FILE_BYTES, harnessUrl } from "../config.js";
import { redact } from "../exec.js";
import { videoPaths } from "../storyboard.js";
import type { PublishArgs, PublishResult } from "../types.js";

interface Item {
  id: string;
  kind: string;
  name: string;
}

/** One call to the harness loopback; a non-2xx becomes an Error carrying the body text only. */
async function call(base: string, method: string, path: string, init: { body?: string | Uint8Array; headers?: Record<string, string> } = {}): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(base + path, { method, ...init });
  } catch (e) {
    throw new Error(redact(`the harness is not reachable at HARNESS_URL: ${e instanceof Error ? e.message : e}`));
  }
  const body = await res.text();
  if (!res.ok) {
    let msg = body;
    try {
      msg = (JSON.parse(body) as { error?: string }).error ?? body;
    } catch {}
    const err = new Error(redact(`${method} ${path.split("?")[0]} failed (${res.status}): ${msg.slice(0, 300)}`));
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return body ? JSON.parse(body) : {};
}

const json = { "Content-Type": "application/json" };
const listUrl = (parent: string | null) => `/api/files${parent ? `?parent=${encodeURIComponent(parent)}` : ""}`;
const items = async (base: string, parent: string | null) => ((await call(base, "GET", listUrl(parent))) as { items?: Item[] }).items ?? [];

/** Find-or-create the folder chain; returns the leaf id. */
async function ensureFolders(base: string, names: string[]): Promise<string | null> {
  let parent: string | null = null;
  for (const name of names) {
    const hit: Item | undefined = (await items(base, parent)).find((i) => i.kind === "folder" && i.name === name);
    parent = hit
      ? hit.id
      : ((await call(base, "POST", "/api/files/folder", { body: JSON.stringify({ parentId: parent, name }), headers: json })) as Item).id;
  }
  return parent;
}

export async function publishVideo(args: PublishArgs): Promise<PublishResult> {
  const p = videoPaths(args.cwd, args.name);
  const path = p.outFile(args.quality);
  const size = await stat(path).then((s) => s.size, () => {
    throw new Error(`${path} does not exist: run video_export with quality "${args.quality}" first`);
  });
  const base = (args.harnessUrl ?? harnessUrl())?.replace(/\/+$/, "");
  if (!base) {
    return { published: false, path, sizeBytes: size, message: `HARNESS_URL is not set, so the Files library is unavailable (it needs the harness). The video stays at ${path}.` };
  }
  if (size > MAX_FILE_BYTES) {
    return { published: false, path, sizeBytes: size, message: `${path} is ${(size / 1048576).toFixed(1)} MB; the Files library caps files at ${MAX_FILE_BYTES / 1048576} MB. Export quality "draft" or shorten the video, then publish again.` };
  }

  const names = ["Videos", ...(args.folder ?? args.name).split("/").map((s) => s.trim()).filter(Boolean)];
  const parent = await ensureFolders(base, names);
  const fileName = `${args.name}-${args.quality}.mp4`;

  // Re-publishing replaces, but only once the new copy is safely up: a failed upload must not cost the old one.
  // The server renames a clash to "name (2)", so remember the old rows first and delete exactly those afterwards.
  const old = (await items(base, parent)).filter((i) => i.kind !== "folder" && i.name === fileName);
  let row: Item;
  try {
    row = (await call(base, "POST", `/api/files${parent ? `?parent=${encodeURIComponent(parent)}` : ""}`, {
      body: new Uint8Array(await readFile(path)),
      headers: { "Content-Type": "video/mp4", "X-Filename": encodeURIComponent(fileName) },
    })) as Item;
  } catch (e) {
    if ((e as { status?: number }).status === 413) {
      return { published: false, path, sizeBytes: size, message: `the harness refused the upload as too large (25 MB cap). Export quality "draft" or shorten the video.` };
    }
    throw e;
  }
  const warnings: string[] = [];
  for (const o of old) {
    try {
      await call(base, "DELETE", `/api/files/${encodeURIComponent(o.id)}`);
    } catch (e) {
      warnings.push(`the new copy is up but the old "${fileName}" (${o.id}) could not be removed: ${(e as Error).message}`);
    }
  }
  // The upload landed as "name (2)" when the old copy was in the way; now that it is gone the name is free.
  if (!warnings.length && row.name !== fileName) {
    try {
      row = (await call(base, "PATCH", `/api/files/${encodeURIComponent(row.id)}`, { body: JSON.stringify({ name: fileName }), headers: json })) as Item;
    } catch (e) {
      warnings.push(`it is stored as "${row.name}" (renaming to "${fileName}" failed: ${(e as Error).message})`);
    }
  }
  const folder = names.join("/");
  return { published: true, path, sizeBytes: size, fileId: row.id, folder, message: `Uploaded ${basename(path)} as "${row.name}" to the Files library under ${folder} (open it at /api/files/${row.id}/content).${warnings.length ? ` Warning: ${warnings.join("; ")}` : ""}` };
}
