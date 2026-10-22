/**
 * The wire contract between a client build and a server build.
 *
 * Both halves compile this file in — the client through the `@daedalus/compat`
 * alias, like `delivery.ts` — so each build freezes the values it was cut
 * with, and a client and a server from different commits can compare them at
 * runtime. One file is what keeps the two sides from disagreeing about the
 * same number.
 *
 * - `API` moves on a **breaking** wire change only (a route or field removed or
 *   reshaped, an event whose meaning changed). Expand, migrate, contract: the
 *   client learns to read both shapes first, then the server bumps `API`, and a
 *   later release drops the old reader and raises `MIN_SERVER_API`.
 * - An **additive** change (a new route, an optional field, a new event kind)
 *   is a `FEATURES` entry, never a bump. The client gates on the name.
 * - Semver (`meta.ts`) is for people and the changelog; nothing compares it.
 *
 * A server older than this file sends no `api` at all, and that reads as 0.
 */

/** The wire contract this build speaks. */
export const API = 1;

/** The oldest server this client build still drives. Raising it is a release
    note: it is the moment an outdated server stops being usable. */
export const MIN_SERVER_API = 0;

/** The oldest client this server build still serves. Clients block
    themselves; the server says the number and refuses nothing. */
export const MIN_CLIENT_API = 0;

/** What this server can do beyond the API baseline. Everything that existed
    when versioning began is the baseline and is not listed. */
export const FEATURES = [
] as const;

export type Feature = (typeof FEATURES)[number];
