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
      },
      // The agents are spawned children; let them die with the parent rather
      // than being reaped one restart later.
      kill_timeout: 5000,
      max_restarts: 10,
      time: true,
      out_file: "logs/out.log",
      error_file: "logs/error.log",
    },
  ],
};
