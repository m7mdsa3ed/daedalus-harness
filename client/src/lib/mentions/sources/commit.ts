/* `@commit:<sha>` — a commit: its message, stat and patch, read at send
   (`server/src/mentions/resolvers/git.ts`). Picking one inserts the short sha;
   the chip says it. */
import { GitCommitHorizontal } from "lucide-react"
import { defineKindSource } from "../kind"
import { GIT_SOURCE, gitRow, searchGit, type GitKindMatch } from "./git-search"

export const commitSource = defineKindSource<GitKindMatch>({
  kind: "commit",
  icon: GitCommitHorizontal,
  hint: "A commit: message and patch",
  errorLabel: "Couldn't search commits",
  ...GIT_SOURCE,
  search: (query, ctx, _data, signal) => searchGit("commit", query, ctx, signal),
  face: (ref) => ({ icon: GitCommitHorizontal, label: ref.slice(0, 8) }),
  row: (match) => ({ icon: GitCommitHorizontal, ...gitRow(match, "commit") }),
})
