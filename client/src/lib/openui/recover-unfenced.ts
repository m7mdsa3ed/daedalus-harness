const ASSIGNMENT_LINE = /^[A-Za-z_][A-Za-z0-9_]*\s*=\s*\S.*$/
const ROOT_LINE = /^root(?:\s*=\s*|\s*:\s*|\s+)Stack\s*\(/i
const ROOT_ASSIGNMENT = /^root\s*=\s*Stack\s*\(/i
const BARE_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)\s+(?=[A-Z][A-Za-z0-9_]*\s*\()/
const COLON_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(?=[A-Z][A-Za-z0-9_]*\s*\()/

export interface RecoveredOpenui {
  code: string
  remainder: string
}

interface ScanResult {
  stack: string[]
  quote: string | null
  escaped: boolean
  valid: boolean
}

function scanLine(line: string, state: ScanResult): void {
  for (const char of line) {
    if (state.quote) {
      if (state.escaped) state.escaped = false
      else if (char === "\\") state.escaped = true
      else if (char === state.quote) state.quote = null
      continue
    }

    if (char === '"' || char === "'") state.quote = char
    else if (char === "[" || char === "(" || char === "{") state.stack.push(char)
    else if (char === "]" || char === ")" || char === "}") {
      const opener = state.stack.pop()
      const expected = char === "]" ? "[" : char === ")" ? "(" : "{"
      if (opener !== expected) state.valid = false
    }
  }
}

function closingDelimiters(stack: string[]): string {
  return [...stack]
    .reverse()
    .map((open) => (open === "[" ? "]" : open === "(" ? ")" : "}"))
    .join("")
}

function looksLikeExpressionContinuation(line: string): boolean {
  const value = line.trim()
  return /^(?:[A-Z][A-Za-z0-9_]*\s*\(|[\[\]{}(),]|["']|[-+]?\d|true\b|false\b|null\b|[A-Za-z_][A-Za-z0-9_]*\s*[,]?$)/.test(value)
}

function normalizeStatement(line: string): string {
  const trimmed = line.trim()
  if (ROOT_LINE.test(trimmed)) return trimmed.replace(ROOT_LINE, "root = Stack(")
  if (ASSIGNMENT_LINE.test(trimmed)) return trimmed
  if (COLON_ASSIGNMENT.test(trimmed)) return trimmed.replace(COLON_ASSIGNMENT, "$1 = ")
  return trimmed.replace(BARE_ASSIGNMENT, "$1 = ")
}

/**
 * Recover a leading, structurally clear unfenced OpenUI program.
 *
 * Repairs are intentionally mechanical: missing root/variable assignment
 * operators and unmatched closing delimiters at the end of an isolated
 * program. Mixed prose, mismatched delimiters, and uncertain quote/comma errors
 * are not rewritten. Text following a blank-line boundary stays as markdown.
 */
export function recoverUnfencedOpenui(text: string): RecoveredOpenui | null {
  const lines = text.split(/\r?\n/)
  let first = 0
  while (first < lines.length && !lines[first]?.trim()) first++
  if (first === lines.length) return null

  const root = normalizeStatement(lines[first] ?? "")
  if (!ROOT_ASSIGNMENT.test(root)) return null

  const codeLines = [root]
  const scan: ScanResult = { stack: [], quote: null, escaped: false, valid: true }
  let assignments = 0
  let end = first + 1

  for (let index = first; index < lines.length; index++) {
    const raw = index === first ? root : lines[index] ?? ""
    const trimmed = raw.trim()
    if (!trimmed) {
      if (assignments > 0) {
        end = index + 1
        break
      }
      continue
    }

    if (scan.stack.length > 0 && assignments > 0 && index > first && !looksLikeExpressionContinuation(raw)) {
      end = index
      break
    }

    if (scan.stack.length === 0) {
      const statement = index === first ? root : normalizeStatement(raw)
      if (!ASSIGNMENT_LINE.test(statement)) {
        if (assignments === 0) return null
        end = index
        break
      }
      assignments++
      if (index !== first) codeLines.push(statement)
      scanLine(statement, scan)
    } else {
      codeLines.push(raw)
      scanLine(raw, scan)
    }

    if (!scan.valid) return null
    end = index + 1
  }

  if (assignments < 2 || scan.quote !== null || !scan.valid) return null
  if (scan.stack.length > 0) codeLines[codeLines.length - 1] += closingDelimiters(scan.stack)

  while (end < lines.length && !lines[end]?.trim()) end++
  return {
    code: codeLines.join("\n").trim(),
    remainder: lines.slice(end).join("\n").trim(),
  }
}
