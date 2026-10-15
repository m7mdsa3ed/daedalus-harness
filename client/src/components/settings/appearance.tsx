import * as React from "react"
import { Monitor, Moon, PanelLeft, PanelLeftDashed, RotateCcw, Sun } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { ThemeGallery } from "@/components/theme-builder/gallery"
import { Switch } from "@/components/ui/switch"
import { getWindowMaterial, getWindowTranslucent, setWindowMaterial, setWindowTranslucent, type WindowMaterial } from "@/lib/desktop"
import { setSidebarLayout, useSidebarLayout } from "@/lib/sidebar-layout"
import { toast } from "@/lib/toast"
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
import { ViewSettings } from "@/components/session-settings"
import { PageHeader, Group, Row } from "./primitives"
import { sectionMeta } from "./sections"

const LAYOUTS = [
  { value: "sidebar", label: "Flush", hint: "A rail beside the content", icon: PanelLeft },
  { value: "inset", label: "Inset", hint: "The content floats as a card", icon: PanelLeftDashed },
] as const

const MODES = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const

const MATERIALS: { value: WindowMaterial; label: string }[] = [
  { value: "acrylic", label: "Acrylic" },
  { value: "mica", label: "Mica" },
]

function DesktopWindowGroup() {
  const isWindows = window.desktop?.platform === "win32"
  const [translucent, setTranslucent] = React.useState<boolean | null>(null)
  const [material, setMaterial] = React.useState<WindowMaterial | null>(null)
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    void getWindowTranslucent().then(setTranslucent, () => setTranslucent(true))
  }, [])

  const toggle = async (next: boolean) => {
    const error = await setWindowTranslucent(next)
    if (error) {
      toast.error("Couldn't save window transparency", { description: error })
      return
    }
    setTranslucent(next)
    toast("Window transparency saved", { description: "Restart Daedalus to apply the change." })
  }

  React.useEffect(() => {
    if (!isWindows) return
    let active = true
    void getWindowMaterial().then(
      (value) => active && setMaterial(value),
      (error: unknown) => {
        if (!active) return
        setMaterial("acrylic")
        toast.error("Couldn't read window material", {
          description: error instanceof Error ? error.message : String(error),
        })
      }
    )
    return () => {
      active = false
    }
  }, [])

  const choose = async (next: WindowMaterial) => {
    if (next === material) return
    setSaving(true)
    try {
      const error = await setWindowMaterial(next)
      if (error) {
        toast.error("Couldn't save window material", { description: error })
        return
      }
      setMaterial(next)
      toast("Window material saved", { description: "Restart Daedalus to apply the change." })
    } catch (error) {
      toast.error("Couldn't save window material", {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Group label="Desktop window">
      <Row
        title="Transparent sidebar and tab strip"
        subtitle="Let the desktop show through the sidebar and tab strip. Turn off for a solid window. Restart Daedalus for changes to take effect."
      >
        <Switch
          checked={translucent ?? true}
          disabled={translucent === null}
          onCheckedChange={(next) => void toggle(next)}
          aria-label="Transparent sidebar and tab strip"
        />
      </Row>
      {isWindows && <Row
        title="Window blur"
        subtitle="Choose the native Windows backdrop. Mica may appear nearly solid on some Windows builds."
      >
        <div className="flex gap-1 rounded-lg border bg-muted/30 p-1" role="group" aria-label="Window blur material">
          {MATERIALS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              aria-pressed={material === value}
              disabled={saving || material === null || translucent === false}
              onClick={() => void choose(value)}
              className={cn(
                "min-h-9 rounded-md px-3 text-xs font-medium transition-colors disabled:opacity-50",
                material === value ? "bg-accent text-accent-foreground shadow-sm" : "text-muted-foreground hover:bg-accent/50"
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </Row>}
    </Group>
  )
}

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
    <div className="py-3">
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
  const { variant } = useSidebarLayout()

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
      <Group label="Sidebar layout">
        <div className="grid grid-cols-2 gap-2 p-2">
          {LAYOUTS.map(({ value, label, hint, icon: Icon }) => (
            <button
              key={value}
              type="button"
              onClick={() => setSidebarLayout("variant", value)}
              aria-pressed={variant === value}
              className={cn(
                "flex flex-col items-center gap-1.5 rounded-lg border border-transparent px-3 py-4 text-xs font-medium transition-colors",
                variant === value
                  ? "border-border bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50"
              )}
            >
              <Icon className="size-4.5" />
              {label}
              <span className="text-[11px] font-normal text-muted-foreground">{hint}</span>
            </button>
          ))}
        </div>
      </Group>
      <Group label="Color theme">
        <ThemeGallery />
      </Group>
      {(window.desktop?.platform === "win32" || window.desktop?.platform === "darwin") && <DesktopWindowGroup />}
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
      <Group label="Transcript" hint="How threads are drawn on this device. Display only — nothing here changes what the agent sees.">
        <ViewSettings />
      </Group>
    </>
  )
}
