import { Counter } from "./Counter.tsx";

export function App() {
  return (
    <main className="min-h-screen bg-zinc-50 text-zinc-900 antialiased">
      <div className="mx-auto flex max-w-xl flex-col gap-8 px-6 py-16">
        <header className="flex flex-col gap-3">
          <p className="text-xs font-medium uppercase tracking-widest text-zinc-500">Starter</p>
          <h1 className="text-3xl font-semibold tracking-tight">React</h1>
          <p className="text-zinc-600">
            Vite 8, React 19 and Tailwind v4, no server. Edit{" "}
            <code className="rounded bg-zinc-200 px-1 py-0.5 text-sm">src/App.tsx</code> to get
            started.
          </p>
          <p className="text-sm text-zinc-500">
            Served under <code className="text-xs text-zinc-400">{import.meta.env.BASE_URL}</code>
          </p>
        </header>

        <Counter />
      </div>
    </main>
  );
}
