/* ── Link and Links ──
   The address allowlist and the one anchor live in `rich-text.tsx` with the
   inline markdown that can also draw a link, so a `Rows` href and a
   `[words](https://…)` in a table cell are the same rule twice, not two rules.

   A list of links is not a frame: the rows are a divided list at the page's
   own margin, because inside a `Card` a second inset would be one padding too
   many and the dividers would stop short of both. */
import { z } from "zod/v4"
import { ArrowUpRight } from "lucide-react"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { BODY, LIST_ROW, META } from "@/lib/openui/kit"
import { LinkAnchor, linkTarget } from "@/lib/openui/rich-text"

/** One link: its words, then the host that says where a click goes. */
export const Link = defineComponent({
  name: "Link",
  description: "One link: the words to read and the address they open.",
  props: z.object({
    label: z.string(),
    href: z.string(),
  }),
  component: ({ props }) => {
    const url = linkTarget(props.href)
    // The host is the consent line, and only worth saying when the words do not
    // already carry it. An address that is not a link is still shown, as text.
    const address = (url && !props.label.includes(url.host) ? url.host : null) ?? (url ? null : props.href)
    return (
      <p className={cn(BODY, "min-w-0")}>
        {url ? <LinkAnchor url={url}>{props.label}</LinkAnchor> : props.label}
        {address && <span className={cn(META, "ms-2 break-all")}>{address}</span>}
      </p>
    )
  },
})

/** Several links: a hairline between them, the facts beside the words. */
export const Links = defineComponent({
  name: "Links",
  description: "A list of links, each with an optional line of facts: references, tickets, pages.",
  props: z.object({
    items: z.array(z.object({ label: z.string(), href: z.string(), meta: z.string().optional() })),
  }),
  component: ({ props }) => (
    <div className="w-full divide-y divide-border/70">
      {props.items.map((item, index) => {
        const url = linkTarget(item.href)
        const line = [item.meta, url?.host ?? item.href].filter(Boolean).join(" · ")
        const body = (
          <>
            <span className="min-w-0 flex-1 space-y-0.5">
              <span
                className={cn(
                  "block min-w-0 text-[length:calc(var(--text-sm,0.875rem)-0.0625rem)] leading-snug font-medium break-words",
                  url ? "text-primary" : "text-foreground"
                )}
              >
                {item.label}
              </span>
              <span className={cn(META, "block truncate")} title={item.href}>
                {line}
              </span>
            </span>
            {url && <ArrowUpRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />}
          </>
        )
        return url ? (
          <a
            key={index}
            href={url.href}
            target="_blank"
            rel="noreferrer noopener"
            title={url.href}
            className={cn(LIST_ROW, "flex w-full items-start gap-3 hover:bg-muted/60")}
          >
            {body}
          </a>
        ) : (
          <div key={index} className={cn(LIST_ROW, "flex items-start gap-3")}>
            {body}
          </div>
        )
      })}
    </div>
  ),
})
