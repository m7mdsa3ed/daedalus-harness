/* The one runnable check behind `matchesChord`'s Option-key fallback: on macOS
   ⌥P types "π", and every alt+letter chord was dead there.

     node --experimental-strip-types src/lib/shortcuts.check.mjs   (from client/)
*/
import assert from "node:assert"
import { chordFromEvent, matchesChord } from "./shortcuts.ts"

const press = (key, code, mods = {}) => ({ key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods })

// macOS: Option turns the letter into a symbol; the physical key decides.
assert.ok(matchesChord(press("π", "KeyP", { altKey: true }), "alt+p"))
assert.ok(matchesChord(press("ß", "KeyS", { altKey: true }), "alt+s"))
assert.ok(matchesChord(press("Dead", "KeyE", { altKey: true }), "alt+e"))
assert.equal(chordFromEvent(press("µ", "KeyM", { altKey: true })), "alt+m")
// Everywhere else the key already is the letter.
assert.ok(matchesChord(press("p", "KeyP", { altKey: true }), "alt+p"))
// Without Option the symbol is what was typed, not a chord.
assert.ok(!matchesChord(press("π", "KeyP"), "p"))
// A layout whose Alt+letter types a real letter keeps that letter (AZERTY "a" on KeyQ).
assert.ok(matchesChord(press("a", "KeyQ", { altKey: true }), "alt+a"))
assert.ok(!matchesChord(press("a", "KeyQ", { altKey: true }), "alt+q"))

console.log("shortcuts.check: ok")
