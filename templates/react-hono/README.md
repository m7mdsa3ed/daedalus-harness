# React + Hono

Vite 8, React 19, Tailwind v4 and a Hono API served from one process.

```sh
pnpm install
pnpm dev          # Vite + Hono dev server (PORT, BASE_PATH honoured)
pnpm check        # tsc --noEmit
pnpm build        # static client → dist/
pnpm start        # production: Hono serves dist/ and /api (Node 22.18+)
```

Environment: `PORT` (default 5173), `BASE_PATH` (URL prefix with leading and
trailing slash; unset means `/`). Build and start with the same `BASE_PATH`.
