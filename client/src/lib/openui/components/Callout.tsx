/* ── Callout ──
   A boxed aside. `Notice` is the app's one alert box and its four tones are
   semantic there, so this passes the tone through rather than painting its own;
   what it adds is that a generated view's aside is compact and wraps. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { Notice } from "@/components/notice"
import { RichText } from "@/lib/openui/rich-text"

export const Callout = defineComponent({
  name: "Callout",
  description: "A boxed aside: info, warn, error or neutral, with an optional title.",
  props: z.object({
    text: z.string(),
    tone: z.enum(["neutral", "info", "warn", "error"]).optional(),
    title: z.string().optional(),
  }),
  component: ({ props }) => (
    <Notice
      className="w-full min-w-0 [&_p]:break-words [&_button]:max-w-full [&_button]:whitespace-normal [&_button]:break-words"
      tone={props.tone ?? "neutral"}
      size="md"
      title={props.title}
    >
      <span className="break-words">
        <RichText text={props.text} />
      </span>
    </Notice>
  ),
})
