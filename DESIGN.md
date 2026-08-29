---
version: alpha
name: Daedalus Harness
description: A quiet, high-density workbench for sustained collaboration with coding agents.
colors:
  primary: "oklch(0.216 0.006 56.043)"
  primary-foreground: "oklch(0.985 0 0)"
  background: "oklch(1 0 0)"
  foreground: "oklch(0.147 0.004 49.25)"
  card: "oklch(1 0 0)"
  card-foreground: "oklch(0.145 0 0)"
  popover: "oklch(1 0 0)"
  popover-foreground: "oklch(0.145 0 0)"
  secondary: "oklch(0.97 0 0)"
  secondary-foreground: "oklch(0.205 0 0)"
  muted: "oklch(0.97 0.001 106.424)"
  muted-foreground: "oklch(0.553 0.013 58.071)"
  accent: "oklch(0.97 0 0)"
  accent-foreground: "oklch(0.205 0 0)"
  destructive: "oklch(0.577 0.245 27.325)"
  border: "oklch(0.923 0.003 48.717)"
  input: "oklch(0.922 0 0)"
  ring: "oklch(0.708 0 0)"
  sidebar: "oklch(0.985 0 0)"
  sidebar-foreground: "oklch(0.145 0 0)"
  dark-background: "oklch(0.147 0.004 49.25)"
  dark-foreground: "oklch(0.985 0.001 106.423)"
  dark-card: "oklch(0.205 0 0)"
  dark-card-foreground: "oklch(0.985 0 0)"
  dark-primary: "oklch(0.923 0.003 48.717)"
  dark-primary-foreground: "oklch(0.205 0 0)"
  dark-muted: "oklch(0.268 0.007 34.298)"
  dark-muted-foreground: "oklch(0.709 0.01 56.259)"
  dark-border: "oklch(1 0 0 / 10%)"
typography:
  ui-body:
    fontFamily: Figtree Variable
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.38
  ui-title:
    fontFamily: Figtree Variable
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.25
  control:
    fontFamily: Figtree Variable
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.25
  caption:
    fontFamily: Figtree Variable
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1.45
  label-caps:
    fontFamily: Figtree Variable
    fontSize: 10px
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: 0.08em
  code:
    fontFamily: monospace
    fontSize: 11.5px
    fontWeight: 400
    lineHeight: 1.5
rounded:
  xs: 4px
  sm: 6px
  md: 8px
  lg: 10px
  xl: 14px
  2xl: 18px
  4xl: 26px
  full: 9999px
spacing:
  0.5: 2px
  1: 4px
  1.5: 6px
  2: 8px
  3: 12px
  4: 16px
  6: 24px
  8: 32px
  12: 48px
  chat-width: 748px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.control}"
    rounded: "{rounded.4xl}"
    height: 36px
    padding: 0 12px
  button-primary-dark:
    backgroundColor: "{colors.dark-primary}"
    textColor: "{colors.dark-primary-foreground}"
    typography: "{typography.control}"
    rounded: "{rounded.4xl}"
    height: 36px
    padding: 0 12px
  button-secondary:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.secondary-foreground}"
    typography: "{typography.control}"
    rounded: "{rounded.4xl}"
    height: 36px
    padding: 0 12px
  button-accent:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-foreground}"
    typography: "{typography.control}"
    rounded: "{rounded.4xl}"
    height: 36px
    padding: 0 12px
  destructive-status:
    backgroundColor: "{colors.background}"
    textColor: "{colors.destructive}"
    typography: "{typography.caption}"
    rounded: "{rounded.md}"
    padding: 8px
  input:
    backgroundColor: "{colors.input}"
    textColor: "{colors.foreground}"
    typography: "{typography.control}"
    rounded: "{rounded.4xl}"
    height: 36px
    padding: 0 12px
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.card-foreground}"
    typography: "{typography.ui-body}"
    rounded: "{rounded.2xl}"
    padding: 24px
  popover:
    backgroundColor: "{colors.popover}"
    textColor: "{colors.popover-foreground}"
    typography: "{typography.ui-body}"
    rounded: "{rounded.4xl}"
    padding: 12px
  sidebar:
    backgroundColor: "{colors.sidebar}"
    textColor: "{colors.sidebar-foreground}"
    typography: "{typography.ui-body}"
    width: 256px
    padding: 8px
  metadata:
    backgroundColor: "{colors.background}"
    textColor: "{colors.muted-foreground}"
    typography: "{typography.caption}"
    rounded: "{rounded.sm}"
    padding: 4px
  tool-pane:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.foreground}"
    typography: "{typography.code}"
    rounded: "{rounded.md}"
    padding: 10px
  separator:
    backgroundColor: "{colors.border}"
    height: 1px
  focus-indicator:
    backgroundColor: "{colors.ring}"
    rounded: "{rounded.full}"
    size: 3px
  page-dark:
    backgroundColor: "{colors.dark-background}"
    textColor: "{colors.dark-foreground}"
    typography: "{typography.ui-body}"
  card-dark:
    backgroundColor: "{colors.dark-card}"
    textColor: "{colors.dark-card-foreground}"
    typography: "{typography.ui-body}"
    rounded: "{rounded.2xl}"
    padding: 24px
  metadata-dark:
    backgroundColor: "{colors.dark-muted}"
    textColor: "{colors.dark-muted-foreground}"
    typography: "{typography.caption}"
    rounded: "{rounded.sm}"
    padding: 4px
  separator-dark:
    backgroundColor: "{colors.dark-border}"
    height: 1px
