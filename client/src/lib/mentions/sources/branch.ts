/* `@branch:<name>` — a branch: the commits it has over the default branch and
   their diff, read at send. */
import { GitBranch } from "lucide-react"
import { defineKindSource } from "../kind"
import { GIT_SOURCE, gitRow, searchGit, type GitKindMatch } from "./git-search"

export const branchSource = defineKindSource<GitKindMatch>({
  kind: "branch",
  icon: GitBranch,
  hint: "A branch: its commits and diff",
  errorLabel: "Couldn't search branches",
  ...GIT_SOURCE,
  search: (query, ctx, _data, signal) => searchGit("branch", query, ctx, signal),
  face: (ref) => ({ icon: GitBranch, label: ref }),
  row: (match) => ({ icon: GitBranch, ...gitRow(match, "branch") }),
})
