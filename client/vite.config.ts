import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import path from "path";
import { BOOT_COLORS } from "./src/lib/boot-colors";
import pkg from "./package.json" with { type: "json" };

// `pnpm dev:tunnel` sets this. Behind a Cloudflare quick tunnel the page is
// https on port 443, but Vite's HMR client derives its socket from the dev
// server's own port — it would try wss://<tunnel host>:5173 and never connect.
const tunnelled = !!process.env.DAEDALUS_TUNNEL;

/** Substitutes the boot colours into index.html, which is static and cannot
    import them. Placeholders rather than literals so the file holds no guess of
    its own — see src/lib/boot-colors.ts for why there is exactly one. */
function bootColors(): Plugin {
  return {
    name: "daedalus-boot-colors",
    transformIndexHtml: {
      order: "pre",
      handler: (html) =>
        html
          .replaceAll("%BOOT_LIGHT%", BOOT_COLORS.light)
          .replaceAll("%BOOT_DARK%", BOOT_COLORS.dark),
    },
  };
}

/* ── The IDE's CSS ──
   VS Code ships its stylesheets as plain `.css` imports meant to be injected
   by its own loader, into the workbench container. Vite would otherwise put
   them in the page's global stylesheet, where they restyle the whole app —
   `?inline` hands each one back as a string instead, which is what the
   library's `injectCss` expects. Only files under the vendor packages: the
   app's own CSS is Tailwind's and must stay a real stylesheet. */
function vscodeCssAsString(): Plugin {
  return {
    name: "daedalus-vscode-css-as-string",
    enforce: "pre",
    async resolveId(source, importer, options) {
      const resolved = await this.resolve(source, importer, options);
      if (
        resolved &&
        !resolved.id.endsWith("?inline") &&
        /node_modules[\\/](?:\.pnpm[\\/][^\\/]+[\\/]node_modules[\\/])?(?:@codingame[\\/]monaco-vscode|vscode|monaco-editor).*\.css$/.test(
          resolved.id
        )
      ) {
        return { ...resolved, id: `${resolved.id}?inline` };
      }
      return undefined;
    },
  };
}

/* The workbench is a hundred-odd megabytes of source across a thousand
   modules. Vite pre-bundles dependencies, but these are many small packages
   that resolve into each other, and without naming them Chrome hangs on the
   first cold load walking the graph. */
const IDE_PACKAGES = [
  "@codingame/monaco-vscode-api",
  "@codingame/monaco-vscode-api/extensions",
  "@codingame/monaco-vscode-api/monaco",
  "@codingame/monaco-vscode-api/workbench",
  "monaco-editor",
  "vscode",
  "vscode/localExtensionHost",
];

// https://vite.dev/config/
/* The persisted query cache's buster (see src/lib/queries/persist.ts): a
   dumped cache is only safe to rehydrate into the build that wrote it, since
   what a query's data *is* can change with a release. One value per build, so
   a deploy drops every device's dump exactly once. */
const buildId = `${pkg.version}-${Date.now().toString(36)}`;