---

## Overview

Daedalus is a working surface for sustained collaboration with coding agents. It should feel like a native development tool: calm, precise, compact, and dependable under long sessions. The interface exists to keep projects, threads, tool activity, code, terminals, and approvals legible without competing with the work itself.

The visual reference is a modern desktop workbench with the restraint of a code editor and the finish of a native productivity application. Information is dense but organized. Controls are small and predictable. Surfaces use subtle translucency and depth, while the transcript and workspace remain the visual center.

This is not a marketing interface. It should not use oversized headlines, ornamental dashboards, decorative cards, or explanatory feature copy. The application opens directly into useful work.

## Colors

The UI is built from semantic color roles rather than component-specific colors. Components consume `background`, `foreground`, `card`, `popover`, `primary`, `muted`, `accent`, `border`, and their paired foreground tokens. Do not insert arbitrary colors into components when an existing semantic role applies.

The default palette is nearly neutral with a slight warm cast. Contrast and state changes carry hierarchy more often than hue. `primary` identifies the strongest action or selected state, `muted` separates quiet regions, and `destructive` is reserved for errors and irreversible actions.

Light and dark modes preserve the same semantic relationships. Dark mode is not a simple inversion: elevated surfaces are lighter than the page, borders become translucent, and muted text remains clearly subordinate without becoming faint.

Built-in palettes such as Ocean, Forest, Violet, Sunset, Rose, and Amber may change hue, but they must override the complete semantic token set and preserve the same foreground/background relationships. User-created palettes follow the same contract. Every text-bearing pair must meet at least WCAG AA contrast for normal text.

## Typography

Figtree Variable is the application typeface for navigation, settings, controls, messages, and headings. It has an approachable shape without making the interface feel casual. Use weight and contrast sparingly; most hierarchy comes from placement, spacing, and small changes in size.

- `ui-body` is the dominant application size. Sidebar rows, settings, chat support text, and repeated controls should normally use it.
- `ui-title` is for compact panel, dialog, card, and settings headings. It is not a display style.
- `control` is used for buttons and inputs that need slightly more presence.
- `caption` is for timestamps, status, metrics, and secondary metadata.
- `label-caps` is reserved for short structural labels. Keep these labels brief and use them infrequently.
- `code` is for commands, paths, diffs, logs, tool parameters, identifiers, and tabular technical values. Preserve whitespace where it carries meaning and use tabular numerals for changing metrics.

Long-form agent responses use a compact prose treatment with clear Markdown hierarchy. Code and tool output may be denser than prose, but must never become too small to scan comfortably.

## Layout

The application is a full-window workbench. The primary structure is a resizable navigation sidebar beside a workspace that can contain chat, code, diff, terminal, source-control, output, and web panels. Navigation and panels should use the whole available viewport instead of being placed inside decorative page containers.

The transcript uses a stable maximum width of `{spacing.chat-width}`. The composer aligns to the transcript's text column and stays visually attached to turn-level controls. On narrow viewports, margins collapse before content or controls are reduced below usable sizes.

Use the compact spacing scale consistently. Repeated rows typically use 4-8px internal gaps; controls use 8-12px horizontal padding; framed tools use 8-12px padding; dialogs and substantial cards use 24px. Prefer alignment and shared edges over adding containers.

