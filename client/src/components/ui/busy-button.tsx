import * as React from "react"
import { cn } from "cn"

import { Button as RegistryButton } from "@/components/ui/button"

/**
 * The harness's button: the registry's `Button` plus the one prop it does not
 * carry — `loading`.
 *
 * This lives in its own file on purpose. `ui/button.tsx` is a shadcn registry
 * file, and a `shadcn add`/refresh rewrites it whole: that is exactly how the
 * `loading` prop was lost, taking the build with it across 34 importing files.
 * A regeneration now costs nothing, because nothing outside the registry file
 * is ever rewritten. Same bargain as `hooks/use-device.ts` versus shadcn's own
 * `hooks/use-mobile.ts`.
 *
 * `loading` says two things at once, which is why call sites do not spell it:
 * the button is not pressable again until the work lands (`disabled`), and it
 * keeps full strength while its disabled siblings dim — that contrast is what
 * says which one is running. The travelling arc is `.harness-busy-ring`.
 */
function Button({
  className,
  disabled,
  loading,
  ...props
}: React.ComponentProps<typeof RegistryButton> & { loading?: boolean }) {
  return (
    <RegistryButton
      className={cn(className, loading && "harness-busy-ring disabled:opacity-100")}
      disabled={disabled || loading}
      {...props}
    />
  )
}

export { Button }
