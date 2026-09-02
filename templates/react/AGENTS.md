# Working in this project

This is a React 19 + Vite 8 + Tailwind v4 single-page app (no server). It runs
inside Daedalus Harness "Build" mode, which shows the live app next to the chat.

## The dev server is not yours

- The harness starts and supervises the dev server (`pnpm dev`) with hot reload.
  **Never start, stop or restart it, and never run `vite` or `pnpm dev` yourself.**
- `PORT` and `BASE_PATH` come from the harness. **Never change the port, host or
  base path**, and do not add `server.hmr`/`server.ws` settings to `vite.config.ts`.
- The app is served under a prefix (`BASE_PATH`, e.g. `/preview/<key>/<id>/`).
  Never hardcode absolute URLs: use `import.meta.env.BASE_URL` (already ends
  with `/`) for links and fetches. If you add a router, give it
  `basename: import.meta.env.BASE_URL`.
- There is no backend. Data lives in component state or `localStorage`; if the
  user needs an API, say so instead of inventing one (the "React + Hono"
  template has one under `/api`).

## Layout

- `src/main.tsx` mounts `src/App.tsx`. Put each component in its own file under `src/`.
- `index.html` — the shell; Vite rewrites its URLs under `BASE_PATH`.
- Styling is Tailwind utilities; `src/index.css` is the only stylesheet.

## Before you finish

1. Run `pnpm check` (`tsc --noEmit`) and fix everything it reports.
2. Commit with a short message after each completed change (`git add -A && git commit -m "..."`).
3. Do not add dependencies you do not need; if you add one, `pnpm add` it (the
   harness already ran `pnpm install`).