Dense operational screens should support scanning and repeated action. Keep primary actions near the context they affect, keep navigation positions stable, and preserve panel dimensions while content loads or streams.

## Elevation & Depth

Depth comes from translucent semantic surfaces, thin rings or borders, and restrained shadows. Cards use a soft glass shadow with approximately 14px backdrop blur. Dialogs, sheets, popovers, and menus use stronger blur and shadow because they must separate from active work beneath them.

Glass is a material behavior, not decoration. It should reveal enough of the live theme to feel integrated while maintaining readable contrast. When backdrop filtering is unavailable, preserve separation with the fallback shadow and opaque semantic surface.

The empty-thread hero is the one expressive background treatment. It is a full-window, theme-aware shader behind the shell, never an illustration inside a card. Shell surfaces become partially translucent while it is visible. It must not reduce navigation or composer legibility.

## Shapes

Shape language distinguishes compact tools from primary interaction surfaces. Tool panes, inline results, and dense technical regions use 6-10px radii. Cards use approximately 18px. Buttons, inputs, pills, and dialogs use strongly rounded 26px or fully circular shapes where that improves touch targeting and recognition.

Do not apply the largest radius to every container. Nested surfaces should become simpler and tighter as they move inward. Borders should normally be one pixel or a subtle ring, using the semantic border color at reduced opacity where appropriate.

## Components

Buttons use familiar icons for common actions and include text only when the command benefits from a visible label. Icon-only buttons must have an accessible name and a tooltip when the icon is not self-explanatory. Default buttons are 36px high; compact toolbar actions may use 24px or 32px square targets when surrounding density requires it.

Inputs share the pill-like control shape and use a lightly tinted input surface. Focus is shown with a visible semantic ring, not by shifting layout. Disabled controls reduce opacity but retain their shape and label.

Cards frame individual objects or tools. They are not the default treatment for page sections, and cards must not be nested inside other cards. Settings pages, transcript regions, and workspace panels remain unframed layouts unless a component genuinely needs containment.

Tool calls and technical output use compact panes with monospace content, restrained borders, and bounded scrolling. The command, result, status, and approval state should be distinguishable at a glance without adding bright decorative color.

Thinking steps use a muted, plain-text timeline title. Do not render Markdown emphasis, code chips, or other prose decoration in the collapsed title row. The expanded thinking detail may use the normal prose renderer and retain its Markdown structure.

The composer is the primary interaction surface. It aligns with the transcript, remains stable while agent options change, and visually connects to the turn-level strip above it. It should read as one composed tool rather than a stack of unrelated cards.

Dialogs and menus are compact overlays. Dialog titles use the `ui-title` tier, descriptions use muted body text, and actions sit together at the end of the dialog. Overlays may blur the workspace but must not hide the user's current context more than necessary.

The same vocabulary applies across every route family: the connection screen, thread transcript, workspace panels, schedules, tasks board, settings index, settings lists, import flows, edit forms, and theme editor. Route-specific content may change, but page framing, action sizing, field treatment, empty states, overlay behavior, and focus treatment should remain recognizable.

## Do's and Don'ts

- **Do** optimize for sustained work, scanning, comparison, and repeated action.
- **Do** use semantic tokens so every built-in and user-created palette remains coherent.
- **Do** keep the transcript, active editor, terminal, or approval request visually dominant.
- **Do** use restrained motion, generally 100-200ms for overlays and feedback. The empty-thread background may fade over roughly 320ms.
- **Do** reserve layout animation for content whose size is the interaction itself, such as an expanding plan or disclosure; all other feedback should use opacity, color, or transform.
- **Do** preserve visible focus, accessible names, keyboard navigation, and WCAG AA text contrast.
- **Do** keep icon buttons square and dimensionally stable so changing labels or loading states do not move nearby controls.
- **Don't** create landing-page heroes, promotional sections, or large introductory cards inside the product.
- **Don't** use gradients, glowing accents, blurred color blobs, or glass purely as decoration. The shader-backed empty state is the deliberate exception.
- **Don't** introduce arbitrary component colors outside the semantic theme system.
- **Don't** fill operational screens with cards or place cards inside cards.
- **Don't** use oversized typography in compact panels, settings, dialogs, sidebars, or tool output.
- **Don't** make metadata compete with content; timestamps, token counts, paths, and statuses remain secondary until they require attention.
- **Don't** animate layout dimensions during streaming or loading. Dynamic content must not cause controls, tabs, counters, or panels to jump.
