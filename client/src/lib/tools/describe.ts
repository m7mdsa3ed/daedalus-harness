/* ── Describing a command ── the sentence the agent did not write.
 *
 * A `Bash` call carries two things: what the agent typed, and — when it
 * bothered — a `description` saying what it meant ("List source files" over
 * `git status --short && ls server/src client/src/lib`). The sentence is what
 * a step row wants, and every runtime treats it as optional: Claude Code drops
 * it on short commands, codex sends none at all, and the row then prints the
 * command with `Run ` in front of it, which is the kind icon said twice.
 *
 * So the phrase is derived here when it was not sent. The rule is that this
 * only ever *adds* a reading — an unrecognised program returns null and the row
 * falls back to printing the command, because a wrong sentence about a command
 * is worse than no sentence beside one. Nothing here interprets flags beyond
 * the handful that change the verb (`sed -i` writes where `sed -n` reads);
 * everything else is the program, its subcommand, and the first thing that
 * looks like the thing acted on.
 */
import { splitCommand } from "./shell"

// ─── Tokens ──────────────────────────────────────────────────────────────────

/** Split a line into words, keeping a quoted run whole and unquoted. A pattern
    is regularly `'foo bar'`, and a describer that split it in two would name
    the wrong thing. */
function tokenize(text: string): string[] {
  const out: string[] = []
  let current = ""
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) out.push(current)
      current = ""
      continue
    }
    current += char
  }
  if (current) out.push(current)
  return out
}

/** Split a script into the commands it runs, on the operators that separate
    them — outside quotes, since `grep "a || b"` is one command. A pipe counts:
    `git log | head` is git's work, and the tail of a pipeline is usually
    plumbing, which the phrase table declines to name. */
function segments(script: string): string[] {
  const out: string[] = []
  let current = ""
  let quote: string | null = null
  let depth = 0
  for (let i = 0; i < script.length; i++) {
    const char = script[i]
    if (quote) {
      current += char
      if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      current += char
      continue
    }
    if (char === "(") depth++
    if (char === ")") depth = Math.max(0, depth - 1)
    const two = script.slice(i, i + 2)
    if (depth === 0 && (two === "&&" || two === "||")) {
      out.push(current)
      current = ""
      i++
      continue
    }
    if (depth === 0 && (char === ";" || char === "|" || char === "\n" || char === "&")) {
      out.push(current)
      current = ""
      continue
    }
    current += char
  }
  out.push(current)
  return out.map((part) => part.trim()).filter(Boolean)
}

/** Wrappers that are not the command — they run one. Dropped so `sudo -u x
    systemctl restart y` is described as the restart it is. */
const WRAPPERS = new Set(["sudo", "env", "time", "nohup", "command", "exec", "nice", "xargs", "doas"])

/** Segments that are punctuation in a script rather than work in it: moving
    somewhere, printing a separator, a no-op keeping a chain alive. Naming them
    would crowd out the command they were written to serve. */
const PLUMBING = new Set([
  "cd", "echo", "printf", "true", "false", ":", "export", "set", "source", ".",
  "head", "tail", "sort", "uniq", "cut", "tr", "tee", "column", "less", "more",
])

/** The program a segment runs, with its arguments — leading `FOO=bar`
    assignments and wrappers stripped. */
function programOf(segment: string): { name: string; args: string[] } | null {
  /* Redirections are the shell's plumbing, not arguments: `cat <<PY` and
     `node x.js > out.log` are a read and a run, and the `<<PY`/`>` tokens would
     otherwise be picked up as the thing acted on. */
  let words = tokenize(segment).filter((word) => !/^[0-9]*[<>]/.test(word))
  for (;;) {
    while (words.length && /^[A-Za-z_][\w]*=/.test(words[0])) words = words.slice(1)
    if (words.length && WRAPPERS.has(words[0])) {
      words = words.slice(1)
      continue
    }
    break
  }
  if (!words.length) return null
  const name = words[0].split("/").pop() ?? words[0]
  return { name: name.toLowerCase(), args: words.slice(1) }
}

// ─── Arguments ───────────────────────────────────────────────────────────────

const isFlag = (word: string): boolean => word.startsWith("-")

