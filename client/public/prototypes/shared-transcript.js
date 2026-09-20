/* ── Shared demo data + tiny DOM helpers, for the *transcript* prototypes ──
   One fake thread every variant renders, so the only thing that differs
   between two prototypes is the layout under test. Loaded as a classic
   script (not a module) so a variant works opened straight off the disk too.

   The scenario is a real one — a turn that read and edited files, ran a
   command, proposed a plan, then hit an error, asked a question, and is still
   working — because a transcript layout is judged on the crowded turn, not
   the two-message one. Nothing here is React, the server, or the app:
   `transcript.css` is the vocabulary, this file is what fills it. */
(function () {
  /* ── The thread ── */
  const U1 =
    "The composer narrows while it's unfocused and gives the width back on `:focus-within`. Every box in the unit — shelf, card, notices, scope row — measures against `--harness-composer-width`, so the whole unit breathes on every click in and out of the textarea. Make it one width that never moves."
  const A1 =
    "The measure is the cause, and it comes from a single `:focus-within` rule. I'll fix it where it is declared and check the one place that re-derives it."
  const INSIGHT =
    "Anything derived from the unit's width inherits the move. Declared once and read everywhere, the shelf and the card cannot disagree — which is the whole point of the token."
  const THOUGHT =
    "The shelf derives from `--composer`; if I change the measure I have to check that too, or the two surfaces drift apart in dark mode…"
  const A2 =
    "Done. `--harness-composer-width` is declared once on the unit and nothing re-derives it on focus. The shelf keeps its own surface — one tone darker than the card in both modes — and the unit is one width whether or not the caret is in it."
  const U2 = "and the shelf? it looked like a different tone in dark mode"

  const READ_1 = { k: "read", title: "Read", file: "composer.tsx", cap: "src/components/composer/composer.tsx", status: "" }
  const READ_2 = {
    k: "read",
    title: "Read",
    file: "index.css",
    cap: "src/index.css",
    status: "",
    body: "code",
    open: true,
  }
  const EDIT_1 = {
    k: "edit",
    title: "Edit",
    file: "composer.tsx",
    status: "",
    body: "diff",
    open: true,
  }
  const RUN_A = { k: "search", title: "Search", cap: "\"focus-within\" in client/src", status: "" }
  const EXEC_1 = { k: "execute", title: "Run", cap: "pnpm exec tsc -b", status: "", body: "out" }

  /* ── The flow, in order. Each variant walks this; layout is the only thing
     it is allowed to change. ── */
  const flow = () => [
    { t: "user", text: U1, at: "2m ago" },
    { t: "agent", text: A1, insight: INSIGHT },
    { t: "thought", preview: THOUGHT, text: THOUGHT, status: "" },
    {
      t: "run",
      summary: "read 2 files, edited 1",
      active: false,
      items: [READ_2, READ_1, EDIT_1],
    },
    { t: "agent", text: A2 },
    { t: "run", summary: "2 commands", items: [RUN_A, EXEC_1] },
    { t: "plan", todos: [
      { text: "Declare the width on the unit", done: true },
      { text: "Delete the :focus-within rule", done: true },
      { text: "Re-derive the shelf off --composer", done: false, active: true },
      { text: "Check dark mode", done: false },
    ] },
    { t: "user", text: U2, at: "now" },
    { t: "agent", text: "Fair — it wore `--surface`, which is the page's ground, and in a light palette that resolves to the same tone. It wears `--shelf` now, derived and one step darker in both modes." },
    {
      t: "error",
      title: "Couldn't start the agent process",
      detail: "spawn EACCES — /usr/local/bin/daedalus-agent",
    },
    { t: "notice", text: "Turn cancelled", continue: true },
  ]

  const queuedFlow = (base) => base.concat([{ t: "queue", text: "and check it at 320px too" }, { t: "working", text: "Working…" }])

  /* ── The sidebar, trimmed. The sidebar options own that surface; this one is
     here so the two-column shell reads as the app. ── */
  const SIDEBAR = [
    { tier: "Needs you", rows: [
      { t: "Index the rules table", s: "waiting", active: false },
      { t: "Pricing page copy", s: "waiting" },
      { t: "PM2 fork mode", s: "failed" },
    ] },
    { tier: "Today", rows: [
      { t: "Ship the composer width fix", s: "running", active: true },
      { t: "Replay coalescing", s: "idle" },
      { t: "Terminal key row", s: "idle" },
    ] },
    { tier: "Yesterday", rows: [
      { t: "Backup import", s: "idle" },
      { t: "Onboarding rewrite", s: "idle" },
    ] },
  ]

  /* ── Icons ── */
  const I = {
    chev: '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 18 6-6-6-6"/></svg>',
    read: '<svg class="face" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/></svg>',
    edit: '<svg class="face" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4l10-10-4-4L4 16Z"/><path d="m14 6 4 4"/></svg>',
    search: '<svg class="face" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    exec: '<svg class="face" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/></svg>',
    think: '<svg class="face" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 3 3h2a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Z"/><path d="M12 5a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-3 3h-1"/></svg>',
    other: '<svg class="face" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 6.5a4 4 0 1 0 5 5L21 10l-7 7-3-3 7-7Z"/><path d="m6 14 4 4"/><path d="m3 21 3-1 1-3-4-4-2 5Z"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    searchIc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 4.3 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6Z"/><path d="m9 12 2 2 4-4"/></svg>',
    ask: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.35-1 .9-1 1.7M12 17h.01"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7Z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 13 4 4L19 7"/></svg>',
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
    spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.5 12.5 21a5 5 0 0 1-7-7l8-8a3.5 3.5 0 0 1 5 5l-8 8a2 2 0 0 1-3-3l7.5-7.5"/></svg>',
    bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  }

  /* ── Escaping + the shapes ── */
  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))

  const KIND_ICON = { read: I.read, edit: I.edit, search: I.search, execute: I.exec, think: I.think }

  /* A step: `kind` gives the mark and its accent, `status` the failure colour. */
  const step = (s) => {
    const kind = s.k || "other"
    const icon = KIND_ICON[kind] || I.other
    const expandable = !!s.body
    const cap = s.cap ? `<span class="cap${s.mono === false ? "" : " m"}">${esc(s.cap)}</span>` : ""
    const file = s.file ? `<span class="punct">·</span><span class="file-chip">${esc(s.file)}</span>` : ""
    const status = s.status || ""
    const meta = s.meta
      ? `<span class="meta">${s.meta.map((m, i) => (i ? `<span class="sep">·</span>` : "") + m).join("")}</span>`
      : ""
    const body = s.body ? `<div class="step-detail">${payload(s.body, s)}</div>` : ""
    return `
      <div class="step${expandable ? " expandable" : ""}" data-kind="${kind}" data-status="${status}"${s.open || (expandable && s.open === undefined && s.body === "diff") ? " data-open" : ""}>
        <div class="step-rowz">
          <span class="mark"><span class="chip"></span>${icon}${expandable ? I.chev : ""}</span>
          <span class="body">
            <span class="line"><span class="title${s.mono === false ? "" : " m"}">${esc(s.title)}</span>${file}</span>
            ${cap}
          </span>
          ${meta}
        </div>
        ${body}
      </div>`
  }

  const payload = (kind, s) => {
    if (kind === "code")
      return `<div class="pane"><pre>/* one width, declared once */
.composer-shell {
  width: var(--harness-composer-width);
}
/* and NOT this: */
/* .composer-shell:focus-within { width: 100%; } */</pre></div>`
    if (kind === "diff")
      return `<div class="pane"><pre class="diff"><span class="ctx">@@ composer.tsx:118 @@</span><span class="del">-  :focus-within { width: 100% }</span><span class="add">+  width: var(--harness-composer-width)</span><span class="ctx"> </span><span class="add">+  /* the unit does not re-measure on focus */</span></pre></div>`
    if (kind === "out")
      return `<div class="pane"><pre>$ pnpm exec tsc -b
✓ built in 3.1s</pre></div>`
    return `<div class="pane-pad">${esc(s && s.text ? s.text : "")}</div>`
  }

  /* ── Rows. The variants call these; a variant that reshapes a row does its
     own thing on top of them rather than editing the flow. ── */
  const run = (r, open) =>
    r.t === "run"
      ? `<div class="step" data-kind="run">
           <button class="run-head" aria-expanded="${open ? "true" : "false"}">
             ${I.chev}
             <span class="stack">${r.items.slice(0, 3).map((it) => `<i style="background:color-mix(in oklab, var(--step-${it.k === "execute" ? "command" : it.k === "think" ? "think" : "tool"}) 75%, var(--card))">${it.k[0].toUpperCase()}</i>`).join("")}</span>
             <span class="sum">${esc(r.summary)}</span>
             ${r.failed ? `<span class="meta"><span class="bad">${r.failed} failed</span></span>` : ""}
           </button>
           ${open ? `<div class="rail">${r.items.map((it) => step(it)).join("")}</div>` : ""}
         </div>`
      : ""

  const user = (r) => `
    <div class="u-msg">
      <div class="u-bubble">${esc(r.text)}</div>
      ${r.at ? `<div class="u-meta">${esc(r.at)}</div>` : ""}
    </div>`

  const agent = (r) => `
    <div class="a-msg">
      <div class="prose"><p>${esc(r.text).replace(/`([^`]+)`/g, "<code>$1</code>")}</p></div>
      ${
        r.insight
          ? `<aside class="card" style="border-left:2px solid color-mix(in oklab, var(--primary) 45%, transparent)"><span class="lab">★ Insight</span><div class="prose"><p>${esc(r.insight).replace(/`([^`]+)`/g, "<code>$1</code>")}</p></div></aside>`
          : ""
      }
    </div>`

  const thought = (r) => step({ k: "think", title: r.preview, status: r.status, body: "text", text: r.text })

  const plan = (r) => `
    <div class="card" data-plan>
      <span class="lab">Plan</span>
      <div class="todos">
        ${r.todos.map((td) => `<div class="todo" data-done="${!!td.done}" data-active="${!!td.active}"><span class="box">${td.done ? I.check : ""}</span><span class="txt">${esc(td.text)}</span></div>`).join("")}
      </div>
    </div>`

  const error = (r) => `
    <div class="card bad">
      <div class="card-head">${I.alert}<span>${esc(r.title)}</span></div>
      <p class="mono" style="font-size:12px">${esc(r.detail)}</p>
      <div class="actions"><button class="btn">Retry</button></div>
    </div>`

  const notice = (r) => `
    <div class="notice">${r.text}${r.continue ? `<button class="btn ghost" style="height:24px;padding:0 8px;font-size:11px">${I.play} Continue</button>` : ""}</div>`

  const ask = (r) => `
    <div class="card warn">
      <div class="card-head">${I.ask}<span>${esc(r.q)}</span></div>
      ${r.options.map((o) => `<button class="opt"><span class="k"></span>${esc(o)}</button>`).join("")}
    </div>`

  const approval = (r) => `
    <div class="card">
      <div class="card-head">${I.shield}<span>${esc(r.title)}</span></div>
      <p>${esc(r.detail)}</p>
      <div class="actions"><button class="btn solid">Allow</button><button class="btn">Allow once</button><button class="btn ghost">Deny</button></div>
    </div>`

  const queue = (r) => `<div class="qrow">${esc(r.text)}<span class="x">${I.x}</span></div>`
  const working = (r) => `<div class="working"><span class="mark" style="width:12px;height:12px;border-radius:4px;background:linear-gradient(140deg,var(--violet),var(--blue))"></span><span class="shimmer">${esc(r.text || "Working…")}</span></div>`

  const ROW = { user, agent, thought, error, notice, ask, approval, queue, working }

  /** Render the flow. `open` is whether a run's steps are shown; `runOf` can
      override one run by index. */
  const render = (rows, opts) => {
    const o = opts || {}
    return rows
      .map((r, i) => {
        if (r.t === "run") return run(r, o.runs ? o.runs(r, i) !== false : false)
        return (ROW[r.t] || (() => ""))(r)
      })
      .join("")
  }

  /* ── The docked composer. The floor (project/tools/context) is permanently
     true; the pile above the textarea holds the queue. ── */
  const composer = (o) => {
    const opts = o || {}
    return `
    <div class="dock">
      <div class="composer">
        <div class="composer-card">
          <div class="shelf">${(opts.queue || []).map((q) => `<div class="qrow">${esc(q)}<span class="x">${I.x}</span></div>`).join("")}</div>
          <div class="tbox">
            <button class="pill" title="Add to the message" style="height:30px">${I.plus}</button>
            <div class="ph">${esc(opts.placeholder || "Reply…")}</div>
            <button class="send${opts.ready ? " on" : ""}">${I.up}</button>
          </div>
          <div class="shelf shelf-bottom">
            <button class="pill"><span class="mk" style="background:oklch(0.55 0.18 292)">D</span>daedalus-harness</button>
            <button class="pill">Tools</button>
            <span class="spacer"></span>
            <button class="pill">${opts.thinking ? "Thinking" : ""}</button>
            <button class="pill" title="Context window"><span class="ring"></span>32%</button>
          </div>
        </div>
      </div>
    </div>`
  }

  /* ── The sidebar, into an element ── */
  const sidebar = (el) => {
    el.innerHTML = `
      <header class="sb-head">
        <div class="brand-row">
          <span class="logo"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"><path d="M12 2 2 7l10 5 10-5-10-5Z"/><path d="M2 17l10 5 10-5"/><path d="M12 12v10"/></svg></span>
          <span class="name">Daedalus</span>
          <span class="spacer"></span>
          <button class="icon-btn">${I.bell}</button>
          <button class="icon-btn">${I.gear}</button>
        </div>
        <button class="primary">${I.plus}New thread<kbd>⌘N</kbd></button>
      </header>
      <div class="sb-scroll">
        ${SIDEBAR.map(
          (g) => `
          <div class="tier">${g.tier}<span class="n">${g.rows.length}</span></div>
          ${g.rows
            .map(
              (r) =>
                `<button class="srow" data-active="${!!r.active}">${
                  r.s && r.s !== "idle" ? `<span class="dot ${r.s}"></span>` : ""
                }<span class="t">${esc(r.t)}</span></button>`
            )
            .join("")}`
        ).join("")}
      </div>`
  }

  /* `d` flips light/dark, as on every other prototype page. */
  const theme = () => {
    document.addEventListener("keydown", (e) => {
      if (e.key === "d" && !e.metaKey && !e.ctrlKey && !e.target.closest("input, textarea")) {
        document.documentElement.classList.toggle("dark")
      }
    })
  }

  /* The tab strip, so a variant page is its own layout and nothing else. */
  const tabs = (active) => `
    <div class="tabs">
      <button class="tab" data-active="true"><span class="dot running" style="width:6px;height:6px"></span><span class="t">${esc(active)}</span></button>
      <button class="tab"><span class="t">Index the rules table</span></button>
      <button class="tab" style="min-width:30px;justify-content:center;padding:0">${I.plus}</button>
    </div>`

  /* The four things a variant page builds every time: the shell, the sidebar,
     the transcript column and the dock. */
  const page = (root, html) => {
    root.innerHTML = html
    const side = root.querySelector("[data-sidebar]")
    if (side) sidebar(side)
    theme()
  }

  window.TX = { flow, queuedFlow, render, step, run, user, agent, thought, plan, error, notice, ask, approval, queue, working, composer, sidebar, tabs, page, esc, I }
})()
