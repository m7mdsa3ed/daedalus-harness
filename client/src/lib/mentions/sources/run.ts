/* `@run:<id>` — the result of a workflow or routine run of this project:
   status, errors, final output and a workflow's step outcomes, read at send. */
import { Play } from "lucide-react"
import { defineKindSource } from "../kind"
import { GIT_SOURCE, searchGit, type GitKindMatch } from "./git-search"

export const runSource = defineKindSource<GitKindMatch>({
  kind: "run",
  icon: Play,
  hint: "A workflow or routine run's result",
  errorLabel: "Couldn't search runs",
  ...GIT_SOURCE,
  search: (query, ctx, _data, signal) => searchGit("run", query, ctx, signal),
  face: (ref) => ({ icon: Play, label: `run ${ref.slice(0, 8)}` }),
  row: (match) => ({ icon: Play, label: match.label, description: match.description, aside: match.aside, badge: "run" }),
})
