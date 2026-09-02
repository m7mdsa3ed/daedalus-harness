/**
 * The URL prefix the app is served under, normalised to start and end with "/".
 * Comes from the `BASE_PATH` environment variable (set by the harness); unset or
 * "/" means the root. Shared by vite.config.ts and src/server.ts.
 */
export function basePath(): string {
  const raw = (process.env.BASE_PATH ?? "").trim();
  if (raw === "" || raw === "/") return "/";
  return `/${raw.replace(/^\/+|\/+$/g, "")}/`;
}

export function listenPort(fallback: number): number {
  const n = Number(process.env.PORT);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
