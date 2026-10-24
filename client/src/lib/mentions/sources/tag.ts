/* `@tag:<name>` — a tag: its message and the commit it points at, read at send. */
import { Tag } from "lucide-react"
import { defineKindSource } from "../kind"
import { GIT_SOURCE, gitRow, searchGit, type GitKindMatch } from "./git-search"

export const tagSource = defineKindSource<GitKindMatch>({
  kind: "tag",
  icon: Tag,
  hint: "A tag: message and commit",
  errorLabel: "Couldn't search tags",
  ...GIT_SOURCE,
  search: (query, ctx, _data, signal) => searchGit("tag", query, ctx, signal),
  face: (ref) => ({ icon: Tag, label: ref }),
  row: (match) => ({ icon: Tag, ...gitRow(match, "tag") }),
})
