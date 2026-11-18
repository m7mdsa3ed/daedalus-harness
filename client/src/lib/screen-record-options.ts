import { MAX_ATTACHMENT_BYTES } from "@/lib/attachments"

/* What a screen recording can be asked to be. The attachment cap is fixed, so
   quality and length trade against each other: each preset says how long it
   fits, and the menu prints that rather than leaving the reader to do the sum. */

export type ScreenQuality = "compact" | "balanced" | "sharp"
export type ScreenFps = 5 | 15 | 30

export const SCREEN_QUALITIES: { id: ScreenQuality; label: string; bits: number }[] = [
  { id: "compact", label: "Compact", bits: 600_000 },
  { id: "balanced", label: "Balanced", bits: 1_500_000 },
  { id: "sharp", label: "Sharp", bits: 4_000_000 },
]

export const SCREEN_FPS: ScreenFps[] = [5, 15, 30]

export interface ScreenRecordPrefs {
  screenQuality: ScreenQuality
  screenFps: ScreenFps
  screenAudio: boolean
}

export const SCREEN_RECORD_DEFAULTS: ScreenRecordPrefs = {
  screenQuality: "compact",
  screenFps: 15,
  screenAudio: true,
}

export function qualityBits(quality: ScreenQuality): number {
  return (SCREEN_QUALITIES.find((q) => q.id === quality) ?? SCREEN_QUALITIES[0]).bits
}

/** Roughly how long a recording at this quality fits under the attachment cap,
    as the menu words it. Audio rides on top of the video rate, so this is the
    upper end. */
export function fitsFor(quality: ScreenQuality): string {
  const seconds = Math.floor((MAX_ATTACHMENT_BYTES * 8) / qualityBits(quality))
  return seconds >= 120 ? `about ${Math.round(seconds / 60)} min` : `about ${seconds} s`
}
