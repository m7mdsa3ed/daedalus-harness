import { isAbsolute, join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { DATA_DIR, type FcmConfig } from "./config.js";
import { db, pushTokens, routineRuns, routines } from "./db/index.js";

const listTokens = (): string[] => db.select({ token: pushTokens.token }).from(pushTokens).all().map((r) => r.token);

/** FCM's own cap on one `sendEachForMulticast` call. */
const MULTICAST_LIMIT = 500;

/** An hour. Long enough to survive a tunnel through a lift, short enough that
    nothing arrives about a turn the user has long since read. */
const TTL_SECONDS = 60 * 60;

/**
 * A Web Push `Topic` for one kind of event on one thread.
 *
 * The header is spec-constrained — at most 32 URL-safe base64 characters — and
 * neither half of the natural key fits it (a title is prose, a session id is a
 * 36-character UUID), so it is hashed rather than truncated: a truncated UUID
 * would still collide, and a collision here silently *drops* a notification.
 * FNV-1a because this needs to be stable and cheap, not unguessable.
 */
function webpushTopic(title: string, sessionId: string | undefined): string {
  const input = `${title}:${sessionId ?? ""}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * The routine a thread is a run of, or null for an ordinary thread.
 *
 * Two queries rather than a join, which is what the rest of the server does.
 * Failures are swallowed: a notification that cannot name its routine is worth
 * strictly more than no notification at all.
 */
function routineNameFor(sessionId: string | undefined): string | null {
  if (!sessionId) return null;
  try {
    const run = db
      .select({ routineId: routineRuns.routineId })
      .from(routineRuns)
      .where(eq(routineRuns.sessionId, sessionId))
      .get();
    if (!run) return null;
    const routine = db
      .select({ name: routines.name })
      .from(routines)
      .where(eq(routines.id, run.routineId))
      .get();
    return routine?.name ?? null;
  } catch {
    return null;
  }
}

export class Push {
  private messaging: import("firebase-admin/messaging").Messaging | null = null;

  constructor(private fcm?: FcmConfig) {}

  get enabled(): boolean {
    return this.fcm !== undefined;
  }

  /** Public config the web client needs to register for push. */
  webConfig() {
    return this.fcm ? { firebase: this.fcm.webConfig, vapidKey: this.fcm.vapidKey } : null;
  }

  registerToken(token: string): void {
    // Re-registering the same device is the common case, not an error.
    db.insert(pushTokens).values({ token, createdAt: Date.now() }).onConflictDoNothing().run();
  }

  /** Stop sending to one device. The counterpart to `registerToken`: without it
      turning notifications off in the client is a preference nothing acts on. */
  unregisterToken(token: string): void {
    db.delete(pushTokens).where(eq(pushTokens.token, token)).run();
  }

  async send(rawTitle: string, body: string, data: Record<string, string>): Promise<void> {
    if (!this.fcm) return;
    /* A routine run is an ordinary thread as far as every hook that raises a
       notification is concerned, so all three of them ("Permission needed",
       "The agent has a question", "Turn finished") arrive here spelled for a
       thread somebody opened — while the whole point of a routine is that
       nobody did. The name leads, because a phone truncates a title's tail and
       *which* routine is what is being scanned for; the event follows and is
       repeated in the body anyway.

       Done here rather than at the call site so it covers all three hooks at
       once — the unattended "Permission needed" is the one that most needs to
       say whose question it is — and so the `Topic` below is hashed from the
       rewritten title, which keeps two routines' notifications from collapsing
       onto each other while a phone is unreachable. */
    const routine = routineNameFor(data.sessionId);
    const title = routine ? `${routine} — ${rawTitle}` : rawTitle;
    if (!this.messaging) {
      const { initializeApp, cert } = await import("firebase-admin/app");
      const { getMessaging } = await import("firebase-admin/messaging");
      // A relative serviceAccountPath is relative to the server directory
      // ("data/…"), not to whatever cwd the process happened to start with.
      const path = this.fcm.serviceAccountPath;
      this.messaging = getMessaging(
        initializeApp({ credential: cert(isAbsolute(path) ? path : join(DATA_DIR, "..", path)) }),
      );
    }
    const tokens = listTokens();
    if (tokens.length === 0) return;
    const dead: string[] = [];
    // `sendEachForMulticast` rejects outright above MULTICAST_LIMIT, so an
    // install that crossed it would lose every notification rather than some.
    for (let i = 0; i < tokens.length; i += MULTICAST_LIMIT) {
      const batch = tokens.slice(i, i + MULTICAST_LIMIT);
      // Data-only, deliberately. A `notification` block is displayed by whatever
      // FCM code is running in the service worker, and there is none there any
      // more (client/src/sw.ts owns the `push` event itself so that it needs no
      // Firebase config to survive a worker restart). Sending both would mean two
      // notifications on any client that still has the old worker installed; the
      // title and body ride in `data` instead, which is the contract sw.ts reads.
      const result = await this.messaging.sendEachForMulticast({
        tokens: batch,
        data: { ...data, title, body },
        webpush: {
          headers: {
            // These are turn-completions and questions the agent is blocked on —
            // delaying them to save a radio wake-up defeats the point.
            Urgency: "high",
            // ...and by the same argument they stop being worth delivering.
            // Without a TTL, FCM holds a message for four weeks: a phone that
            // was off overnight would wake to yesterday's finished turns.
            TTL: String(TTL_SECONDS),
            // Collapse a backlog the same way the worker's `tag` collapses one
            // on screen: while a device is unreachable the push service keeps
            // only the newest message per topic, so coming back online means
            // the current state of each thread, not forty rounds of history.
            Topic: webpushTopic(title, data.sessionId),
          },
        },
      });
      for (const [n, response] of result.responses.entries()) {
        const code = response.error?.code;
        if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-argument") {
          dead.push(batch[n]);
        }
      }
    }
    if (dead.length) db.delete(pushTokens).where(inArray(pushTokens.token, dead)).run();
  }
}
