import { createContext, useContext } from "react"

/** The thread a transcript row is drawn in, for a row that has to ask the server about it. */
export const ThreadIdContext = createContext<string | null>(null)
export const useThreadId = () => useContext(ThreadIdContext)
