import { Monitor, Moon, RotateCcw, Sun } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { ThemeGallery } from "@/components/theme-builder"
import {
  FONT_SIZE_DEFAULT,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  SCALE_DEFAULT,
  SCALE_MAX,
  SCALE_MIN,
  useFontSize,
  useScale,
  useTheme,
} from "@/lib/theme"
import { cn } from "@/lib/utils"
import { PageHeader, Group } from "./primitives"
import { sectionMeta } from "./sections"

const MODES = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const


/** Slider + live value + reset, on its own row so the track gets real width. */
function SliderRow({
  title,
  subtitle,
  value,
  onChange,
  min,
  max,
  step = 1,
  fallback,
  unit,
}: {
  title: string
  subtitle: string
  value: number
  onChange: (value: number) => void
  min: number
  max: number
  step?: number
  fallback: number
  unit: string
}) {
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{title}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">{subtitle}</div>
        </div>
        <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 font-mono text-xs tabular-nums">
          {value}
          {unit}
        </span>
        <Button
          variant="ghost"
          size="icon-lg"
          className="shrink-0"
          title="Reset"
          disabled={value === fallback}
          onClick={() => onChange(fallback)}
        >
          <RotateCcw />
        </Button>
      </div>
      <Slider
        className="mt-3"
        value={value}
        min={min}
        max={max}
        step={step}
        onValueChange={(next) => onChange(Array.isArray(next) ? next[0] : next)}
      />
    </div>
  )
}

export function AppearancePage() {
  const meta = sectionMeta("appearance")
  const { theme, setTheme } = useTheme()
  const [fontSize, setFontSize] = useFontSize()
  const [scale, setScale] = useScale()

  return (
    <>
      <PageHeader meta={meta} />
      <Group label="Mode">
        <div className="grid grid-cols-3 gap-2 p-2">
          {MODES.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              onClick={() => setTheme(value)}
              aria-pressed={theme === value}
              className={cn(
                "flex flex-col items-center gap-1.5 rounded-lg border border-transparent px-3 py-4 text-xs font-medium transition-colors",
                theme === value
                  ? "border-border bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50"
              )}
            >
              <Icon className="size-4.5" />
              {label}
            </button>
          ))}
        </div>
      </Group>
      <Group label="Color theme">
        <ThemeGallery />
      </Group>
      <Group label="Density">
        <SliderRow
          title="Font size"
          subtitle="Root text size — the whole layout scales from it."
          value={fontSize}
          onChange={setFontSize}
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          fallback={FONT_SIZE_DEFAULT}
          unit="px"
        />
        <SliderRow
          title="Spacing"
          subtitle="Paddings, gaps and control heights, without touching text size."
          value={scale}
          onChange={setScale}
          min={SCALE_MIN}
          max={SCALE_MAX}
          step={5}
          fallback={SCALE_DEFAULT}
          unit="%"
        />
      </Group>
    </>
  )
}
