import * as React from "react"
import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu"

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
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
  /** A nested list. Both menu families ship the submenu triple, so a group of
      related actions can be one row that opens sideways rather than five more
      rows in a list somebody has to read past. */
  | {
      type: "sub"
      label: string
      icon?: React.ReactNode
      items: MenuItemSpec[]
      disabled?: boolean
    }
  | { type: "separator" }

/** The flat reading of a spec list: submenus opened out in place, their rows
    kept in order. For a surface that draws the items itself and has no
    submenu of its own — the phone info card's action list. */
export function flattenMenuItems(items: MenuItemSpec[]): MenuItemSpec[] {
  return items.flatMap((item) => (item.type === "sub" ? flattenMenuItems(item.items) : [item]))
}

type MenuParts = {
  Item: React.ComponentType<{
    variant?: "default" | "destructive"
    disabled?: boolean
    onClick?: React.MouseEventHandler
    children?: React.ReactNode
  }>
  Separator: React.ComponentType
  /** The submenu triple, when the surface has one. Absent, a `sub` spec is
      *flattened* into its parent between separators rather than dropped: a
      menu that cannot nest must still offer every action it was handed. */
  Sub?: React.ComponentType<{ children?: React.ReactNode }>
  SubTrigger?: React.ComponentType<{
    disabled?: boolean
    children?: React.ReactNode
  }>
  SubContent?: React.ComponentType<{ children?: React.ReactNode }>
}

/** Render specs into whichever menu family's parts you hand it —
 *  `{ContextMenuItem, ContextMenuSeparator}` or `{DropdownMenuItem, DropdownMenuSeparator}`. */
export function renderMenuItems(items: MenuItemSpec[], parts: MenuParts) {
  const { Item, Separator, Sub, SubTrigger, SubContent } = parts
  return items.map((item, index) =>
    item.type === "separator" ? (
      <Separator key={index} />
    ) : item.type === "sub" ? (
      Sub && SubTrigger && SubContent ? (
        <Sub key={index}>
          <SubTrigger disabled={item.disabled}>
            {item.icon}
            {item.label}
          </SubTrigger>
          <SubContent>{renderMenuItems(item.items, parts)}</SubContent>
        </Sub>
      ) : (
        <React.Fragment key={index}>
          <Separator />
          {renderMenuItems(item.items, parts)}
          <Separator />
        </React.Fragment>
      )
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
        {renderMenuItems(items, {
          Item: ContextMenuItem,
          Separator: ContextMenuSeparator,
          Sub: ContextMenuSub,
          SubTrigger: ContextMenuSubTrigger,
          SubContent: ContextMenuSubContent,
        })}
      </ContextMenuContent>
    </ContextMenu>
  )
}
