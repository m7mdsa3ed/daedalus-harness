/* Selector treatments for the C5-C7 composer-strip prototypes. */
(function () {
  const options = [
    { id: "files", label: "Files", count: "3", icon: CX.I.files },
    { id: "history", label: "History", count: "2", icon: CX.I.clockIc },
    { id: "commands", label: "Commands", count: "1", icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m4 17 6-6-6-6M12 19h8"/></svg>' },
  ]

  const panels = {
    files: `<div class="files"><span class="fchip">architecture.png<span class="x">${TX.I.x}</span></span><span class="fchip">notes.md<span class="x">${TX.I.x}</span></span><span class="fchip">error-log.txt<span class="x">${TX.I.x}</span></span></div>`,
    history: `<div class="item-history"><div>${CX.I.clockIc}<span>Refactor the session store to support drafts</span><time>2m</time></div><div>${CX.I.clockIc}<span>Find where reconnect retries are scheduled</span><time>1h</time></div></div>`,
    commands: `<div class="item-command"><code>pnpm test</code><span class="item-kind">script</span><span class="item-hint">Run in project</span></div>`,
  }

  function selector(style, selected) {
    return `<div class="item-proto-pile" data-item-style="${style}"><div class="item-proto-rail" role="group" aria-label="Composer items">${options.map((item) => {
      const active = item.id === selected
      if (style === "tiles") return `<button class="item-proto-trigger item-tile" type="button" data-item="${item.id}" aria-label="${item.label}, ${item.count}" aria-pressed="${active}">${item.icon}<span class="item-count">${item.count}</span></button>`
      if (style === "chips") return `<button class="item-proto-trigger item-chip" type="button" data-item="${item.id}" aria-pressed="${active}">${item.icon}<span>${item.label}</span><span class="item-count">${item.count}</span></button>`
      return `<button class="item-proto-trigger item-tab" type="button" data-item="${item.id}" aria-pressed="${active}">${item.icon}<span>${item.label}</span><span class="item-count">${item.count}</span></button>`
    }).join("")}</div><div class="item-proto-panel shelf-card" data-item-panel>${panels[selected]}</div></div>`
  }

  CX.itemsComposer = function (style, active = "files") {
    const html = CX.composer({ text: "Ask about these files…", footTodos: "3/4", footFiles: 3 })
    return html.replace('<div class="cmp-card">', `${selector(style, active)}<div class="cmp-card">`)
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-item]")
    if (!button) return
    const pile = button.closest("[data-item-style]")
    if (!pile) return
    const selected = button.dataset.item
    pile.querySelectorAll("[data-item]").forEach((candidate) => {
      const active = candidate === button
      candidate.setAttribute("aria-pressed", String(active))
    })
    pile.querySelector("[data-item-panel]").innerHTML = panels[selected]
  })
})()
