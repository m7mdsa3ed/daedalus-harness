import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type * as acp from "./acp.js";

import { MAX_INLINE_PROMPT_BYTES, attachmentPath, listAttachments, readAttachment } from "./attachments.js";
import { isTextish, resolveDelivery, type Delivery } from "./delivery.js";
import type { AttachmentRef } from "./protocol.js";

/**
 * An attachment, as the agent finally sees it.
 *
 * This is the one place a decision about a file is *binding*: the composer's
 * chip is a forecast, and this is what actually happens. That distinction is
 * load-bearing for the queue — a message queued while an image-capable model
 * was selected and drained twenty minutes later, after a live model change,
 * has to be resolved against the model it is being sent to, which is possible
 * only because the queue carries ids rather than blocks.
 *
 * A fallback chain, not a switch. `resolveDelivery` (delivery.ts) picks the
 * branch from the runtime's `promptCapabilities`, the model's modalities and
 * the frame budget; anything it vetoes lands one step lower, and the bottom
 * step — materialise and link — always works.
 *
 * Whatever branch a file takes, it is also **named in the prose**. That is the
 * `mentions.ts` bargain restated for the same two reasons: the text is what
 * every runtime reads without being taught anything, and it is what keeps the
 * transcript saying what the user actually sent.
 */

/** Where a materialised file lands, relative to the cwd. `.daedalus/` because
    `.claude/` is the agent's and this is the harness's. */
const DIR = ".daedalus/attachments";

/** How much of a file the NUL sniff reads. A binary that is text for its first
    8KB and not afterwards is a file nobody attaches by accident. */
const SNIFF_BYTES = 8 * 1024;

/** Past this an "embedded text resource" is a paste, not an attachment — and
    it is competing for the same frame the images are in. */
const MAX_EMBEDDED_TEXT_BYTES = 512 * 1024;

export interface BlocksResult {
  blocks: acp.ContentBlock[];
  /** Appended to the prompt text — the paths and the `[attached: …]` names. */
  textSuffix: string;
  /** One line per file, for the log. A silent degrade with no trace is the
      failure mode lib/errors.ts exists to prevent, and it is worse here than
      elsewhere: the user's evidence for "the model read my screenshot" is that
      nothing went wrong. */
  notes: { name: string; delivery: Delivery; reason: string }[];
}

