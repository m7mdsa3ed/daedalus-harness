/* ── The template catalogue ──
   Plain data: each entry prefills the create form and nothing else. A template
   never saves anything — the form opens on it and a person reviews it. Prompts
   are written to be self-contained (an unattended run has nobody to ask) and
   to say what success looks like. `api` / `git` ask the form to add a webhook
   or a commit trigger as well; `plan` is the When preset. */
import {
  AlarmClockIcon,
  BellRingIcon,
  BookOpenCheckIcon,
  BugIcon,
  FileTextIcon,
  GitPullRequestIcon,
  HourglassIcon,
  InboxIcon,
  NewspaperIcon,
  PackageSearchIcon,
  RocketIcon,
  SquareDashedIcon,
  SunIcon,
  SunriseIcon,
  TestTubeDiagonalIcon,
  type LucideIcon,
} from "lucide-react"

import type { RoutineRunsIn } from "@/lib/settings"
import type { SchedulePlan } from "@/lib/automation-schedule"

export interface AutomationTemplate {
  id: string
  label: string
  blurb: string
  icon: LucideIcon
  runsIn: RoutineRunsIn
  /** The automation's name; empty for Blank. */
  name: string
  prompt: string
  plan?: Partial<SchedulePlan>
  /** Also add a webhook trigger on create. */
  api?: boolean
  /** Also add a commit trigger on create. */
  git?: boolean
}

export const BLANK_TEMPLATE: AutomationTemplate = {
  id: "blank",
  label: "Blank",
  blurb: "Start from nothing",
  icon: SquareDashedIcon,
  runsIn: "thread",
  name: "",
  prompt: "",
}

