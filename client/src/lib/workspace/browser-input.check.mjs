/* The runnable check behind the browser panel's input mapping.

     ../server/node_modules/.bin/tsx --tsconfig tsconfig.app.json src/lib/workspace/browser-input.check.mjs   (from client/)

   `--tsconfig` because the module imports `@daedalus/browser-protocol` and
   `@/lib/shortcuts` through the app's path aliases. */
import assert from "node:assert"

import {
  addressToUrl,
  buttonsBit,
  elementToPage,
  elementToPageClamped,
  isComposing,
  isHarnessChord,
  isPasteChord,
  keyCommand,
  keyText,
  letterbox,
  mouseButton,
  nextClick,
  pageToElement,
  SEARCH_URL,
  touchGesture,
  wheelCommand,
} from "./browser-input.ts"

const frame = { deviceWidth: 800, deviceHeight: 600, offsetTop: 0, pageScaleFactor: 1 }

// A canvas the frame's size maps 1:1.
assert.deepEqual(elementToPage(100, 50, 800, 600, frame), { x: 100, y: 50 })

// Letterboxing: a 1000x600 element holding an 800x600 frame has 100px bars left and right.
assert.deepEqual(letterbox(1000, 600, 800, 600), { x: 100, y: 0, width: 800, height: 600, scale: 1 })
assert.deepEqual(elementToPage(100, 0, 1000, 600, frame), { x: 0, y: 0 })
assert.deepEqual(elementToPage(500, 300, 1000, 600, frame), { x: 400, y: 300 })
assert.equal(elementToPage(50, 300, 1000, 600, frame), null, "a press in the bar is not on the page")
assert.deepEqual(elementToPageClamped(50, 300, 1000, 600, frame), { x: 0, y: 300 }, "a drag out keeps the edge")

// Downscaled: a 400x300 element is half the frame, so a point doubles.
assert.deepEqual(elementToPage(200, 150, 400, 300, frame), { x: 400, y: 300 })
// Vertical bars: a 400x600 element holds the frame at 0.5 with 150px above and below.
assert.deepEqual(letterbox(400, 600, 800, 600).y, 150)
assert.deepEqual(elementToPage(200, 150, 400, 600, frame), { x: 400, y: 0 })

// offsetTop and pageScaleFactor (pinch zoom): DevTools' conversion.
const zoomed = { deviceWidth: 800, deviceHeight: 600, offsetTop: 20, pageScaleFactor: 2 }
assert.deepEqual(elementToPage(200, 220, 800, 600, zoomed), { x: 100, y: 100 })

// The overlay is the inverse.
for (const f of [frame, zoomed]) {
  const r = pageToElement({ x: 100, y: 100, width: 50, height: 20 }, 1000, 600, f)
  const back = elementToPage(r.x, r.y, 1000, 600, f)
  assert.deepEqual(back, { x: 100, y: 100 })
}
assert.equal(elementToPage(10, 10, 0, 0, frame), null, "no size, no mapping")
assert.equal(elementToPage(10, 10, 100, 100, { ...frame, deviceWidth: 0 }), null)

// Mouse buttons.
assert.equal(mouseButton(0), "left")
assert.equal(mouseButton(2), "right")
assert.equal(mouseButton(1), "middle")
assert.equal(mouseButton(9), "none")
assert.equal(buttonsBit(0), 1)
assert.equal(buttonsBit(2), 2)
assert.equal(buttonsBit(1), 4)

// Click counting: same button, close in time and place.
let c = nextClick(null, { at: 0, x: 10, y: 10, button: 0 })
assert.equal(c.count, 1)
c = nextClick(c, { at: 200, x: 12, y: 11, button: 0 })
assert.equal(c.count, 2)
c = nextClick(c, { at: 300, x: 12, y: 11, button: 0 })
assert.equal(c.count, 3)
assert.equal(nextClick(c, { at: 1200, x: 12, y: 11, button: 0 }).count, 1, "too late")
assert.equal(nextClick(c, { at: 400, x: 40, y: 11, button: 0 }).count, 1, "too far")
assert.equal(nextClick(c, { at: 400, x: 12, y: 11, button: 2 }).count, 1, "other button")

// Wheel deltas become CSS pixels.
const mods = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }
assert.deepEqual(wheelCommand("t", { x: 1, y: 2 }, { deltaX: 0, deltaY: 3, deltaMode: 1, ...mods }, 600), {
  type: "wheel", tabId: "t", x: 1, y: 2, deltaX: 0, deltaY: 48, modifiers: 0,
})
assert.equal(wheelCommand("t", { x: 0, y: 0 }, { deltaX: 0, deltaY: 1, deltaMode: 2, ...mods }, 600).deltaY, 600)
assert.equal(wheelCommand("t", { x: 0, y: 0 }, { deltaX: 0, deltaY: 1, deltaMode: 0, ...mods, shiftKey: true }, 600).modifiers, 8)