/** Options that swallow the next word, per program — `git -C server status` is
    git's status, not a subcommand named `server`. Per program because the same
    letter means different things: `kubectl -n` takes a namespace while `grep -n`
    is boolean, and a program absent here (every leaf command, where the first
    non-flag argument *is* the object) has no value-taking options. */
const VALUE_OPTS: Record<string, Set<string>> = {
  git: new Set(["C", "c"]),
  docker: new Set(["H", "l"]),
  kubectl: new Set(["n", "s"]),
  gh: new Set(["R", "H"]),
}

/** Long options whose value is the next word, not inline. Anything else is
    boolean (`--no-pager`, `-A`) or carries its value inline (`--git-dir=x`). */
const LONG_VALUE: Record<string, Set<string>> = {
  git: new Set(["git-dir", "work-tree"]),
  docker: new Set(["host"]),
  kubectl: new Set(["namespace", "server", "context", "kubeconfig"]),
  gh: new Set(["repo", "hostname"]),
}

const NO_VALUE: Set<string> = new Set()

/** The index past the option at `i` and, when it takes one, its value. */
function afterOption(name: string, args: string[], i: number): number {
  const word = args[i]
  if (!word.startsWith("-")) return i
  if (word.startsWith("--")) {
    const eq = word.indexOf("=")
    const flag = eq === -1 ? word.slice(2) : word.slice(2, eq)
    if (eq !== -1) return i + 1
    return (LONG_VALUE[name] ?? NO_VALUE).has(flag) ? i + 2 : i + 1
  }
  const cluster = word.slice(1)
  const set = VALUE_OPTS[name] ?? NO_VALUE
  for (let j = 0; j < cluster.length; j++) {
    if (set.has(cluster[j])) return j === cluster.length - 1 ? i + 2 : i + 1
  }
  return i + 1
}

/** Index of the first argument that is not a flag or a flag's value. */
function firstArgIndex(name: string, args: string[]): number {
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("-")) return i
    i = afterOption(name, args, i) - 1
  }
  return -1
}

/** The first argument that is not a flag — a subcommand, a path, a pattern. */
const firstArg = (args: string[]): string | undefined => {
  const i = firstArgIndex("", args)
  return i === -1 ? undefined : args[i]
}

/** The object a subcommand acts on — the first argument after it that is not an
    option or an option's value (`kubectl get pods`, `git checkout main`). */
function objectOf(name: string, args: string[], subIndex: number): string | undefined {
  for (let i = subIndex + 1; i < args.length; i++) {
    if (!args[i].startsWith("-")) return args[i]
    i = afterOption(name, args, i) - 1
  }
  return undefined
}

const hasFlag = (args: string[], ...flags: string[]): boolean =>
  args.some((arg) => flags.some((flag) => arg === flag || (/^-[A-Za-z]+$/.test(arg) && flag.length === 2 && arg.includes(flag[1]))))

/** The archive a `tar` call names, which is the object of every one of its
    verbs — `-f`'s value, wherever that flag sits. `-f` ends its cluster by
    convention (`-czf out.tgz`), and tar takes its flags with no dash at all
    (`tar czf out.tgz`), so the first word is read as a cluster too. `--file`
    is matched exactly rather than by prefix: `--files-from` names a list of
    members, not the archive. */
function tarFile(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const word = args[i]
    if (word === "--file") return args[i + 1]
    if (word.startsWith("--file=")) return word.slice("--file=".length)
    const cluster = word.startsWith("-") ? word.slice(1) : i === 0 ? word : ""
    if (/^[A-Za-z]+$/.test(cluster) && cluster.includes("f")) return args[i + 1]
  }
  return undefined
}

/** A path keeps its last two segments — `server/src` says where it is where a
    bare `src` could be any of five directories — while a plain file name is
    already its own answer. */
function shortPathArg(value: string | undefined, max = 30): string | null {
  if (!value) return null
  const parts = value.replace(/\/+$/, "").split("/").filter(Boolean)
  const tail = parts.slice(-2).join("/") || value
  return tail.length > max ? `…${tail.slice(-(max - 1))}` : tail
}

/** The host of a URL: an address is too long for a row and its path is
    rarely the point. */