export default defineConfig({
  define: {
    __QUERY_CACHE_BUSTER__: JSON.stringify(buildId),
  },
  build: {
    /* The workbench is authored against a modern baseline and the extension
       host worker is an ES module. */
    target: "esnext",
    chunkSizeWarningLimit: 8000,
  },
  worker: { format: "es" },
  optimizeDeps: {
    include: IDE_PACKAGES,
  },
  plugins: [
    vscodeCssAsString(),
    react(),
    tailwindcss(),
    bootColors(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      // lib/pwa.ts calls `registerSW` from `virtual:pwa-register` itself, so
      // that it can also schedule the periodic update check; injecting a
      // second registration script would just register the same worker twice.
      injectRegister: null,
      // "prompt", not "autoUpdate": an update swaps the precache, so taking it
      // silently can break a lazy import in the page that is already running,
      // and it reloads the tab out from under a turn in progress. lib/pwa.ts
      // offers it instead and applies it when the user says so.
      registerType: "prompt",
      devOptions: {
        enabled: true,
        type: "module",
        navigateFallback: "index.html",
      },
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2,webmanifest}"],
        /* The workbench is deliberately NOT precached. It is a dozen megabytes
           reached only by opening the IDE panel, and precaching it would make
           the install an order of magnitude bigger for every reader who only
           reads transcripts. Offline, the IDE is the one surface that does not
           open; everything else still does.

           It is excluded by size rather than by path: rolldown does not honour
           a `chunkFileNames` callback in this Vite, so the workbench's chunks
           are named like any other and there is no `assets/ide/` prefix to
           match. The threshold sits above the app's own largest chunk and far
           below the workbench's, and `maximumFileSizeToCacheInBytes` alone
           would only warn — this drops them from the manifest quietly.

           A grammar or a wasm blob under the threshold may still be precached;
           that is a few hundred kilobytes and it is not worth a second rule to
           chase. */
        globIgnores: ["**/assets/boot-*.js"],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
      manifest: {
        // `id` is what a browser uses to decide whether an install is THIS app
        // rather than a new one; without it the identity is start_url, so a
        // change to that orphans everyone's installed copy.
        id: "/",
        name: "Daedalus",
        short_name: "Daedalus",
        description: "AI agent harness",
        lang: "en",
        dir: "ltr",
        display: "standalone",
        // Browsers that don't do `standalone` fall to `minimal-ui` (a back
        // button and a URL bar) rather than all the way back to a browser tab.
        display_override: ["standalone", "minimal-ui"],
        orientation: "any",
        scope: "/",
        start_url: "/",
        // The service worker focuses an open window instead of opening a second
        // one when a notification is clicked; without this, tapping the app icon
        // does NOT do the same thing, and the user ends up with two instances of
        // a single-instance app. Same rule, both entry points.
        launch_handler: { client_mode: "navigate-existing" },
        // The one thing "new thread" needs is a route — see actions.newDraftThread,
        // which mints the id client-side — so the long-press menu can reach it
        // without the app having to be running first.
        shortcuts: [
          { name: "New thread", short_name: "New", url: "/?new=1" },
        ],
        categories: ["developer", "productivity", "utilities"],
        /* The same colour the boot splash and the theme-color meta use, so the
           install's launch screen and the app's first paint agree.

           Dark, unconditionally, because a manifest cannot carry two: there is
           no `prefers-color-scheme` in it and no way to follow a palette chosen
           at runtime. It covers only the moment before the page loads — after
           that the meta tag wins, and ThemeProvider keeps that pointed at the
           live `--background`. So a light-mode user sees this for one frame of
           launch, which is the trade for a dark-mode user not seeing white. */
        theme_color: BOOT_COLORS.dark,
        background_color: BOOT_COLORS.dark,
        icons: [
          // A maskable icon alone gets letterboxed where the platform wants a
          // plain one, so both purposes are listed rather than shared.
          { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          {
            src: "/icon-512-maskable.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
    }),
  ],
  server: {
    // Reach the dev server by whatever name the machine has — a LAN IP from a
    // phone, a tunnel hostname, a container alias. Vite otherwise answers a
    // Host header it does not recognise with "Blocked request".
    //
    // This turns off Vite's DNS-rebinding protection: while `pnpm dev` runs, a
    // page on any site the browser visits can point a hostname it controls at
    // this port and read what the dev server serves. That is source, not
    // secrets — the server URL and token live in localStorage on whatever
    // origin you actually use — but it is why this is a dev-only setting and
    // not something to carry into a deployment.
    allowedHosts: true,
    // No point allowing every hostname if the socket only answers on loopback.
    host: true,
    // The tunnel terminates TLS and forwards to plain http here, so the port
    // and scheme the browser must use are the tunnel's, not ours.
    ...(tunnelled ? { hmr: { protocol: "wss" as const, clientPort: 443 } } : {}),
  },
  // `vite preview` has its own host allowlist, separate from `server`. It is
  // what `pnpm dev:serve --preview` runs behind Tailscale Serve, which forwards
  // the tailnet hostname in Host — unlisted, that is answered with "Blocked
  // request" and the phone sees nothing. Same dev-only reasoning as `server`.
  preview: {
    allowedHosts: true,
    host: true,
  },
  resolve: {
    /* One copy of each, however many of the forty-odd override packages
       depend on them: two `vscode` modules would be two extension APIs, and
       two `monaco-editor`s two sets of global services. */
    dedupe: ["vscode", "monaco-editor", "@codingame/monaco-vscode-api"],
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      /* The one module the browser imports from the server for its *value*
         rather than its types. `@daedalus/protocol` stays type-only (it is
         mapped in tsconfig alone, and deliberately not here); this is the pure
         function both ends have to run so a chip's forecast and the bridge's
         branch cannot disagree about the same file. */
      "@daedalus/delivery": path.resolve(import.meta.dirname, "../server/src/delivery.ts"),
    },
  },
});
