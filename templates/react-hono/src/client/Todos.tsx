import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";

interface Todo {
  id: number;
  text: string;
  done: boolean;
}

export function Todos() {
  const [todos, setTodos] = useState<Todo[] | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const r = await api.api.todos.$get();
      setTodos(await r.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function add(e: FormEvent) {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    setText("");
    await api.api.todos.$post({ json: { text: value } });
    await refresh();
  }

  async function toggle(id: number) {
    await api.api.todos[":id"].$patch({ param: { id: String(id) } });
    await refresh();
  }

  async function remove(id: number) {
    await api.api.todos[":id"].$delete({ param: { id: String(id) } });
    await refresh();
  }

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
      <h2 className="text-sm font-semibold text-zinc-700">Todos (in-memory example)</h2>

      <form onSubmit={add} className="flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add something…"
          aria-label="New todo"
          className="min-w-0 flex-1 rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500 focus:ring-2 focus:ring-zinc-200"
        />
        <button
          type="submit"
          className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50"
          disabled={!text.trim()}
        >
          Add
        </button>
      </form>

      {error && <p className="text-sm text-red-600">Could not load todos: {error}</p>}
      {todos === null && !error && <p className="text-sm text-zinc-400">Loading…</p>}
      {todos && todos.length === 0 && <p className="text-sm text-zinc-400">Nothing yet.</p>}

      {todos && todos.length > 0 && (
        <ul className="divide-y divide-zinc-100">
          {todos.map((t) => (
            <li key={t.id} className="flex items-center gap-3 py-2">
              <input
                type="checkbox"
                checked={t.done}
                onChange={() => toggle(t.id)}
                aria-label={`Mark "${t.text}" ${t.done ? "not done" : "done"}`}
                className="size-4 accent-zinc-900"
              />
              <span className={"flex-1 text-sm " + (t.done ? "text-zinc-400 line-through" : "")}>
                {t.text}
              </span>
              <button
                type="button"
                onClick={() => remove(t.id)}
                className="text-xs text-zinc-400 hover:text-red-600"
                aria-label={`Delete "${t.text}"`}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
