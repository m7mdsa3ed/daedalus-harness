import type * as acp from "@agentclientprotocol/sdk";

/**
 * Which branch an attachment takes on its way to the agent — one pure
 * function, called at both ends.
 *
 * A module of its own rather than a block in `protocol.ts`, and only because
 * of that file's own rule: it is type-only, imported by the browser as
 * `@daedalus/protocol` with nothing but types crossing, and this is a
 * *function* both ends have to run. The reason for sharing it is the one
 * `QuotaSnapshot` gives for living in protocol.ts at all — one declaration
 * imported by both ends, so the composer chip's note and the bridge's branch
 * cannot drift into disagreeing about the same file. Pure, with no Node built-in
 * and no DOM: it is bundled into the browser (alias `@daedalus/delivery`) and
 * imported by the server unchanged.
 *
 * What it intersects is three things, none of which knew about the other two
 * before this existed: the frame budget, the runtime, and the model.
 * `promptCapabilities` is the **runtime's**, advertised once at `initialize`
 * and identical for every thread on that binary — claude-agent-acp says
 * `image: true` because it can carry an image block, which says nothing about
 * the text-only gateway model the thread is actually spending. `modalities` is
 * the model's half, off the profile's own `ModelDef` — a field whose schema
 * comment said it was display-only and which this gives a reader.
 */

/** How an attachment reaches the agent. */
export type Delivery = "image" | "audio" | "resource" | "link";

/**
 * What `resolveDelivery` is deciding against.
 *
 * Three things intersect, and none of them knew about the other two before this
 * existed: the frame budget, the runtime, and the model. `promptCapabilities`
 * is the **runtime's**, advertised once at `initialize` and identical for every
 * thread on that binary — claude-agent-acp says `image: true` because it can
 * carry an image block, which says nothing about the text-only gateway model
 * the thread is actually spending. `modalities` is the model's half, off the
 * profile's own `ModelDef`.
 */
export interface DeliveryContext {
  /** The agent's, from `initialize`. Undefined = not yet known (a draft whose
      probe has not answered), which is read as "no inline blocks": a wrong
      guess here base64s an image into a frame the far end refuses. */
  caps: acp.PromptCapabilities | undefined;
  /** The model's input modalities, from `ModelDef.modalities`. */
  modalities: string[] | undefined;
  /** `profile.models.length > 0` — see the carve-out in rule 4. */
  hasCatalog: boolean;
  /** Bytes still spendable inline on this prompt. */
  inlineBudgetLeft: number;
  /** Pin this file to the link branch whatever the capabilities say. Exactly
      one caller: the "Retry as file paths" action. */
  forceLink?: boolean;
}

/**
 * Which branch one attachment takes — one pure function, called at both ends.
 *
 * It lives here, beside `AttachmentRef`, for the reason `QuotaSnapshot` does:
 * one declaration imported by both ends, so the composer chip's note and the
 * bridge's branch cannot drift into disagreeing about the same file.
 *
 * They are not the same *kind* of answer, though, and that asymmetry is the
 * point: the chip's is a **forecast**, and `attachmentBlocks` is what decides.
 * A message queued while an image-capable model was selected and drained
 * twenty minutes later, after a live model change, must be resolved against
 * the model it is actually being sent to — which is possible only because the
 * queue carries ids rather than blocks.
 *
 * Evaluated as vetoes, in order, falling through to the bridge's chain.
 */
export function resolveDelivery(
  mimeType: string,
  size: number,
  ctx: DeliveryContext,
): { delivery: Delivery; reason: string } {
  const type = (mimeType || "").toLowerCase();

  // 1. The retry variant's whole implementation.
  if (ctx.forceLink) {
    return { delivery: "link", reason: "sent as a file path — you asked for paths" };
  }

  /* 2. The budget. Not a 413: a path costs the frame nothing, so the user
        should only ever be refused for something the harness genuinely cannot
        deliver (see MAX_INLINE_PROMPT_BYTES). */
  if (size > ctx.inlineBudgetLeft) {
    return { delivery: "link", reason: "sent as a file path — too large to inline" };
  }

  if (type.startsWith("image/")) {
    /* 3. The agent. A negative here is authoritative: the runtime will drop or
          reject the block whatever the model could do with it. */
    if (!ctx.caps?.image) {
      return { delivery: "link", reason: "sent as a file path — this agent can't carry images" };
    }
    /* 4. The model. A catalog that lists modalities is a statement, and one
          that lists none is read the same conservative way — a gateway id
          models.dev has never heard of is not an invitation to guess. The one
          carve-out is a profile with no catalog at all, which is a different
          silence: `defaultProfileFor` ships none precisely to mean *defer to
          the agent*, and a Default thread is the agent running on its own
          subscription, which is exactly where `promptCapabilities` is
          authoritative. Without it, Claude Code on its own login — the most
          capable image path there is — would never inline an image. */
    if (ctx.hasCatalog && !(ctx.modalities ?? []).includes("image")) {
      return { delivery: "link", reason: "sent as a file path — this model can't read images" };
    }
    return { delivery: "image", reason: "sent to the model as an image" };
  }

  if (type.startsWith("audio/")) {
    if (!ctx.caps?.audio) {
      return { delivery: "link", reason: "sent as a file path — this agent can't carry audio" };
    }
    return { delivery: "audio", reason: "sent to the model as audio" };
  }

  /* Text-ish content the agent said it can take embedded. Whether this file
     really is text is NOT decided here — it needs the bytes (a NUL sniff), and
     this function is pure and runs in a browser too. The bridge makes the final
     call and falls back to a link; the forecast is deliberately the optimistic
     one, since the pessimistic branch is the same words either way. */
  if (ctx.caps?.embeddedContext && isTextish(type)) {
    return { delivery: "resource", reason: "sent to the model as text" };
  }

  return { delivery: "link", reason: "sent as a file path" };
}

/** A mime allowlist, and only half the test — see `resolveDelivery`'s last
    branch and `attachment-blocks.ts`, which also sniffs the bytes. A browser
    will label a binary `text/plain` given half a chance, and inlining one is a
    corrupted turn: strictly worse than a missing attachment, which is at least
    legible as a missing attachment. */
export function isTextish(mimeType: string): boolean {
  const type = (mimeType || "").toLowerCase();
  if (type.startsWith("text/")) return true;
  if (type === "application/json" || type === "application/xml") return true;
  return type.startsWith("application/") && (type.endsWith("+json") || type.endsWith("+xml"));
}