export const TEMPLATES: AutomationTemplate[] = [
  {
    id: "repo-brief",
    label: "Daily repo brief",
    blurb: "Last 24h of commits by workstream",
    icon: FileTextIcon,
    runsIn: "thread",
    name: "Daily repo brief",
    prompt:
      "Summarise everything that landed on this repository in the last 24 hours. Group commits by workstream, name the authors, and call out anything risky (large diffs, touched migrations, reverted work). Finish with a short list of what needs a human decision. If nothing changed, say so in one line.",
    plan: { preset: "weekdays", time: "08:07" },
  },
  {
    id: "pr-review",
    label: "PR review",
    blurb: "Review on every push or webhook",
    icon: GitPullRequestIcon,
    runsIn: "thread",
    name: "PR review",
    prompt:
      "Review the changes on the current branch against its base. Read the diff, run the relevant tests if they are quick, and report: correctness bugs, missing tests, risky changes, and style issues that matter. Be specific (file and line) and say clearly whether you would approve. If the webhook payload names a pull request, review that one.",
    plan: { preset: "manual" },
    git: true,
    api: true,
  },
  {
    id: "dep-audit",
    label: "Dependency audit",
    blurb: "Weekly outdated and vulnerable packages",
    icon: PackageSearchIcon,
    runsIn: "thread",
    name: "Weekly dependency audit",
    prompt:
      "Audit this project's dependencies. List outdated packages (flag major bumps), known vulnerabilities, and unmaintained packages. Do not change anything. Recommend an order to upgrade in and note which upgrades look risky. Success is a short, prioritised list.",
    plan: { preset: "weekly", days: [1], time: "07:07" },
  },
  {
    id: "ci-triage",
    label: "CI failure triage",
    blurb: "Explain a failing build from a webhook",
    icon: TestTubeDiagonalIcon,
    runsIn: "thread",
    name: "CI failure triage",
    prompt:
      "A CI run failed. Using the payload's details and the repository, find the first real failure (not the cascade after it), identify the likely cause and the commit that introduced it, and propose the smallest fix. Say how confident you are. Do not push anything.",
    plan: { preset: "manual" },
    api: true,
  },
  {
    id: "release-notes",
    label: "Release notes draft",
    blurb: "Weekly changelog from merged work",
    icon: NewspaperIcon,
    runsIn: "thread",
    name: "Release notes draft",
    prompt:
      "Draft release notes for everything merged since the last tag (or the last 7 days if there is none). Group into Added, Changed, Fixed. Write for users, not developers, and link each item to its commit. Output the notes only.",
    plan: { preset: "weekly", days: [5], time: "15:07" },
  },
  {
    id: "docs-drift",
    label: "Docs drift check",
    blurb: "Weekly: do the docs still match the code?",
    icon: BookOpenCheckIcon,
    runsIn: "thread",
    name: "Docs drift check",
    prompt:
      "Check whether the documentation still matches the code. Compare README and docs against the current commands, config keys, file layout and public APIs. List each mismatch with the doc location and what the code actually does. Do not edit files.",
    plan: { preset: "weekly", days: [3], time: "10:07" },
  },
  {
    id: "backlog-triage",
    label: "Issue and backlog triage",
    blurb: "Weekday sort of what is new",
    icon: InboxIcon,
    runsIn: "thread",
    name: "Backlog triage",
    prompt:
      "Look at the issues, tasks and TODOs that appeared since the last working day. Label each by type and urgency, point out duplicates, and suggest an owner where the history makes it obvious. End with the three things most worth doing today.",
    plan: { preset: "weekdays", time: "09:07" },
  },
  {
    id: "deploy-verify",
    label: "Deploy verification",
    blurb: "Go / no-go after a deploy webhook",
    icon: RocketIcon,
    runsIn: "thread",
    name: "Deploy verification",
    prompt:
      "A deploy just finished. Check that the app is healthy: hit the health endpoints, read the newest logs for errors, and run the smoke checks you can find in the repository. Answer GO or NO-GO on the first line, then the evidence.",
    plan: { preset: "manual" },
    api: true,
  },
  {
    id: "alert-triage",
    label: "Alert triage",
    blurb: "Alert payload to a fix attempt",
    icon: BellRingIcon,
    runsIn: "thread",
    name: "Alert triage",
    prompt:
      "An alert fired; its details are in the payload. Find the code path involved, reproduce or explain the failure, and attempt a minimal fix on a new branch. Report what you found, what you changed and what you could not verify. Never touch production configuration.",
    plan: { preset: "manual" },
    api: true,
  },
  {
    id: "recent-bugs",
    label: "Bug-fix my recent commits",
    blurb: "A second look at what you just shipped",
    icon: BugIcon,
    runsIn: "thread",
    name: "Review my recent commits",
    prompt:
      "Read my commits from the last day and look for bugs I would regret: off-by-ones, unhandled errors, missing awaits, broken edge cases, untested branches. Report only real findings with file and line and a suggested fix. If everything looks fine, say so in one line.",
    plan: { preset: "daily", time: "17:37" },
  },
  {
    id: "morning-briefing",
    label: "Morning briefing",
    blurb: "What to know before you start",
    icon: SunriseIcon,
    runsIn: "thread",
    name: "Morning briefing",
    prompt:
      "Give me a briefing for the start of the working day: what changed in the repository overnight, which tasks are open or blocked, and anything that failed. Keep it to what I need to act on, in order of importance.",
    plan: { preset: "weekdays", time: "07:37" },
  },
  {
    id: "babysit-pr",
    label: "Babysit this PR",
    blurb: "Keep an eye on it in this thread",
    icon: GitPullRequestIcon,
    runsIn: "session",
    name: "Babysit this PR",
    prompt:
      "Check the state of the pull request we are working on: new review comments, failing checks, merge conflicts. Handle what is clearly mechanical, and tell me about anything that needs a decision. If nothing changed since you last looked, reply with one short line.",
    plan: { preset: "every", every: 15, unit: "minutes" },
  },
  {
    id: "poll-green",
    label: "Poll until green",
    blurb: "Re-check CI in this thread",
    icon: HourglassIcon,
    runsIn: "session",
    name: "Poll until green",
    prompt:
      "Check whether CI for the current branch has finished. If it is still running, say so in one line. If it failed, diagnose the first real failure and propose a fix. If it passed, say so and turn this automation off.",
    plan: { preset: "every", every: 5, unit: "minutes" },
  },
  {
    id: "remind-me",
    label: "Remind me later",
    blurb: "Follow up in this thread, once",
    icon: AlarmClockIcon,
    runsIn: "session",
    name: "Follow up",
    prompt: "Follow up on where we left off in this thread: summarise the state of the work and what the next step is.",
    plan: { preset: "once" },
  },
]

/** Gallery groups, in the order they are drawn. */
export const TEMPLATE_GROUPS: { id: RoutineRunsIn; label: string; icon: LucideIcon }[] = [
  { id: "thread", label: "Starts a new thread", icon: SunIcon },
  { id: "session", label: "Works in this thread", icon: AlarmClockIcon },
]
