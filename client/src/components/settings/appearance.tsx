import * as React from "react"
import { useLocation } from "react-router"
import { MessagesSquare, Monitor, Moon, Palette, RotateCcw, SlidersHorizontal, Sun, type LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { ThemeGallery } from "@/components/theme-builder/gallery"
import { Switch } from "@/components/ui/switch"
import { getWindowMaterial, getWindowTranslucent, setWindowMaterial, setWindowTranslucent, type WindowMaterial } from "@/lib/desktop"
import { setLayoutOption, useLayoutOptions } from "@/lib/layout-options"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"
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
import { LayoutSettings } from "@/components/layout-settings"
import { ChoiceTiles, Group, PageHeader, Row, Segmented, TabBar } from "./primitives"
import { sectionMeta } from "./sections"

const PV_LINE = "h-1 rounded-full bg-muted-foreground/30"

/** Two schematics of the window: a rail with the content flush against it, or
    the content lifted onto a card with the page showing round it. */
const LAYOUTS: { value: "sidebar" | "inset"; label: string; hint: string; preview: React.ReactNode }[] = [
  {
    value: "sidebar",
    label: "Flush",
    hint: "A rail beside the content",
    preview: (
      <span aria-hidden className="flex h-14 overflow-hidden rounded-md border bg-background">
        <span className="flex w-1/4 flex-col gap-1 border-r bg-muted p-1.5">
          <span className={PV_LINE} /><span className={cn(PV_LINE, "w-2/3")} />
        </span>
        <span className="flex flex-1 flex-col gap-1 p-1.5">
          <span className={cn(PV_LINE, "w-3/4")} /><span className={cn(PV_LINE, "w-1/2")} />
        </span>
      </span>
    ),
  },
  {
    value: "inset",
    label: "Inset",
    hint: "The content floats as a card",
    preview: (
      <span aria-hidden className="flex h-14 gap-1 overflow-hidden rounded-md border bg-muted p-1">
        <span className="flex w-1/4 flex-col gap-1 p-0.5">
          <span className={PV_LINE} /><span className={cn(PV_LINE, "w-2/3")} />
        </span>
        <span className="flex flex-1 flex-col gap-1 rounded-sm border bg-background p-1.5">
          <span className={cn(PV_LINE, "w-3/4")} /><span className={cn(PV_LINE, "w-1/2")} />
        </span>
      </span>
    ),
  },
]

/** The mode's own swatch: what the app will look like, not a mark for it. */
const swatch = (className: string, Icon: LucideIcon) => (
  <span aria-hidden className={cn("flex h-14 items-center justify-center rounded-md border", className)}>
    <Icon className="size-5" />
  </span>
)

const MODES: { value: "light" | "dark" | "system"; label: string; hint: string; preview: React.ReactNode }[] = [
  { value: "light", label: "Light", hint: "Always light", preview: swatch("bg-zinc-100 text-zinc-700", Sun) },
  { value: "dark", label: "Dark", hint: "Always dark", preview: swatch("bg-zinc-800 text-zinc-200", Moon) },
  {
    value: "system",
    label: "System",
    hint: "Follows the system setting",
    preview: swatch("bg-[linear-gradient(90deg,#f4f4f5_50%,#27272a_50%)] text-zinc-500", Monitor),
  },
]

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
    <Group label="Desktop window" hint="The native window material. Takes effect after a restart.">
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
        <Segmented
          label="Window blur material"
          disabled={saving || material === null || translucent === false}
          options={MATERIALS}
          value={material ?? "acrylic"}
          onChange={(next) => void choose(next)}
        />
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
          <div className="mt-0.5 text-sm text-muted-foreground">{subtitle}</div>
        </div>
        <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 font-mono text-xs tabular-nums">
          {value}
          {unit}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0 pointer-coarse:size-11"
          title="Reset"
          aria-label={`Reset ${title}`}
          disabled={value === fallback}
          onClick={() => onChange(fallback)}
        >
          <RotateCcw />
        </Button>
      </div>
      <Slider
        aria-label={title}
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

/* Three separate questions - what a theme looks like, how this device lays
   itself out, how a transcript reads - so three places, not one long scroll,
   switched by the kit's TabBar. */
const TABS = [
  { id: "theme", label: "Theme", hint: "Mode and colors", icon: Palette },
  { id: "interface", label: "Interface", hint: "Sidebar, text, window", icon: SlidersHorizontal },
  { id: "transcript", label: "Transcript", hint: "How threads read", icon: MessagesSquare },
] as const

export function AppearancePage() {
  const meta = sectionMeta("appearance")
  const { theme, setTheme } = useTheme()
  const [fontSize, setFontSize] = useFontSize()
  const [scale, setScale] = useScale()
  const { sidebarVariant: variant } = useLayoutOptions()
  /* "Sidebar settings…" in the thread list's menu lands on the Interface tab. */
  const [tab, setTab] = React.useState<(typeof TABS)[number]["id"]>(
    useLocation().hash === "#interface" ? "interface" : "theme"
  )

  return (
    <>
      <PageHeader meta={meta} />
      <TabBar
        label="Appearance sections"
        items={TABS.map(({ id, label, hint, icon }) => ({ id, label, hint, icon }))}
        value={tab}
        onChange={(id) => setTab(id as (typeof TABS)[number]["id"])}
      />
      <div className="min-w-0">
          {tab === "theme" && (
            <>
              <Group label="Mode" hint="Light, dark, or whichever the system is using. This device only.">
                <ChoiceTiles label="Mode" value={theme} choices={MODES} onChange={setTheme} />
              </Group>
              <Group label="Color theme" hint="Saved on the server, so a theme you make follows you to every device.">
                <div className="-mx-3 @panel-sm:-mx-4">
                  <ThemeGallery />
                </div>
              </Group>
            </>
          )}

          {tab === "interface" && (
            <>
              <Group label="Sidebar layout" hint="How the sidebar and the content meet. This device only.">
                <ChoiceTiles
                  label="Sidebar layout"
                  value={variant}
                  choices={LAYOUTS}
                  onChange={(next) => setLayoutOption("sidebarVariant", next)}
                />
              </Group>
              <LayoutSettings scope="interface" />
              <Group label="Text and spacing" hint="Scale the whole app on this device.">
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
              {(window.desktop?.platform === "win32" || window.desktop?.platform === "darwin") && <DesktopWindowGroup />}
            </>
          )}

          {tab === "transcript" && <LayoutSettings />}
      </div>
    </>
  )
}
