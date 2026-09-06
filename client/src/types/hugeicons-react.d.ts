import "@hugeicons/react"

/**
 * `@hugeicons/react` types `strokeWidth` as `number` only, but SVG's own
 * attribute — and every `React.ComponentProps<"svg">` spread that is passed
 * through `HugeiconsIcon` (e.g. the spinner) — is `string | number`. Widen the
 * prop here so the ui components keep their shadcn-clean prop spread instead
 * of omitting or casting at each call site.
 */
declare module "@hugeicons/react" {
  interface HugeiconsProps {
    strokeWidth?: number | string
  }
  interface HugeiconsIconProps {
    strokeWidth?: number | string
  }
}
