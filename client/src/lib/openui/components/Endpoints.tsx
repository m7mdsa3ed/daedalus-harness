/* ── Endpoints ──
   An API surface: method, path, what it does. The method is a chip in a fixed
   column so a list of routes scans down the paths. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { Box, META, PAD_ROW } from "@/lib/openui/kit"
import { RichText } from "@/lib/openui/rich-text"

const METHOD: Record<string, string> = {
  GET: "bg-success/12 text-success",
  POST: "bg-primary/12 text-primary",
  PUT: "bg-warning/15 text-warning",
  PATCH: "bg-warning/15 text-warning",
  DELETE: "bg-destructive/12 text-destructive",
}

export const Endpoints = defineComponent({
  name: "Endpoints",
  description: "API routes: each a method (GET, POST, ...), a path and an optional description.",
  props: z.object({
    items: z.array(z.object({ method: z.string(), path: z.string(), text: z.string().optional() })),
  }),
  component: ({ props }) => (
    <Box>
      <ul className="w-full divide-y divide-border/70">
        {(props.items ?? []).filter((item) => item?.path).map((item, index) => {
          const method = (item.method ?? "").toUpperCase()
          return (
            <li key={index} className={cn("min-w-0 space-y-1", PAD_ROW)}>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className={cn("rounded px-1.5 py-0.5 font-mono text-[0.6875rem] font-semibold", METHOD[method] ?? "bg-muted text-muted-foreground")}>{method}</span>
                <code className="min-w-0 font-mono text-[length:calc(var(--text-sm,0.875rem)-0.0625rem)] break-all text-foreground">{item.path}</code>
              </div>
              {item.text && <p className={cn(META, "text-pretty")}><RichText text={item.text} /></p>}
            </li>
          )
        })}
      </ul>
    </Box>
  ),
})
