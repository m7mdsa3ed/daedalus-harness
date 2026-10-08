/* ── Where a library file's bytes live ──
   The library (`files.ts`) knows names, folders and mime types; it does not
   know disks. A provider is the one thing that does: put bytes, read them,
   release them. `local` is the default and the only one shipped — S3 or
   Cloudinary is a file beside this one that implements the interface and a line
   in `PROVIDERS`, and a file records which provider holds it, so providers can
   be mixed in one library and a default can change without moving anything. */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "../config.js";

export interface StorageProvider {
  id: string;
  /** Store `bytes` and answer the key to read them back with. Idempotent for
      the same `sha256`: content-addressed providers write it once. */
  put(input: { sha256: string; bytes: Buffer; mimeType: string; name: string }): Promise<string>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

const LOCAL_DIR = join(DATA_DIR, "files");

/** Content-addressed on disk, like the attachment store — but a directory of
    its own: the attachment sweep deletes bytes by hash when no *attachment*
    row references them, and would take a library file's with it. */
const local: StorageProvider = {
  id: "local",
  async put({ sha256, bytes }) {
    mkdirSync(LOCAL_DIR, { recursive: true });
    writeFileSync(join(LOCAL_DIR, sha256), bytes);
    return sha256;
  },
  async get(key) {
    return readFileSync(join(LOCAL_DIR, key));
  },
  async delete(key) {
    rmSync(join(LOCAL_DIR, key), { force: true });
  },
};

// ponytail: add `s3`/`cloudinary` here when one is needed — the interface above is the whole contract.
const PROVIDERS: Record<string, StorageProvider> = { local };

export const DEFAULT_PROVIDER = "local";

export function providerFor(id: string): StorageProvider {
  const found = PROVIDERS[id];
  if (!found) throw new Error(`storage provider "${id}" is not available on this server`);
  return found;
}