export function attachmentBlocks(opts: {
  refs: AttachmentRef[];
  caps: acp.PromptCapabilities | undefined;
  cwd: string;
  modalities: string[] | undefined;
  hasCatalog: boolean;
  forceLink?: boolean;
}): BlocksResult {
  const result: BlocksResult = { blocks: [], textSuffix: "", notes: [] };
  if (opts.refs.length === 0) return result;

  /* The refs on the wire are what the client last saw; the rows are what is on
     disk now. A row that has since gone (a purge racing a queued drain) simply
     is not sent — the text still says what the user typed. */
  const rows = listAttachments(opts.refs.map((ref) => ref.id));
  /* Spent as it goes, and threaded down rather than checked once: the third
     image is the one that has to degrade, not all three or none. Server-side
     from the constant rather than trusted from the client. */
  let budget = MAX_INLINE_PROMPT_BYTES;
  const lines: string[] = [];

  for (const row of rows) {
    const ref: AttachmentRef = {
      id: row.id,
      name: row.name,
      mimeType: row.mimeType,
      size: row.size,
    };
    const decision = resolveDelivery(row.mimeType, row.size, {
      caps: opts.caps,
      modalities: opts.modalities,
      hasCatalog: opts.hasCatalog,
      inlineBudgetLeft: budget,
      forceLink: opts.forceLink,
    });

    const bytes = readAttachment(row);
    if (!bytes) {
      // The row outlived its file (a restored backup). Say so in the prose
      // rather than pretending the attachment was never there.
      result.notes.push({ name: ref.name, delivery: "link", reason: "bytes are missing" });
      lines.push(`[attached: ${ref.name} — the harness no longer has this file]`);
      continue;
    }

    let delivery = decision.delivery;
    let reason = decision.reason;

    /* "Text-ish" is a real test, not a vibe, and only half of it can be done
       without the bytes: a browser will label a binary `text/plain` given half
       a chance, and inlining one is a corrupted turn — strictly worse than a
       missing attachment, which is at least legible as a missing attachment. */
    if (delivery === "resource" && !isEmbeddableText(row.mimeType, bytes)) {
      delivery = "link";
      reason = "sent as a file path — it does not read as text";
    }

    switch (delivery) {
      case "image":
        result.blocks.push({ type: "image", data: bytes.toString("base64"), mimeType: row.mimeType });
        budget -= row.size;
        lines.push(`[attached: ${ref.name}]`);
        break;
      case "audio":
        result.blocks.push({ type: "audio", data: bytes.toString("base64"), mimeType: row.mimeType });
        budget -= row.size;
        lines.push(`[attached: ${ref.name}]`);
        break;
      case "resource": {
        const uri = pathToFileURL(attachmentPath(row.sha256)).href;
        result.blocks.push({
          type: "resource",
          resource: { uri, mimeType: row.mimeType, text: bytes.toString("utf8") },
        });
        budget -= row.size;
        lines.push(`[attached: ${ref.name}]`);
        break;
      }
      case "link": {
        /* The bottom step, and the one `application/pdf` always lands on — worth
           saying where somebody would otherwise "fix" it: the Anthropic API
           takes PDF documents, but **ACP has no `document` content block**, and
           a path is what an agent with a Read tool actually wants.

           The path in the *text* is what makes this work at all: a runtime that
           ignores `resource_link` still reads the path, which is the entire
           finding mentions.ts was written around. */
        const rel = materialise(opts.cwd, row.id, ref.name, bytes);
        if (!rel) {
          result.notes.push({ name: ref.name, delivery: "link", reason: "could not be written to the workspace" });
          lines.push(`[attached: ${ref.name} — could not be placed in the workspace]`);
          break;
        }
        result.blocks.push({
          type: "resource_link",
          name: ref.name,
          uri: pathToFileURL(join(opts.cwd, rel)).href,
          mimeType: row.mimeType,
          size: row.size,
        });
        lines.push(`[attached: ${ref.name} — @${rel}]`);
        break;
      }
    }
    result.notes.push({ name: ref.name, delivery, reason });
  }

  if (lines.length > 0) result.textSuffix = `\n\n${lines.join("\n")}`;
  return result;
}

/** The mime allowlist AND a NUL sniff AND a size cap — see `isTextish`. */
function isEmbeddableText(mimeType: string, bytes: Buffer): boolean {
  if (!isTextish(mimeType)) return false;
  if (bytes.length > MAX_EMBEDDED_TEXT_BYTES) return false;
  return !bytes.subarray(0, SNIFF_BYTES).includes(0);
}

/**
 * Write a file into the workspace and answer its cwd-relative path.
 *
 * This writes user bytes into a directory that is very often a git worktree, so
 * creating `.daedalus/` also writes a `.gitignore` holding `*` into it — the
 * standard one-line trick — because a screenshot turning up in somebody's
 * commit is a worse failure than a stale file, and it is the one the sweep
 * cannot prevent.
 */
function materialise(cwd: string, id: string, name: string, bytes: Buffer): string | null {
  try {
    const dir = join(cwd, DIR);
    mkdirSync(dir, { recursive: true });
    const ignore = join(cwd, ".daedalus", ".gitignore");
    if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
    // Prefixed with the id, so two files called `screenshot.png` are two files
    // and the sweep can still tell what it wrote.
    const file = `${id}-${name}`;
    writeFileSync(join(dir, file), bytes);
    return `${DIR}/${file}`;
  } catch {
    return null;
  }
}

/**
 * Take back what nobody references any more.
 *
 * The same rule `materializeWorkspace` uses for skills and commands — it sweeps
 * what it did not write — with the ids of the live threads' claimed
 * attachments standing in for a manifest, since the filename carries the id.
 * `.daedalus/` is not covered by the project's own gitignore (we write one),
 * and this is the only thing keeping the directory from growing.
 */
export function sweepMaterialisedAttachments(cwd: string, keepIds: Iterable<string>): void {
  const dir = join(cwd, DIR);
  if (!existsSync(dir)) return;
  const keep = new Set(keepIds);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    // `<uuid>-<name>`: the id is everything before the 37th character.
    const id = entry.slice(0, 36);
    if (keep.has(id)) continue;
    try {
      rmSync(join(dir, entry), { force: true });
    } catch {
      // A file already gone is the state we were asking for.
    }
  }
}
