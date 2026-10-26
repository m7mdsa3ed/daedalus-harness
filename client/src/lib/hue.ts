/* ── A stable hue from a name ──
   Three surfaces need the same answer — "give this thing a colour that is the
   same on every device and every reload, without storing one": a project
   without a logo draws its initial in a tinted disc, a task's assignee is
   coloured so the same person is the same colour everywhere, and an MCP server
   the user added wears its own hue in the composer's chip. It was written out
   twice (once here, once inline in `entity-icon.tsx`'s `InitialMark`) with the
   arithmetic spelled slightly differently, which meant two names could take two
   colours depending on which surface drew them.

   Not stored, deliberately: a colour is a property of the *name*, so renaming a
   project or a server re-tints it, and nothing has to migrate. 360 bins is
   plenty at the sizes this is used at (a 24px disc, a 14px glyph) — two names
   landing on one hue is fine and two hues landing on one name is not. */
export function hueOf(name: string): number {
  let hue = 0
  for (let i = 0; i < name.length; i++) hue = (hue * 31 + name.charCodeAt(i)) % 360
  return hue
}
