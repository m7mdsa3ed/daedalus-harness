# Free providers (`server/src/providers/`)

Some providers only serve clients presenting a fingerprint — exact headers, a
session id with a valid counter, verbatim tool definitions. The agents never
send that, so the gateway shim applies it per request behind the interface in
`providers/types.ts`. Adding a provider is a new file plus one `detectProvider`
entry in `providers/index.ts`, never a shim change.

## opencode-free (first)

Measured live 2026-10-14 (9router#4842): every `oc/*` free request outside
this fingerprint answers `403 FreeTierError`.

- endpoint `https://opencode.ai/inference/v1/*` (free moved off `/zen/v1/*`)
- `User-Agent: opencode/latest/2.0.26/cli`, `Authorization: Bearer public`
- `x-opencode-session` + `x-opencode-session-id` (+ `x-session-affinity`,
  `x-session-id`), same `ses_<12hex><14base62>` value, counter pinned to 1 —
  any `x-opencode-request` header 403s, so the shim strips it
- body carries opencode's own `read` + `shell` with exact descriptions/schemas
  (`FINGERPRINT_TOOLS` — verbatim from the CLI, do not reword); a caller tool
  reusing one of those names travels as `<name>_client`; a system note marks
  the appended tools as placeholders (upstream ignores prompt text)
- `tool_choice` never `"none"`; `stream: true` forced upstream (non-stream
  callers get an aggregated reply from the route layer)
- session is stable per thread (`sessionForThread`), never minted per request
  (that burns quota into `429 FreeUsageLimitError`)

Profile: `pnpm seed:opencode-free` creates/refreshes "Opencode Free"
(`agents: {daedalus}`, empty key, catalog from `/zen/v1/models` filtered to
`-free`). Daedalus-only v1: the agent speaks chat completions, so all models
are served over `/chat/completions` — a chat→responses translator for
responses-native models (muse-spark-*) is follow-up work if upstream stops
answering them on chat.

## Adding the next one (antigravity, claude-code oauth, codex oauth)

1. New `providers/<id>.ts` implementing `FreeProvider` (pure functions +
   `pnpm test:providers-<id>` in the same assert style).
2. One `detectProvider` entry (baseUrl match today; an explicit profile
   `provider` column when a URL is not enough to tell them apart).
3. Seed script + one line here. The shim, the agent defs and the schema stay
   untouched.
