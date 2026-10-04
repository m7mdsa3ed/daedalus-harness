// domMax, not domAnimation: swipeable-list uses `drag`. Its own module so the
// dynamic import in main.tsx splits it out of the entry chunk.
export { domMax as default } from "motion/react"
