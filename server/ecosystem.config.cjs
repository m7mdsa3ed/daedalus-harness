/* pm2 runs the *built* server: `pnpm build` then `pm2 start ecosystem.config.cjs`.
   Not `tsx src/index.ts` — a process manager that restarts on crash should not
   be recompiling on every boot.

   The port is the env override in config.ts, not data/config.json: `pnpm dev`
   reads the same file, and hardcoding 4001 there would move dev too. Everything
   else — token, FCM, sessionIdleMinutes — still comes from that file, so the
   pm2 process and a dev one are the same server on a different port.

   One instance only: the agent processes, the WebSocket peers and the SQLite
   file are all owned by this process; cluster mode would fork peers that cannot
   see each other's bridges. */
/* `.env` beside this file, if present, feeds the app's env (KEY=VALUE lines;
   Node's own parser). It is read at `pm2 startOrReload` time, so changing it
   needs `pnpm pm2:start` (or `pm2 restart ... --update-env`), not a bare restart. */
const fileEnv = (() => {
  try {
    return require("node:util").parseEnv(require("node:fs").readFileSync(require("node:path").join(__dirname, ".env"), "utf8"));
  } catch {
    return {};
  }
})();

module.exports = {
  apps: [
    {
      name: "daedalus-server",
      script: "dist/index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        DAEDALUS_PORT: "4001",
        ...fileEnv,
      },
      // With DAEDALUS_SANDBOX unset (direct) the agents are children and die
      // with the parent. With DAEDALUS_SANDBOX=hosted they run under detached
      // hosts and SURVIVE a restart/stop (the next server adopts them); end
      // them with `pnpm pm2:kill-agents`. The time here only bounds the
      // server's own drain (journal flush, adopt state).
      kill_timeout: 5000,
      /* pm2 walks the descendant tree on stop/restart by default, and a detached
         agent host is still the server's child (detached changes the process
         group, not the parent pid). Without this the hosted agents die with the
         server and adoption has nothing to find. Harmless under direct: the
         server's own shutdown already retires its children. */
      treekill: false,
      max_restarts: 10,
      time: true,
      out_file: "logs/out.log",
      error_file: "logs/error.log",
    },
  ],
};
