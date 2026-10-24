/* `@kb:<id>` — a knowledge-base entry of this project, inlined at send. */
import { BookOpen } from "lucide-react"
import { defineKindSource } from "../kind"
import { GIT_SOURCE, searchGit, type GitKindMatch } from "./git-search"

export const kbSource = defineKindSource<GitKindMatch>({
  kind: "kb",
  icon: BookOpen,
  hint: "A knowledge-base entry",
  errorLabel: "Couldn't search the knowledge base",
  ...GIT_SOURCE,
  search: (query, ctx, _data, signal) => searchGit("kb", query, ctx, signal),
  face: (ref) => ({ icon: BookOpen, label: `note ${ref.slice(0, 8)}` }),
  row: (match) => ({ icon: BookOpen, label: match.label, description: match.description, aside: match.aside, badge: "kb" }),
})
