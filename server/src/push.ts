import { isAbsolute, join } from "node:path";
import { inArray } from "drizzle-orm";
import { DATA_DIR, type FcmConfig } from "./config.js";
import { db, pushTokens } from "./db/index.js";

const listTokens = (): string[] => db.select({ token: pushTokens.token }).from(pushTokens).all().map((r) => r.token);

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

  async send(title: string, body: string, data: Record<string, string>): Promise<void> {
    if (!this.fcm) return;
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
    const result = await this.messaging.sendEachForMulticast({
      tokens,
      notification: { title, body },
      data,
    });
    const dead = tokens.filter((_, i) => {
      const code = result.responses[i].error?.code;
      return code === "messaging/registration-token-not-registered" || code === "messaging/invalid-argument";
    });
    if (dead.length) db.delete(pushTokens).where(inArray(pushTokens.token, dead)).run();
  }
}
