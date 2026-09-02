import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { Todos } from "./Todos.tsx";

type Health = "checking" | "ok" | "down";

export function App() {
  const [health, setHealth] = useState<Health>("checking");

  useEffect(() => {
    let cancelled = false;
    api.api.health
      .$get()
      .then((r) => r.json())
      .then((j) => !cancelled && setHealth(j.ok ? "ok" : "down"))
      .catch(() => !cancelled && setHealth("down"));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="min-h-screen bg-zinc-50 text-zinc-900 antialiased">
      <div className="mx-auto flex max-w-xl flex-col gap-8 px-6 py-16">
        <header className="flex flex-col gap-3">
          <p className="text-xs font-medium uppercase tracking-widest text-zinc-500">Starter</p>
          <h1 className="text-3xl font-semibold tracking-tight">React + Hono</h1>
          <p className="text-zinc-600">
            Vite 8, React 19 and Tailwind v4 in front, a Hono API behind, one process for both.
            Edit <code className="rounded bg-zinc-200 px-1 py-0.5 text-sm">src/client/App.tsx</code>{" "}
            to get started.
          </p>
          <p className="flex items-center gap-2 text-sm text-zinc-600">
            <span
              aria-hidden
              className={
                "inline-block size-2 rounded-full " +
                (health === "ok" ? "bg-emerald-500" : health === "down" ? "bg-red-500" : "bg-zinc-300")
              }
            />
            {health === "ok" ? "API reachable" : health === "down" ? "API unreachable" : "Checking API…"}
            <code className="text-xs text-zinc-400">{import.meta.env.BASE_URL}api/health</code>
          </p>
        </header>

        <Todos />
      </div>
    </main>
  );
}
