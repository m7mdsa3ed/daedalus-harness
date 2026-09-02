# Static site

Vite 8, TypeScript and Tailwind v4 — plain HTML pages, no framework.

```sh
pnpm install
pnpm dev          # Vite dev server (PORT, BASE_PATH honoured)
pnpm check        # tsc --noEmit
pnpm build        # → dist/ (every top-level *.html is a page)
pnpm start        # vite preview of dist/ on PORT (default 4173)
```

Environment: `PORT` (default 5173), `BASE_PATH` (URL prefix with leading and
trailing slash; unset means `/`). Build and preview with the same `BASE_PATH`.
