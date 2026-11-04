/* ── Keys ──
   Keyboard chords: the action at the start, the keycaps at the end. The cap is
   the app's own `Kbd`, so a shortcut in a drawn answer and the same shortcut in
   the shortcuts help are the same keycap. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { Box, PAD_ROW } from "@/lib/openui/kit"
import { Kbd, KbdGroup } from "@/components/ui/kbd"

export const Keys = defineComponent({
  name: "Keys",
  description: "Keyboard shortcuts: each entry is a list of keys and what the chord does.",
  props: z.object({
    items: z.array(z.object({ keys: z.array(z.string()), action: z.string() })),
  }),
  component: ({ props }) => (
    <Box>
      <div className="w-full divide-y divide-rule">
        {props.items.map((item, index) => (
          <div key={index} className={`flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 ${PAD_ROW}`}>
            <span className="min-w-0 flex-1 basis-40 text-[length:calc(var(--text-sm,0.875rem)-0.0625rem)] leading-snug break-words text-foreground">{item.action}</span>
            <KbdGroup className="ms-auto min-w-0 max-w-full flex-wrap">
              {item.keys.map((key, i) => (
                <Kbd key={i}>{key}</Kbd>
              ))}
            </KbdGroup>
          </div>
        ))}
      </div>
    </Box>
  ),
})
