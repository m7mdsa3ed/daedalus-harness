/* The transcript as markdown — what you would paste into an issue. Behind
   "Copy transcript", and nothing else reads it. */
import { autonomyLine } from "@/lib/autonomy-text"
import type { ThreadItem } from "@/lib/store"

export function transcriptText(items: ThreadItem[]): string {
  return items
    .map((item) => {
      const text = itemText(item)
      // A subagent's items sit under the step that launched them.
      return text && "parentId" in item && item.parentId ? indent(text) : text
    })
    .filter(Boolean)
    .join("\n\n")
}

const indent = (text: string): string =>
  text
    .split("\n")
    .map((line) => (line ? `  ${line}` : line))
    .join("\n")

function itemText(item: ThreadItem): string {
  switch (item.kind) {
    case "user":
      return `### You\n\n${item.text}`
    case "agent":
      return item.text
    case "thought":
      return item.text
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")
    case "notice":
      return `_${item.text}_`
    // The transcript gets pasted into bug reports; a failure is the single
    // most useful thing in one, details and all.
    case "error":
      return [
        `> **${item.title}**`,
        item.reason && `> ${item.reason}`,
        item.detail && `\n\`\`\`\n${item.detail}\n\`\`\``,
      ]
        .filter(Boolean)
        .join("\n")
    case "tool":
      return `- **${item.title}** — ${item.status}`
    case "subagent":
      return `- **${item.name}** — ${item.task} (${item.state})`
    case "plan":
      return item.entries.map((entry) => `- [${entry.status}] ${entry.content}`).join("\n")
    // The summary is the only part of the pre-compaction history the agent
    // still has, so a pasted transcript that dropped it would not explain
    // what the agent was working from after this point.
    /* An auto-answered question. In a pasted transcript this is often the most
       important line on the page: it is where the run did something nobody was
       asked about. */
    case "autonomy": {
      const line = autonomyLine(item)
      return `> **${line.title}**\n> ${line.detail}`
    }
    case "compaction":
      return [
        `_Context compacted (${item.status})_`,
        item.error,
        ...item.summary.map((block) => (block.type === "text" ? block.text : "")),
      ]
        .filter(Boolean)
        .join("\n\n")
  }
}
