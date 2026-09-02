# Working in this project

This is a static site: plain HTML pages styled with Tailwind v4, served and built
by Vite 8, with one TypeScript entry. It runs inside Daedalus Harness "Build"
mode, which shows the live site next to the chat.

## The dev server is not yours

- The harness starts and supervises the dev server (`pnpm dev`) with hot reload.
  **Never start, stop or restart it, and never run `vite` or `pnpm dev` yourself.**
- `PORT` and `BASE_PATH` come from the harness. **Never change the port, host or
  base path**, and do not add `server.hmr`/`server.ws` settings to `vite.config.ts`.
- The site is served under a prefix (`BASE_PATH`, e.g. `/preview/<key>/<id>/`).
  **Links between pages are relative** (`./about.html`, `./`), never `/about.html`.
  In `src/main.ts` use `import.meta.env.BASE_URL` (ends with `/`) if you need
  the prefix. Vite rewrites `<script src>`, `<link href>` and `<img src>` in
  the HTML for you.

## Layout

- Every top-level `*.html` is a page (`vite.config.ts` finds them). Add
  `pricing.html` and it is served at `./pricing.html` and built.
- `src/main.ts` is loaded by every page; guard page-specific code on the
  element it needs. `src/style.css` is the only stylesheet (Tailwind).
- No framework, no router: this template is for pages, not apps. If the user
  needs interactive state beyond a few handlers, say the "React" starter fits
  better instead of building a framework by hand.

## Before you finish

1. Run `pnpm check` (`tsc --noEmit`) and fix everything it reports.
2. Commit with a short message after each completed change (`git add -A && git commit -m "..."`).
3. Do not add dependencies you do not need; if you add one, `pnpm add` it (the
   harness already ran `pnpm install`).
