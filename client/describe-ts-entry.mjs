// src/lib/tools/shell.ts
var HEREDOC_RE = /<<-?\s*(?:(['"])([A-Za-z_][A-Za-z0-9_]*)\1|([A-Za-z_][A-Za-z0-9_]*))/g;
var DELIM_LANG = {
  py: "python",
  python: "python",
  py3: "python",
  js: "javascript",
  node: "javascript",
  mjs: "javascript",
  ts: "typescript",
  tsx: "tsx",
  rb: "ruby",
  ruby: "ruby",
  go: "go",
  rs: "rust",
  rust: "rust",
  php: "php",
  sql: "sql",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  html: "html",
  css: "css",
  scss: "scss",
  xml: "xml",
  md: "markdown",
  markdown: "markdown",
  toml: "toml",
  ini: "toml",
  conf: "toml",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  dockerfile: "docker",
  docker: "docker",
  c: "c",
  cpp: "cpp",
  java: "java",
  cs: "csharp"
};
var INTERPRETER_LANG = [
  [/\bpython[0-9.]*\b/, "python"],
  [/\bnode\b/, "javascript"],
  [/\b(ts-node|tsx)\b/, "typescript"],
  [/\bruby\b/, "ruby"],
  [/\b(psql|sqlite3|mysql|mariadb)\b/, "sql"],
  [/\bjq\b/, "json"],
  [/\bphp\b/, "php"],
  [/\b(bash|sh|zsh)\b/, "bash"]
];
function heredocLanguage(delimiter, opener) {
  const byDelimiter = DELIM_LANG[delimiter.toLowerCase()];
  if (byDelimiter) return byDelimiter;
  const head = opener.slice(0, opener.search(HEREDOC_RE) + 1);
  for (const [pattern, language] of INTERPRETER_LANG) {
    if (pattern.test(head)) return language;
  }
  const redirect = /(?:>>?|\btee\b)\s*(\S+\.([A-Za-z0-9]+))/.exec(opener);
  return redirect ? EXT_LANG[redirect[2].toLowerCase()] : void 0;
}
function splitCommand(command) {
  const lines = command.split("\n");
  const segments2 = [];
  let shell = [];
  const flushShell = () => {
    if (shell.length) segments2.push({ kind: "shell", text: shell.join("\n") });
    shell = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    shell.push(line);
    const openers = [...line.matchAll(HEREDOC_RE)].map((match) => match[2] ?? match[3]);
    if (openers.length === 0) continue;
    for (const delimiter of openers) {
      const end = lines.findIndex(
        (candidate, index) => index > i && candidate.trim() === delimiter
      );
      if (end === -1) continue;
      flushShell();
      segments2.push({
        kind: "heredoc",
        label: delimiter,
        language: heredocLanguage(delimiter, line),
        text: lines.slice(i + 1, end).join("\n")
      });
      i = end;
    }
  }
  flushShell();
  return segments2;
}
var EXT_LANG = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sql: "sql",
  css: "css",
  scss: "scss",
  html: "html",
  xml: "xml",
  md: "markdown",
  mdx: "markdown",
  env: "bash",
  dockerfile: "docker"
};

// src/lib/tools/describe.ts
function tokenize(text) {
  const out = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) out.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) out.push(current);
  return out;
}
function segments(script) {
  const out = [];
  let current = "";
  let quote = null;
  let depth = 0;
  for (let i = 0; i < script.length; i++) {
    const char = script[i];
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(") depth++;
    if (char === ")") depth = Math.max(0, depth - 1);
    const two = script.slice(i, i + 2);
    if (depth === 0 && (two === "&&" || two === "||")) {
      out.push(current);
      current = "";
      i++;
      continue;
    }
    if (depth === 0 && (char === ";" || char === "|" || char === "\n" || char === "&")) {
      if (char === "&") {
        const prev = script[i - 1] ?? "";
        const next = script[i + 1] ?? "";
        if (prev === ">" || prev === "<" || next === ">" || /\d/.test(prev) || /\d/.test(next)) {
          current += char;
          continue;
        }
      }
      out.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  out.push(current);
  return out.map((part) => part.trim()).filter(Boolean);
}
var WRAPPERS = /* @__PURE__ */ new Set(["sudo", "env", "time", "nohup", "command", "exec", "nice", "xargs", "doas"]);
var PLUMBING = /* @__PURE__ */ new Set([
  "cd",
  "echo",
  "printf",
  "true",
  "false",
  ":",
  "export",
  "set",
  "source",
  ".",
  "head",
  "tail",
  "sort",
  "uniq",
  "cut",
  "tr",
  "tee",
  "column",
  "less",
  "more"
]);
function programOf(segment) {
  let words = tokenize(segment).filter((word) => !/^[0-9]*[<>]/.test(word) && !/^&?>/.test(word) && !/^[0-9]*>&/.test(word));
  for (; ; ) {
    while (words.length && /^[A-Za-z_][\w]*=/.test(words[0])) words = words.slice(1);
    if (words.length && WRAPPERS.has(words[0])) {
      words = words.slice(1);
      continue;
    }
    break;
  }
  if (!words.length) return null;
  const name = words[0].split("/").pop() ?? words[0];
  return { name: name.toLowerCase(), args: words.slice(1) };
}
var isFlag = (word) => word.startsWith("-");
var VALUE_OPTS = {
  git: /* @__PURE__ */ new Set(["C", "c"]),
  docker: /* @__PURE__ */ new Set(["H", "l"]),
  kubectl: /* @__PURE__ */ new Set(["n", "s"]),
  gh: /* @__PURE__ */ new Set(["R", "H"])
};
var LONG_VALUE = {
  git: /* @__PURE__ */ new Set(["git-dir", "work-tree"]),
  docker: /* @__PURE__ */ new Set(["host"]),
  kubectl: /* @__PURE__ */ new Set(["namespace", "server", "context", "kubeconfig"]),
  gh: /* @__PURE__ */ new Set(["repo", "hostname"])
};
var NO_VALUE = /* @__PURE__ */ new Set();
function afterOption(name, args, i) {
  const word = args[i];
  if (!word.startsWith("-")) return i;
  if (word.startsWith("--")) {
    const eq = word.indexOf("=");
    const flag = eq === -1 ? word.slice(2) : word.slice(2, eq);
    if (eq !== -1) return i + 1;
    return (LONG_VALUE[name] ?? NO_VALUE).has(flag) ? i + 2 : i + 1;
  }
  const cluster = word.slice(1);
  const set = VALUE_OPTS[name] ?? NO_VALUE;
  for (let j = 0; j < cluster.length; j++) {
    if (set.has(cluster[j])) return j === cluster.length - 1 ? i + 2 : i + 1;
  }
  return i + 1;
}
function firstArgIndex(name, args) {
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("-")) return i;
    i = afterOption(name, args, i) - 1;
  }
  return -1;
}
var firstArg = (args) => {
  const i = firstArgIndex("", args);
  return i === -1 ? void 0 : args[i];
};
var hasFlag = (args, ...flags) => args.some((arg) => flags.some((flag) => arg === flag || /^-[A-Za-z]+$/.test(arg) && flag.length === 2 && arg.includes(flag[1])));
function tarFile(args) {
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (word === "--file") return args[i + 1];
    if (word.startsWith("--file=")) return word.slice("--file=".length);
    const cluster = word.startsWith("-") ? word.slice(1) : i === 0 ? word : "";
    if (/^[A-Za-z]+$/.test(cluster) && cluster.includes("f")) return args[i + 1];
  }
  return void 0;
}
function shortPathArg(value, max = 30) {
  if (!value) return null;
  const parts = value.replace(/\/+$/, "").split("/").filter(Boolean);
  const tail = parts.slice(-2).join("/") || value;
  return tail.length > max ? `\u2026${tail.slice(-(max - 1))}` : tail;
}
function hostOf(value) {
  if (!value) return null;
  const match = /^https?:\/\/([^/?#]+)/i.exec(value);
  return match ? match[1] : null;
}
function shortArg(value, max = 28) {
  if (!value) return null;
  const base = value.endsWith("/") ? value : value.split("/").pop() || value;
  const text = base.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}\u2026` : text;
}
function quoted(value, max = 32) {
  const text = shortArg(value, max);
  return text ? `\u201C${text}\u201D` : null;
}
var withTarget = (verb, target) => target ? `${verb} ${target}` : verb;
var GIT_PHRASES = {
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
  init: "initialise a repository"
};
function packagePhrase(name, args) {
  const sub = firstArg(args);
  if (!sub) return null;
  if (["install", "i", "add", "ci", "update", "up", "upgrade", "remove", "rm", "uninstall"].includes(sub)) {
    return ["remove", "rm", "uninstall"].includes(sub) ? "remove a dependency" : "install dependencies";
  }
  if (sub === "test") return "run the tests";
  if (sub === "build") return "build the project";
  if (sub === "lint") return "lint the project";
  if (sub === "dev" || sub === "start") return "start the dev server";
  if (["exec", "dlx", "run"].includes(sub) || name === "npx" || name === "pnpx" || name === "bunx") {
    const rest = args.slice(args.indexOf(sub) + (["exec", "dlx", "run"].includes(sub) ? 1 : 0));
    const inner = rest.length ? phraseFor(rest[0].split("/").pop().toLowerCase(), rest.slice(1)) : null;
    return inner ?? (rest.length ? `run ${rest[0]}` : null);
  }
  return `run ${name} ${sub}`;
}
function phraseFor(name, args) {
  const first = firstArg(args);
  switch (name) {
    case "git":
      return first ? GIT_PHRASES[first] ?? `run git ${first}` : null;
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
    case "npx":
    case "pnpx":
    case "bunx":
      return packagePhrase(name, args);
    // Reading and walking the tree.
    case "ls":
    case "dir": {
      const paths = args.filter((arg) => !isFlag(arg));
      return withTarget("list", paths.length === 1 ? shortPathArg(paths[0]) : "the files");
    }
    case "tree":
      return "read the directory tree";
    case "cat":
    case "bat":
    case "nl":
      return first ? withTarget("read", shortArg(first)) : null;
    case "sed": {
      const files = args.filter((a) => !isFlag(a));
      const target = files.at(-1);
      return hasFlag(args, "-i") ? withTarget("edit", shortArg(target)) : withTarget("read", shortArg(target));
    }
    case "wc":
      return "count the lines";
    case "file":
    case "stat":
      return withTarget("inspect", shortArg(first));
    case "diff":
      return "compare two files";
    // Searching.
    case "grep":
    case "rg":
    case "ag":
    case "ack":
      return withTarget("search for", quoted(first));
    case "find":
    case "fd":
      return "find files";
    case "which":
    case "whereis":
    case "type":
      return withTarget("locate", shortArg(first));
    // Changing the tree.
    case "mkdir":
      return withTarget("create", shortArg(first) ? `${shortArg(first)}/` : "a directory");
    case "rm":
      return withTarget("delete", shortArg(first));
    case "cp":
      return "copy files";
    case "mv":
      return "move files";
    case "touch":
      return withTarget("create", shortArg(first));
    case "chmod":
    case "chown":
      return "change permissions";
    case "ln":
      return "make a symlink";
    case "tar": {
      if (hasFlag(args, "-c")) return withTarget("archive into", shortArg(tarFile(args)));
      if (hasFlag(args, "-x")) return withTarget("extract", shortArg(tarFile(args)));
      return withTarget("inspect", shortArg(tarFile(args)));
    }
    case "zip":
    case "gzip":
    case "bzip2":
    case "xz":
      return withTarget("compress into", shortArg(first));
    case "unzip":
    case "gunzip":
    case "bunzip2":
    case "unxz":
      return withTarget("extract", shortArg(first));
    case "ssh":
      return first ? `connect to ${first}` : null;
    case "scp":
      return args.some((a) => !isFlag(a) && a.includes(":")) ? withTarget("copy to", shortArg(args.find((a) => !isFlag(a) && a.includes(":")))) : withTarget("copy from", shortArg(args.find((a) => !isFlag(a) && a.includes(":"))));
    case "rsync":
      return args.some((a) => a.includes(":")) ? withTarget("sync to", shortArg(args.find((a) => a.includes(":")))) : "sync files";
    // The network and the machine.
    case "curl":
    case "wget":
    case "http": {
      const url = args.find((arg) => /^https?:/i.test(arg));
      return withTarget("fetch", hostOf(url) ?? shortArg(url ?? first, 40));
    }
    case "ps":
    case "pgrep":
    case "top":
      return "check running processes";
    case "kill":
    case "pkill":
      return "stop a process";
    case "lsof":
    case "netstat":
    case "ss":
      return "check open ports";
    case "df":
    case "du":
      return "check disk usage";
    case "jq":
      return "read some JSON";
    case "sqlite3":
    case "psql":
    case "mysql":
      return "query the database";
    // Dev tools: reached directly or through `pnpm exec`/`npx`, whose branch
    // above re-enters here with the inner program. Without these the fallback
    // names them as npm scripts ("run the tsc script"), which they are not.
    case "tsc":
    case "vue-tsc":
      return "typecheck the project";
    case "vite":
    case "webpack":
    case "esbuild":
    case "rollup":
    case "next": {
      const sub = firstArg(args);
      if (sub === "build" || sub === "build-ssr" || sub === "optimize") return "build the project";
      if (sub === "dev" || sub === "serve" || sub === "preview") return "start the dev server";
      return "build the project";
    }
    case "vitest":
    case "jest":
    case "mocha":
    case "playwright":
    case "cypress":
      return "run the tests";
    case "eslint":
    case "biome":
    case "prettier":
    case "stylelint":
    case "oxlint":
      return "lint the project";
    default:
      return null;
  }
}
var MAX_PHRASES = 2;
function describeCommand(command) {
  const script = splitCommand(command).filter((segment) => segment.kind === "shell").map((segment) => segment.text).join("\n");
  const phrases = [];
  let skipped = false;
  for (const segment of segments(script)) {
    const program = programOf(segment);
    if (!program) continue;
    if (PLUMBING.has(program.name)) continue;
    const phrase = phraseFor(program.name, program.args);
    if (!phrase) {
      skipped = true;
      continue;
    }
    if (!phrases.includes(phrase)) phrases.push(phrase);
  }
  if (!phrases.length) return null;
  if (skipped && phrases.length < 2) return null;
  const shown = phrases.slice(0, MAX_PHRASES).join(" and ");
  return shown.charAt(0).toUpperCase() + shown.slice(1);
}

// describe-ts-entry.ts
var cmds = ["pnpm build", "pnpm build 2>&1", "pnpm build 2> /tmp/x.log", "pnpm build > /tmp/x.log", "pnpm exec tsc -b", "pnpm exec tsc -b 2>&1 | tail -6", "git status 2>&1", "node script.js 2>&1 | head"];
for (const c of cmds) console.log(JSON.stringify(c), "=>", JSON.stringify(describeCommand(c)));
