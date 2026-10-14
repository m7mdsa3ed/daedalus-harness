/* ── What the user typed ── the prose of a user bubble, drawn with the
   composer's chips: a quote, a long paste and an `@` mention sit in the line
   as they did in the box (`user-chips.tsx`). A leaf: it draws no rows and
   recurses into nothing, so it lives apart from the mutually recursive cluster
   in `rows.tsx`, which imports it for the `user` case. The composer's queue
   draws it too, through the `thread-items` barrel. */
import * as React from "react"
import { Prose } from "@/components/tool-parts"
import { UserPastes, UserTasks, collapsePastes } from "@/components/thread-items/user-chips"
import { splitTaskContext } from "@/lib/task-mentions"

export function UserMessageText({ text }: { text: string }) {
  const { collapsed, tasks } = React.useMemo(() => {
    const split = splitTaskContext(text)
    return { collapsed: collapsePastes(split.text), tasks: split.tasks }
  }, [text])
  return (
    <UserTasks tasks={tasks}>
      <UserPastes pastes={collapsed.pastes}>
        <Prose text={collapsed.text} mentions />
      </UserPastes>
    </UserTasks>
  )
}
