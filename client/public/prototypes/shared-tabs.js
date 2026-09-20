/* ── The tab strip's pieces ──
   Layered on `shared-transcript.js`. One tab is the app's own object: the
   panel's mark (`PanelIcon` — a chat's is its agent's), its title, and its
   reading (`PanelStatusDot`), with the ⋮ and ✕ floated over the end. Nothing
   here is dockview; these are the shapes the variants arrange. */
(function () {
  const I = {
    more: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5h.01M12 12h.01M12 19h.01"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    pin: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6ZM12 14v7"/></svg>',
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
    chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 6 6 6-6 6"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-6.5A8 8 0 1 1 21 12Z"/></svg>',
    term: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/></svg>',
    diff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 3v12M6 21v-3M18 21V9M18 3v3M3 6h6M15 18h6"/></svg>',
    board: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="3" width="7" height="18" rx="1"/><rect x="14" y="3" width="7" height="11" rx="1"/></svg>',
    page: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z"/></svg>',
    web: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 8l10 5 10-5-10-5Z"/><path d="M2 17l10 5 10-5"/></svg>',
  }

  /* ── The scenario: a workspace with threads, a terminal, an editor. ── */
  const tabs = () => [
    { id: "t1", title: "Ship the composer width fix", icon: I.chat, status: "running", active: true },
    { id: "t2", title: "Index the rules table", icon: I.chat, status: "attention" },
    { id: "t3", title: "PM2 fork mode", icon: I.chat, status: "warn" },
    { id: "t4", title: "composer.tsx", icon: I.file, status: "dirty" },
    { id: "t5", title: "zsh", icon: I.term },
    { id: "t6", title: "Source control", icon: I.diff },
  ]

  /* One tab. `o.pinned` draws the pin before you point; `o.showControls` forces
     them (a focused tab draws both). */
  const tab = (t, o) => {
    const v = o || {}
    return `<div class="tab" data-id="${t.id}"${t.active ? " data-active" : ""}${v.title ? ` title="${t.title}"` : ""}>
      <span class="mark">${t.icon || ""}</span>
      ${t.pinned || v.pinned ? `<span class="pin">${I.pin}</span>` : ""}
      ${v.dot === false ? "" : t.status ? `<span class="sdot ${t.status}"></span>` : ""}
      <span class="t">${t.title}</span>
      <span class="controls"${v.showControls ? ' style="opacity:1;pointer-events:auto"' : ""}>
        <span class="ctrl">${I.more}</span>
        <span class="ctrl">${I.x}</span>
      </span>
    </div>`
  }

  const strip = (list, o) =>
    `<div class="strip${(o || {}).band ? " band" : ""}">${list.map((t) => tab(t)).join("")}<span class="void"></span><button class="group-add" title="New tab in this group">${I.plus}</button><button class="list" title="All tabs">${I.list}</button></div>`

  /* ── The scenario, with what each tab points at ──
     A chat takes the transcript from `shared-transcript.js`; the other kinds
     get a stand-in, so a strip variant can be pointed at any tab and still be
     about the strip. */
  const content = (id) => {
    if (id === "t1") return { kind: "chat", title: "Ship the composer width fix" }
    const map = {
      t2: { kind: "chat", title: "Index the rules table" },
      t3: { kind: "chat", title: "PM2 fork mode" },
      t4: { kind: "file", title: "composer.tsx", sub: "src/components/composer/composer.tsx" },
      t5: { kind: "terminal", title: "zsh", sub: "/var/www/daedalus-harness" },
      t6: { kind: "scm", title: "Source control", sub: "daedalus-harness" },
    }
    return map[id] || map.t1
  }

  /* The panel for a non-chat tab: a stand-in, quiet enough not to be the
     subject. A chat's panel is the transcript, which the caller renders. */
  const panel = (id) => {
    const c = content(id)
    if (c.kind === "chat") return null
    const body = {
      file: `<pre style="margin:0;font-family:ui-monospace,Menlo,monospace;font-size:12px;line-height:1.7;color:var(--muted-foreground);padding:20px 22px">1  import * as React from "react"\n2\n3  export function Composer() {\n4    return (\n5      &lt;div class="composer"&gt;\n6        &lt;ComposerStrip /&gt;\n7        &lt;ComposerCard /&gt;\n8      &lt;/div&gt;\n9    )\n10 }</pre>`,
      terminal: `<div style="padding:16px 18px;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;line-height:1.7;color:var(--muted-foreground)"><div><span style="color:var(--green)">➜</span> <span style="color:var(--step-think)">daedalus-harness</span> pnpm -C client exec tsc -b</div><div>✓ built in 3.1s</div><div style="opacity:.6">➜ daedalus-harness ▊</div></div>`,
      scm: `<div style="padding:14px 16px;font-size:12.5px"><div style="display:flex;align-items:center;gap:8px;padding:6px 0"><b style="font-weight:600">composer/composer.tsx</b><span style="margin-left:auto;color:var(--green)">+3</span><span style="color:var(--destructive)">−2</span></div><div style="display:flex;align-items:center;gap:8px;padding:6px 0"><b style="font-weight:600">index.css</b><span style="margin-left:auto;color:var(--green)">+11</span><span style="color:var(--destructive)">−7</span></div></div>`,
    }
    return `<div class="tv"><div class="tv-scroll" style="padding:0">${body[c.kind]}</div></div>`
  }

  window.TB = { I, tabs, tab, strip, content, panel }
})()