function hostOf(value: string | undefined): string | null {
  if (!value) return null
  const match = /^https?:\/\/([^/?#]+)/i.exec(value)
  return match ? match[1] : null
}

/** A path argument reads better as its basename: the row has one line, and the
    directory is in the command printed underneath it. */
function shortArg(value: string | undefined, max = 28): string | null {
  if (!value) return null
  const base = value.endsWith("/") ? value : (value.split("/").pop() || value)
  const text = base.replace(/\s+/g, " ").trim()
  if (!text) return null
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** A pattern is quoted in the phrase, because it is a literal the user chose
    and not a word of the sentence. */
function quoted(value: string | undefined, max = 32): string | null {
  const text = shortArg(value, max)
  return text ? `“${text}”` : null
}

const withTarget = (verb: string, target: string | null): string =>
  target ? `${verb} ${target}` : verb

// ─── Phrases ─────────────────────────────────────────────────────────────────

/** git's verb is its subcommand; the porcelain names are stable enough to say
    in words, and anything else falls through to naming the subcommand. */
const GIT_PHRASES: Record<string, string> = {
  status: "check git status",
  log: "read the git history",
  diff: "read the git diff",
  show: "read a commit",
  add: "stage changes",
  commit: "commit changes",
  push: "push to the remote",
  pull: "pull from the remote",
  fetch: "fetch from the remote",
  clone: "clone a repository",
  checkout: "switch branches",
  switch: "switch branches",
  branch: "list branches",
  merge: "merge a branch",
  rebase: "rebase",
  stash: "stash changes",
  reset: "reset the working tree",
  restore: "discard changes",
  blame: "read a file's history",
  remote: "check the remotes",
  tag: "work with tags",
  worktree: "manage worktrees",
  init: "initialise a repository",
}

/** Package managers name their work in their subcommand too, and all of them
    spell it the same way. */
function packagePhrase(name: string, args: string[]): string | null {
  const sub = firstArg(args)
  if (!sub) return null
  if (["install", "i", "add", "ci", "update", "up", "upgrade", "remove", "rm", "uninstall"].includes(sub)) {
    return ["remove", "rm", "uninstall"].includes(sub) ? "remove a dependency" : "install dependencies"
  }
  if (sub === "test") return "run the tests"
  if (sub === "build") return "build the project"
  if (sub === "lint") return "lint the project"
  if (sub === "dev" || sub === "start") return "start the dev server"
  /* `pnpm exec tsc -b` and `npx vitest` are the tool they run, not the manager
      that ran it — describe the rest of the line instead. */
  if (["exec", "dlx", "run"].includes(sub) || name === "npx" || name === "pnpx" || name === "bunx") {
    const rest = args.slice(args.indexOf(sub) + (["exec", "dlx", "run"].includes(sub) ? 1 : 0))
    const inner = rest.length ? phraseFor(rest[0].split("/").pop()!.toLowerCase(), rest.slice(1)) : null
    return inner ?? (rest.length ? `run the ${rest[0]} script` : null)
  }
  return `run ${name} ${sub}`
}

/**
 * The phrase for one command, lowercase and verb-first so it can be joined
 * with another. Null means "no idea", which is a real answer here: the row
 * still has the command itself to print.
 */
function phraseFor(name: string, args: string[]): string | null {
  const first = firstArg(args)
  switch (name) {
    case "git":
      return first ? (GIT_PHRASES[first] ?? `run git ${first}`) : null
    case "npm": case "pnpm": case "yarn": case "bun": case "npx": case "pnpx": case "bunx":
      return packagePhrase(name, args)

    // Reading and walking the tree.
    case "ls": case "dir": {
      /* One directory is worth naming; several are "the files", because a row
         listing three of them is the command over again. */
      const paths = args.filter((arg) => !isFlag(arg))
      return withTarget("list", paths.length === 1 ? shortPathArg(paths[0]) : "the files")
    }
    case "tree":
      return "read the directory tree"
    case "cat": case "bat": case "nl":
      /* `cat <<EOF > file` writes a file with the shell as its editor, and
         `cat | x` feeds a pipeline — neither is a read of anything nameable,
         so an argument-less cat is left to whatever else is in the line. */
      return first ? withTarget("read", shortArg(first)) : null
    case "sed": {
      const files = args.filter((a) => !isFlag(a))
      const target = files.at(-1)
      return hasFlag(args, "-i")
        ? withTarget("edit", shortArg(target))
        : withTarget("read", shortArg(target))
    }
    case "wc":
      return "count the lines"
    case "file": case "stat":
      return withTarget("inspect", shortArg(first))
    case "diff":
      return "compare two files"

    // Searching.
    case "grep": case "rg": case "ag": case "ack":
      return withTarget("search for", quoted(first))
    case "find": case "fd":
      return "find files"
    case "which": case "whereis": case "type":
      return withTarget("locate", shortArg(first))

    // Changing the tree.
    case "mkdir":
      return withTarget("create", shortArg(first) ? `${shortArg(first)}/` : "a directory")
    case "rm":
      return withTarget("delete", shortArg(first))
    case "cp":
      return "copy files"
    case "mv":
      return "move files"
    case "touch":
      return withTarget("create", shortArg(first))
    case "chmod": case "chown":
      return "change permissions"
    case "ln":
      return "make a symlink"
    case "tar": {
      /* The flag is the verb: `-c` writes an archive where `-x` reads one, and
         the file named by `-f` is the archive either way. */
      if (hasFlag(args, "-c")) return withTarget("archive into", shortArg(tarFile(args)))
      if (hasFlag(args, "-x")) return withTarget("extract", shortArg(tarFile(args)))
      return withTarget("inspect", shortArg(tarFile(args)))
    }
    case "zip": case "gzip": case "bzip2": case "xz":
      return withTarget("compress into", shortArg(first))
    case "unzip": case "gunzip": case "bunzip2": case "unxz":
      return withTarget("extract", shortArg(first))
    case "ssh":
      return first ? `connect to ${first}` : null
    case "scp":
      /* Either side can be the remote; the sentence names the far end. */
      return args.some((a) => !isFlag(a) && a.includes(":"))
        ? withTarget("copy to", shortArg(args.find((a) => !isFlag(a) && a.includes(":"))))
        : withTarget("copy from", shortArg(args.find((a) => !isFlag(a) && a.includes(":"))))
    case "rsync":
      return args.some((a) => a.includes(":"))
        ? withTarget("sync to", shortArg(args.find((a) => a.includes(":"))))
        : "sync files"

    // The network and the machine.
    case "curl": case "wget": case "http": {
      const url = args.find((arg) => /^https?:/i.test(arg))
      return withTarget("fetch", hostOf(url) ?? shortArg(url ?? first, 40))
    }
    case "ps": case "pgrep": case "top":
      return "check running processes"
    case "kill": case "pkill":
      return "stop a process"
    case "lsof": case "netstat": case "ss":
      return "check open ports"
    case "df": case "du":
      return "check disk usage"
    case "jq":
      return "read some JSON"
    case "sqlite3": case "psql": case "mysql":
      return "query the database"
    default:
      return null
  }
}

// ─── The sentence ────────────────────────────────────────────────────────────

/** Two phrases is a sentence; three is a paragraph in a row that has one line.
    Past that the count is dropped rather than elided into "…", which would
    promise a detail the row is not going to give. */
const MAX_PHRASES = 2

/**
 * A description for a shell command, or null when nothing in it was
 * recognised. Heredoc bodies are not read — a script fed to python is its own
 * program and the shell around it is what was actually run.
 */
export function describeCommand(command: string): string | null {
  const script = splitCommand(command)
    .filter((segment) => segment.kind === "shell")
    .map((segment) => segment.text)
    .join("\n")

  const phrases: string[] = []
  let skipped = false
  for (const segment of segments(script)) {
    const program = programOf(segment)
    if (!program) continue
    if (PLUMBING.has(program.name)) continue
    const phrase = phraseFor(program.name, program.args)
    if (!phrase) {
      skipped = true
      continue
    }
    if (!phrases.includes(phrase)) phrases.push(phrase)
  }
  if (!phrases.length) return null
  /* A command with an unreadable part in it is described by the parts that
     were read, and only while they are most of it: "check git status" over
     `git status && ./deploy.sh --prod` names the smaller half of the work. */
  if (skipped && phrases.length < 2) return null

  const shown = phrases.slice(0, MAX_PHRASES).join(" and ")
  return shown.charAt(0).toUpperCase() + shown.slice(1)
}
