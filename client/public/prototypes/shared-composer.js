/* ── Pieces the composer and tab prototypes share ──
   Layered on `shared-transcript.js` (loading first): the icons `TX.I` does not
   carry, the reading cluster, the project chip, and the shelf's cards. Nothing
   here is React — it is the shapes the variants arrange, so a variant is its
   layout and nothing else. */
(function () {
  const I = {
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
    sparkle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8Z"/><path d="M19 15l.7 1.8L21.5 17.5l-1.8.7L19 20l-.7-1.8L16.5 17.5l1.8-.7Z"/></svg>',
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11M9 12h11M9 18h11"/><path d="m3.5 6 1 1 1.5-1.7M3.5 12l1 1 1.5-1.7M3.5 18l1 1 1.5-1.7"/></svg>',
    files: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/></svg>',
    bot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01"/></svg>',
    wrench: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 6.5a4 4 0 1 0 5 5L21 10l-7 7-3-3 7-7Z"/><path d="m6 14 4 4m-7 3 3-1 1-3-4-4-2 5Z"/></svg>',
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 7a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>',
    clockIc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    hash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 9h14M4 15h14M10 3 8 21M16 3l-2 18"/></svg>',
    dot2: '<span style="width:6px;height:6px;border-radius:999px;background:var(--amber);display:block"></span>',
  }

  const project = () => `<span class="mk" style="background:oklch(0.55 0.18 292)">D</span>daedalus-harness`

  /* The reading cluster — one kind of question, one shape (a 24px trigger). */
  const readings = (o) => {
    const r = o || {}
    return `<span class="readings">
      ${r.config ? `<button class="reading" title="Model and effort">${I.sparkle}</button>` : ""}
      ${r.todos ? `<button class="reading" title="Plan 3 of 4">${I.list}<span>${r.todos}</span></button>` : ""}
      ${r.agents ? `<button class="reading" title="2 subagents running">${I.bot}<span>${r.agents}</span></button>` : ""}
      ${r.files ? `<button class="reading" title="3 files changed">${I.files}<span>${r.files}</span></button>` : ""}
      <button class="reading${r.warn ? " warn" : ""}" title="Context window">${r.pct || "32%"}<span class="ring"></span></button>
    </span>`
  }

  /* The shelf's cards. `front` is the id in front — its body is drawn; every
     other card is a 14px sliver above it, which is the pile's whole tell. */
  const shelf = (order, front) => {
    const open = order.find((c) => c.id === front)
    const behind = order.filter((c) => c.id !== front)
    return `<div class="pile">
      ${behind
        .map((c) => `<button class="peek" title="${c.label}">${c.icon || ""}${c.badge ? `<span class="badge">${c.badge}</span>` : ""}</button>`)
        .join("")}
      <div class="shelf-card">${open.body}</div>
    </div>`
  }

  /* The cards of the scenario: a queued message, a checklist, two files. */
  const cards = {
    queue: {
      id: "queue",
      label: "1 queued message",
      icon: I.clockIc,
      badge: 1,
      body: `<div class="shelf-row"><span class="ttl">Queued · <b>and check it at 320px too</b></span><span class="x">${TX.I.x}</span></div>`,
    },
    todos: {
      id: "todos",
      label: "Plan 3 of 4",
      icon: I.list,
      badge: 3,
      body: [
        { text: "Declare the width on the unit", done: true },
        { text: "Delete the :focus-within rule", done: true },
        { text: "Re-derive the shelf off --composer", done: true },
        { text: "Check dark mode", active: true },
      ]
        .map(
          (t) =>
            `<div class="shelf-todo" data-done="${!!t.done}" data-active="${!!t.active}"><span class="box">${
              t.done ? TX.I.check : ""
            }</span><span class="txt">${t.text}</span></div>`
        )
        .join(""),
    },
    files: {
      id: "files",
      label: "2 attachments",
      icon: I.files,
      badge: 2,
      body: `<div class="files"><span class="fchip">composer.tsx<span class="x">${TX.I.x}</span></span><span class="fchip">index.css<span class="x">${TX.I.x}</span></span></div>`,
    },
  }

  /* The composer unit. `o.shelf` is the front card's id (or false for none);
     `o.inline` drops the glass/frost for a composer in the flow. */
  const composer = (o) => {
    const v = o || {}
    const front = v.shelf || null
    const order = (v.order || ["queue", "todos", "files"]).map((id) => cards[id])
    return `<div class="cmp${v.inline ? " cmp-inline" : ""}${v.inline ? "" : " dock"}">
        ${v.notice ? `<div class="notice-line">${TX.I.alert}<span>${v.notice}</span><button class="btn">Reconnect</button></div>` : ""}
        ${front ? shelf(order, front) : ""}
        <div class="cmp-card">
          <div class="cmp-text${v.typed ? " typed" : ""}">${v.text || "Message the agent…"}${v.caret ? '<span class="caret"></span>' : ""}</div>
          <div class="cmp-toolbar">
            <button class="rnd disc" title="Add to the message">${TX.I.plus}</button>
            <button class="model" title="Model and effort">${v.model || "claude-sonnet-4"}</button>
            <span class="spacer"></span>
            ${v.est ? `<span class="est">${v.est}</span>` : ""}
            <button class="rnd" title="Enhance prompt">${I.sparkle}</button>
            <button class="rnd" title="Voice input">${I.mic}</button>
            ${
              v.running
                ? `<button class="rnd stop" title="Stop">${I.stop}</button>`
                : `<button class="rnd send" title="Send">${I.send}</button>`
            }
          </div>
          <div class="cmp-foot">
            <button class="fpill" title="Project">${project()}</button>
            <button class="fpill" title="Tools and skills">${I.wrench}Tools<span style="opacity:.6">3</span></button>
            ${readings({ config: true, todos: v.footTodos || "3/4", agents: v.agents, files: v.footFiles || 3 })}
          </div>
        </div>
    </div>`
  }

  window.CX = { I, composer, cards, shelf, readings, project }
})()
