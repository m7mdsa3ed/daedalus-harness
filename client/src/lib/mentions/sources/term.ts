/* `@term:last|<id>` — the output of a `!` command run in this project, the only
   terminal output the server keeps. The tail is what is sent when it is long. */
import { Terminal } from "lucide-react"
import { defineKindSource } from "../kind"
import { GIT_SOURCE, searchGit, type GitKindMatch } from "./git-search"

export const termSource = defineKindSource<GitKindMatch>({
  kind: "term",
  icon: Terminal,
  hint: "Output of a recent ! command",
  errorLabel: "Couldn't list commands",
  ...GIT_SOURCE,
  search: (query, ctx, _data, signal) => searchGit("term", query, ctx, signal),
  face: (ref) => ({ icon: Terminal, label: ref === "last" ? "last command" : `output ${ref.slice(0, 8)}` }),
  row: (match) => ({ icon: Terminal, label: match.label, description: match.description, aside: match.aside, badge: "term" }),
})
