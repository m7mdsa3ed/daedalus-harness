# Working in this project

This is a React 19 + Vite 8 + Tailwind v4 app with a Hono API, all served by one
process. It runs inside Daedalus Harness "Build" mode, which shows the live app
next to the chat.

## The dev server is not yours

- The harness starts and supervises the dev server (`pnpm dev`) with hot reload.
  **Never start, stop or restart it, and never run `vite` or `pnpm dev` yourself.**
- `PORT` and `BASE_PATH` come from the harness. **Never change the port, host or
  base path**, and do not add `server.hmr`/`server.ws` settings to `vite.config.ts`.
- The app is served under a prefix (`BASE_PATH`, e.g. `/preview/<key>/<id>/`).
  Never hardcode absolute URLs. In client code use `import.meta.env.BASE_URL`
  (already ends with `/`); the typed API client in `src/client/api.ts` is
  prefixed for you. If you add a router, give it `basename: import.meta.env.BASE_URL`.

## Layout

- `src/server.ts` — the Hono app. Every API route lives under `/api` and
  `GET /api/health` must keep answering `{ ok: true }`. `AppType` is exported for
  the client. In production the same file serves `dist/`.
- `src/client/` — React app (`main.tsx`, `App.tsx`, `api.ts`, `index.css`).
  Put each component in its own file under `src/client/`.
- `index.html` — the shell; Vite rewrites its URLs under `BASE_PATH`.
- Styling is Tailwind utilities; `src/client/index.css` is the only stylesheet.

## Before you finish

1. Run `pnpm check` (TypeScript over client and server) and fix everything it reports.
2. Commit with a short message after each completed change (`git add -A && git commit -m "..."`).
3. Do not add dependencies you do not need; if you add one, `pnpm add` it (the
   harness already ran `pnpm install`).
