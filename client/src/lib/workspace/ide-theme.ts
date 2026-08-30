/* The app's palette, restated as VS Code settings.

   VS Code cannot be told "look like the page", but it can be told the colour
   of every surface, one key at a time (`workbench.colorCustomizations`), on
   top of a base theme that supplies what the palette does not name — syntax
   colours above all. So this maps the palette tokens the theme builder edits
   onto the workbench's chrome: the page to the editor, the sidebar to the
   sidebar and its bars, the popover to every floating widget, the primary to
   buttons and badges. Plain hex, composited over the background where a token
   carries alpha, because the workbench takes nothing else.

   It reads the *computed* tokens off the root, so a custom palette and a
   built-in one come out the same way, and it has to run after the theme
   provider has swapped the root's attributes — the panel defers it a tick for
   that reason. */
import { composite, parseColor, THEME_TOKENS } from "@/lib/custom-themes"

export interface IdeTheme {
  colorTheme: string
  colorCustomizations: Record<string, string>
}

function currentTokens(): Record<string, string> {
  const computed = getComputedStyle(document.documentElement)
  const background = parseColor(computed.getPropertyValue("--background"))
  const tokens: Record<string, string> = {}
  for (const token of THEME_TOKENS) {
    const raw = computed.getPropertyValue(`--${token}`).trim()
    if (!raw) continue
    const { hex, alpha } = parseColor(raw)
    tokens[token] = composite(hex, alpha, background.hex)
  }
  return tokens
}

export function ideThemeFor(mode: "light" | "dark"): IdeTheme {
  const t = currentTokens()
  const page = t.background
  const text = t.foreground
  const side = t.sidebar ?? t.card ?? page
  const sideText = t["sidebar-foreground"] ?? text
  const sideBorder = t["sidebar-border"] ?? t.border
  const pop = t.popover ?? t.card ?? page
  const popText = t["popover-foreground"] ?? text
  const border = t.border
  const muted = t.muted
  const mutedText = t["muted-foreground"]
  const accent = t.accent ?? muted
  const accentText = t["accent-foreground"] ?? text
  const primary = t.primary
  const primaryText = t["primary-foreground"]
  const ring = t.ring ?? primary

  const colors: Record<string, string | undefined> = {
    // The page.
    "editor.background": page,
    "editor.foreground": text,
    "editorLineNumber.foreground": mutedText,
    "editorGroup.border": border,
    "editorGroupHeader.tabsBackground": side,
    "editorGroupHeader.tabsBorder": border,
    "tab.activeBackground": page,
    "tab.activeForeground": text,
    "tab.inactiveBackground": side,
    "tab.inactiveForeground": mutedText,
    "tab.border": border,
    "tab.activeBorderTop": primary,
    "terminal.background": page,
    "panel.background": page,
    "panel.border": border,
    "breadcrumb.background": page,
    "breadcrumb.foreground": mutedText,
    // The chrome around it.
    "sideBar.background": side,
    "sideBar.foreground": sideText,
    "sideBar.border": sideBorder,
    "sideBarTitle.foreground": sideText,
    "sideBarSectionHeader.background": side,
    "sideBarSectionHeader.foreground": sideText,
    "sideBarSectionHeader.border": sideBorder,
    "activityBar.background": side,
    "activityBar.foreground": sideText,
    "activityBar.inactiveForeground": mutedText,
    "activityBar.border": sideBorder,
    "activityBar.activeBorder": primary,
    "activityBarBadge.background": primary,
    "activityBarBadge.foreground": primaryText,
    "titleBar.activeBackground": side,
    "titleBar.activeForeground": sideText,
    "titleBar.inactiveBackground": side,
    "titleBar.inactiveForeground": mutedText,
    "titleBar.border": sideBorder,
    "statusBar.background": side,
    "statusBar.foreground": mutedText,
    "statusBar.border": sideBorder,
    "statusBar.noFolderBackground": side,
    "statusBarItem.remoteBackground": primary,
    "statusBarItem.remoteForeground": primaryText,
    "statusBarItem.hoverBackground": accent,
    // Everything that floats.
    "editorWidget.background": pop,
    "editorWidget.foreground": popText,
    "editorWidget.border": border,
    "editorSuggestWidget.background": pop,
    "editorSuggestWidget.border": border,
    "editorHoverWidget.background": pop,
    "editorHoverWidget.border": border,
    "quickInput.background": pop,
    "quickInput.foreground": popText,
    "menu.background": pop,
    "menu.foreground": popText,
    "menu.border": border,
    "menu.selectionBackground": accent,
    "menu.selectionForeground": accentText,
    "menu.separatorBackground": border,
    "dropdown.background": pop,
    "dropdown.foreground": popText,
    "dropdown.border": border,
    "notifications.background": pop,
    "notifications.foreground": popText,
    "notifications.border": border,
    "notificationCenterHeader.background": side,
    "peekViewEditor.background": pop,
    "widget.border": border,
    "widget.shadow": mode === "dark" ? "#00000066" : "#00000022",
    // Inputs, lists, buttons.
    "input.background": page,
    "input.foreground": text,
    "input.border": t.input ?? border,
    "input.placeholderForeground": mutedText,
    "focusBorder": ring,
    "list.activeSelectionBackground": accent,
    "list.activeSelectionForeground": accentText,
    "list.inactiveSelectionBackground": muted,
    "list.inactiveSelectionForeground": text,
    "list.hoverBackground": muted,
    "list.focusOutline": ring,
    "button.background": primary,
    "button.foreground": primaryText,
    "button.secondaryBackground": t.secondary ?? muted,
    "button.secondaryForeground": t["secondary-foreground"] ?? text,
    "badge.background": primary,
    "badge.foreground": primaryText,
    "progressBar.background": primary,
    "checkbox.background": page,
    "checkbox.border": t.input ?? border,
    "scrollbarSlider.background": mode === "dark" ? "#ffffff1a" : "#0000001a",
    "textLink.foreground": t["sidebar-primary"] ?? primary,
  }

  const colorCustomizations: Record<string, string> = {}
  for (const [key, value] of Object.entries(colors)) if (value) colorCustomizations[key] = value
  return {
    colorTheme: mode === "dark" ? "Default Dark Modern" : "Default Light Modern",
    colorCustomizations,
  }
}