// Touch: movement is a drag, stillness a long press, and a drag stays one.
const start = { x: 0, y: 0, at: 0 }
assert.equal(touchGesture("pending", start, { x: 3, y: 3, at: 100 }), "pending")
assert.equal(touchGesture("pending", start, { x: 20, y: 0, at: 100 }), "drag")
assert.equal(touchGesture("pending", start, { x: 1, y: 0, at: 600 }), "long-press")
assert.equal(touchGesture("drag", start, { x: 0, y: 0, at: 900 }), "drag")

// Keys.
const key = (key, code, extra = {}) => ({ key, code, ...mods, ...extra })
assert.deepEqual(keyCommand("t", key("a", "KeyA", { keyCode: 65 }), "keyDown"), {
  type: "key", tabId: "t", event: "keyDown", key: "a", code: "KeyA", modifiers: 0, text: "a", keyCode: 65,
})
assert.deepEqual(keyCommand("t", key("a", "KeyA", { keyCode: 65 }), "keyUp"), {
  type: "key", tabId: "t", event: "keyUp", key: "a", code: "KeyA", modifiers: 0, keyCode: 65,
}, "a key up types nothing")
assert.equal(keyText(key("Enter", "Enter")), "\r", "Enter submits")
assert.equal(keyText(key("ArrowLeft", "ArrowLeft")), undefined)
assert.equal(keyText(key("Tab", "Tab")), undefined)
assert.equal(keyText(key("a", "KeyA", { ctrlKey: true })), undefined, "a chord types nothing")
assert.equal(keyText(key("a", "KeyA", { metaKey: true })), undefined)
assert.equal(keyText(key("@", "KeyQ", { ctrlKey: true, altKey: true })), "@", "AltGr types")
assert.equal(keyText(key("A", "KeyA", { shiftKey: true })), "A")
assert.equal(keyText(key("é", "KeyE")), "é")
assert.equal(keyText(key("😀", "")), "😀", "one code point, two UTF-16 units")
const chord = keyCommand("t", key("ArrowRight", "ArrowRight", { shiftKey: true, ctrlKey: true, location: 0, repeat: true }), "keyDown")
assert.equal(chord.modifiers, 2 | 8)
assert.equal(chord.text, undefined)
assert.equal(chord.repeat, true)
assert.equal("location" in chord, false, "standard location is left out")
assert.equal(keyCommand("t", key("Enter", "NumpadEnter", { location: 3 }), "keyDown").location, 3)

assert.equal(isComposing(key("Process", "KeyA")), true)
assert.equal(isComposing(key("a", "KeyA", { keyCode: 229 })), true)
assert.equal(isComposing(key("a", "KeyA", { isComposing: true })), true)
assert.equal(isComposing(key("a", "KeyA")), false)

assert.equal(isPasteChord(key("v", "KeyV", { ctrlKey: true })), true)
assert.equal(isPasteChord(key("v", "KeyV", { metaKey: true })), true)
assert.equal(isPasteChord(key("Insert", "Insert", { shiftKey: true })), true)
assert.equal(isPasteChord(key("v", "KeyV")), false)

// Harness chords are kept from the page; only modified ones count.
const chords = ["mod+k", "alt+down", "?", "mod+shift+\\"]
assert.equal(isHarnessChord(key("k", "KeyK", { ctrlKey: true }), chords), true)
assert.equal(isHarnessChord(key("k", "KeyK", { metaKey: true }), chords), true)
assert.equal(isHarnessChord(key("ArrowDown", "ArrowDown", { altKey: true }), chords), true)
assert.equal(isHarnessChord(key("?", "Slash", { shiftKey: true }), chords), false, "a bare key is the page's")
assert.equal(isHarnessChord(key("j", "KeyJ", { ctrlKey: true }), chords), false)
assert.equal(isHarnessChord(key("k", "KeyK"), chords), false)

// The address bar.
assert.equal(addressToUrl(""), null)
assert.equal(addressToUrl("   "), null)
assert.equal(addressToUrl("https://example.com/a"), "https://example.com/a")
assert.equal(addressToUrl("about:blank"), "about:blank")
assert.equal(addressToUrl("example.com"), "https://example.com")
assert.equal(addressToUrl("docs.example.co.uk/path?q=1"), "https://docs.example.co.uk/path?q=1")
assert.equal(addressToUrl("localhost:5173"), "http://localhost:5173")
assert.equal(addressToUrl("localhost"), "http://localhost")
assert.equal(addressToUrl("127.0.0.1:3000/x"), "http://127.0.0.1:3000/x")
assert.equal(addressToUrl("192.168.1.10"), "http://192.168.1.10")
assert.equal(addressToUrl("how do I center a div"), SEARCH_URL + "how%20do%20I%20center%20a%20div")
assert.equal(addressToUrl("react"), SEARCH_URL + "react", "a bare word is a search")
assert.equal(addressToUrl("node 22 release"), SEARCH_URL + "node%2022%20release")
assert.equal(addressToUrl("c++"), SEARCH_URL + "c%2B%2B")
assert.equal(addressToUrl("search", "https://s.test/?q="), "https://s.test/?q=search", "the search URL is a parameter")

console.log("browser-input: ok")
