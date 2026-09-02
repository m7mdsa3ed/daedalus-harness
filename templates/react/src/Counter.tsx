import { useState } from "react";

export function Counter() {
  const [count, setCount] = useState(0);

  return (
    <section className="flex items-center justify-between rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
      <div>
        <h2 className="text-sm font-semibold text-zinc-700">Counter</h2>
        <p className="text-sm text-zinc-500">State lives in this component and survives hot reload.</p>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setCount((c) => c - 1)}
          className="size-9 rounded-md border border-zinc-300 text-lg leading-none hover:bg-zinc-100"
          aria-label="Decrement"
        >
          −
        </button>
        <span className="w-10 text-center font-mono text-lg tabular-nums">{count}</span>
        <button
          type="button"
          onClick={() => setCount((c) => c + 1)}
          className="size-9 rounded-md bg-zinc-900 text-lg leading-none text-white hover:bg-zinc-700"
          aria-label="Increment"
        >
          +
        </button>
      </div>
    </section>
  );
}
