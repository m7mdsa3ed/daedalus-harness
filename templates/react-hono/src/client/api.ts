import { hc } from "hono/client";
import type { AppType } from "../server.ts";

/** Typed client for the Hono API, prefixed with the base the app is served under. */
export const api = hc<AppType>(import.meta.env.BASE_URL);
