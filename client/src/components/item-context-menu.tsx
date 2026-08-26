import * as React from "react"
import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu"

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"

/**
 * One item shape for a row's actions, wherever they show up. A surface builds
 * a MenuItemSpec[] once and renders it into its hover dropdown AND its
 * right-click menu — the two Base UI families share item props, so the same
 * array feeds both and the lists cannot drift apart.
 */
export type MenuItemSpec =
  | {
      type?: "item"
      label: string
      icon?: React.ReactNode
      onClick: () => void
      destructive?: boolean
      disabled?: boolean
    }
  | { type: "separator" }

type MenuParts = {
  Item: React.ComponentType<{
    variant?: "default" | "destructive"
    disabled?: boolean
    onClick?: React.MouseEventHandler
    children?: React.ReactNode
  }>
  Separator: React.ComponentType
}

/** Render specs into whichever menu family's parts you hand it —
 *  `{ContextMenuItem, ContextMenuSeparator}` or `{DropdownMenuItem, DropdownMenuSeparator}`. */
export function renderMenuItems(items: MenuItemSpec[], { Item, Separator }: MenuParts) {
  return items.map((item, index) =>
    item.type === "separator" ? (
      <Separator key={index} />
    ) : (
      <Item
        key={index}
        variant={item.destructive ? "destructive" : undefined}
        disabled={item.disabled}
        onClick={item.onClick}
      >
        {item.icon}
        {item.label}
      </Item>
    )
  )
}

/**
 * Right-click (or long-press) menu on an existing element. The trigger merges
 * onto `children` via Base UI's `render`, so no wrapper DOM is added — pass
 * the element that already is the row.
 */
export function ItemContextMenu({
  items,
  children,
  ...triggerProps
}: {
  items: MenuItemSpec[]
  children: React.ReactElement<Record<string, unknown>>
} & Omit<ContextMenuPrimitive.Trigger.Props, "render" | "children">) {
  if (items.length === 0) return children
  return (
    <ContextMenu>
      <ContextMenuTrigger render={children} {...triggerProps} />
      <ContextMenuContent>
        {renderMenuItems(items, { Item: ContextMenuItem, Separator: ContextMenuSeparator })}
      </ContextMenuContent>
    </ContextMenu>
  )
}
