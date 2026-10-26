const RTL_CHAR = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/
const STRONG_CHAR = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/

/** Direction of the first strongly directional character, like `dir="auto"`. */
export function textDir(text: string | undefined | null): "rtl" | "ltr" {
  const first = text?.match(STRONG_CHAR)?.[0]
  return first && RTL_CHAR.test(first) ? "rtl" : "ltr"
}

/** Direction of the dominant writing system; neutral marks and numbers do not count. */
export function dominantTextDir(text: string | undefined | null): "rtl" | "ltr" {
  const letters = text?.match(/\p{L}/gu) ?? []
  let rtl = 0
  let ltr = 0
  for (const letter of letters) {
    if (RTL_CHAR.test(letter)) rtl += 1
    else ltr += 1
  }
  return rtl === ltr ? textDir(text) : rtl > ltr ? "rtl" : "ltr"
}
