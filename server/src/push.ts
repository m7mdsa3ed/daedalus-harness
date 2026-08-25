import { join } from "node:path";
import { DATA_DIR, readJson, writeJson, type FcmConfig } from "./config.js";

const TOKENS_PATH = join(DATA_DIR, "push-tokens.json");

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
    const tokens = readJson<string[]>(TOKENS_PATH, []);
    if (!tokens.includes(token)) writeJson(TOKENS_PATH, [...tokens, token]);
  }

  async send(title: string, body: string, data: Record<string, string>): Promise<void> {
    if (!this.fcm) return;
    if (!this.messaging) {
      const { initializeApp, cert } = await import("firebase-admin/app");
      const { getMessaging } = await import("firebase-admin/messaging");
      this.messaging = getMessaging(initializeApp({ credential: cert(this.fcm.serviceAccountPath) }));
    }
    const tokens = readJson<string[]>(TOKENS_PATH, []);
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
    if (dead.length) writeJson(TOKENS_PATH, tokens.filter((t) => !dead.includes(t)));
  }
}
