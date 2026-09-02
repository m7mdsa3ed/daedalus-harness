/* The workers VS Code asks for by label. `new URL(…, import.meta.url)` inside
   `new Worker` is the shape Vite rewrites into a built worker chunk, so the
   package paths are literal here rather than in a table it could not see. */
type WorkerFactory = () => Worker

const factories: Record<string, WorkerFactory> = {
  TextEditorWorker: () =>
    new Worker(new URL("monaco-editor/esm/vs/editor/editor.worker.js", import.meta.url), {
      type: "module",
    }),
  TextMateWorker: () =>
    new Worker(new URL("@codingame/monaco-vscode-textmate-service-override/worker", import.meta.url), {
      type: "module",
    }),
  LocalFileSearchWorker: () =>
    new Worker(new URL("@codingame/monaco-vscode-search-service-override/worker", import.meta.url), {
      type: "module",
    }),
}

let installed = false

export function installWorkers(): void {
  if (installed) return
  installed = true
  ;(globalThis as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
    getWorker(_id: string, label: string): Worker {
      const make = factories[label]
      if (!make) throw new Error(`No worker registered for "${label}"`)
      return make()
    },
  }
}
