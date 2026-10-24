/* `@git:changes|staged|last-turn|stash/N` — the working tree, read at send:
   uncommitted work, what is staged, what this thread's last turn wrote, one
   stash entry. The options are few and fixed, so the first request lists them
   all and typing narrows. */
import { GitCompare } from "lucide-react"
import { defineKindSource } from "../kind"
import { GIT_SOURCE, gitRow, searchGit, type GitKindMatch } from "./git-search"

export const gitSource = defineKindSource<GitKindMatch>({
  kind: "git",
  icon: GitCompare,
  hint: "Changes, staged, last turn, stash",
  errorLabel: "Couldn't list git options",
  ...GIT_SOURCE,
  // Static choices answered in one request: there is nothing to type a path into.
  debounceMs: 0,
  search: (query, ctx, _data, signal) => searchGit("git", query, ctx, signal),
  face: (ref) => ({ icon: GitCompare, label: ref }),
  row: (match) => ({ icon: GitCompare, ...gitRow(match, "git") }),
})
