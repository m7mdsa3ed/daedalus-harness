/* ── Shared demo data + tiny DOM helpers ──
   One fake workspace every variant renders, so the only thing that differs
   between two prototypes is the design. Included as a classic script (not a
   module) so a prototype works opened straight from the file system too. */
(function () {
  const PROJECTS = [
    { id: "harness", name: "daedalus-harness", short: "harness", hue: 292, initial: "D", count: 6 },
    { id: "website", name: "marketing-site", short: "site", hue: 210, initial: "M", count: 3 },
    { id: "infra", name: "infra", short: "infra", hue: 150, initial: "I", count: 2 },
    { id: "docs", name: "handbook", short: "docs", hue: 60, initial: "H", count: 1 },
  ]

  const THREADS = [
    { id: "t1", t: "Ship the composer width fix", p: "harness", s: "running", when: "now", active: true, files: 7, wrote: "2m ago" },
    { id: "t2", t: "Index the rules table", p: "harness", s: "waiting", when: "4m", asks: "Which table should the index go on?" },
    { id: "t3", t: "Pricing page copy", p: "website", s: "waiting", when: "22m", asks: "Two headline candidates — which one?" },
    { id: "t4", t: "PM2 fork mode", p: "infra", s: "failed", when: "1h", err: "spawn EACCES" },
    { id: "t5", t: "Replay coalescing", p: "harness", s: "idle", when: "3h" },
    { id: "t6", t: "Trim the OG images", p: "website", s: "idle", when: "5h" },
    { id: "t7", t: "Terminal key row", p: "harness", s: "idle", when: "9h" },
    { id: "t8", t: "Onboarding rewrite", p: "docs", s: "idle", when: "1d" },
    { id: "t9", t: "Backup import", p: "infra", s: "idle", when: "1d" },
    { id: "t10", t: "Scratch — bridge profiling", p: "harness", s: "idle", when: "2d" },
    { id: "t11", t: "Session journal replay", p: "harness", s: "idle", when: "2d" },
    { id: "t12", t: "Font subsetting", p: "website", s: "idle", when: "4d" },
  ]

  const DAYS = ["Today", "Yesterday", "Earlier"]

  const project = (id) => PROJECTS.find((p) => p.id === id) || PROJECTS[0]
  const colour = (id) => `oklch(0.62 0.17 ${project(id).hue})`

  /* Both copies say the same thing; scripts mutate their own. */
  const data = () => ({
    projects: PROJECTS.map((p) => ({ ...p })),
    threads: THREADS.map((t) => ({ ...t })),
  })

  const HTML = (strings, ...values) => strings.reduce((out, s, i) => out + s + (values[i] ?? ""), "")

  const dot = (s) => (s && s !== "idle" ? HTML`<span class="dot ${s}"></span>` : "")
  const mark = (p) =>
    HTML`<span class="mark" style="background:oklch(0.55 0.18 ${p.hue})">${p.initial}</span>`
  const tag = (id) => HTML`<span class="tag"><i style="background:${colour(id)}"></i>${project(id).short}</span>`

  /* The list a variant renders, in the order the data gives it. */
  const inDay = (day) =>
    day === "Today" ? (t) => /^(now|\d+m|\d+h)$/.test(t.when)
      : day === "Yesterday" ? (t) => t.when === "1d"
        : (t) => !/^(now|\d+m|\d+h|1d)$/.test(t.when)

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))

  /* ── Tiny event helpers, so a variant's script stays about the design ── */
  const on = (root, selector, handler) => {
    for (const el of root.querySelectorAll(selector)) {
      el.addEventListener("click", (event) => {
        if (event.target.closest("[data-no-activate]")) return
        handler(el, event)
      })
    }
  }
  /* A fold: `data-fold` names the element it hides, `aria-expanded` is the state. */
  const folds = (root) => {
    on(root, "[data-fold]", (el) => {
      const open = el.getAttribute("aria-expanded") === "true"
      el.setAttribute("aria-expanded", String(!open))
      const target = root.querySelector(`[data-folded="${el.dataset.fold}"]`)
      if (target) target.hidden = open
    })
  }
  const theme = () => {
    /* `d` flips light/dark; `t` walks the density classes some variants accept. */
    document.addEventListener("keydown", (e) => {
      if (e.key === "d" && !e.metaKey && !e.ctrlKey && !e.target.closest("input")) {
        document.documentElement.classList.toggle("dark")
      }
    })
  }
  const render = (root, html) => { root.innerHTML = html; folds(root); on(root, "[data-act]", (el) => el.classList.toggle("is-on")) }

  window.PROTO = {
    data, HTML, esc, dot, mark, tag, inDay, DAYS, project, colour,
    on, folds, theme, render,
    ICONS: {
      plus: HTML`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
      search: HTML`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`,
      clock: HTML`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
      folder: HTML`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 7a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>`,
      thread: HTML`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-6.5A8 8 0 1 1 21 12Z"/></svg>`,
      inbox: HTML`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>`,
      grid: HTML`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>`,
      board: HTML`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="3" width="7" height="18" rx="1"/><rect x="14" y="3" width="7" height="11" rx="1"/></svg>`,
      gear: HTML`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`,
      star: HTML`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="m12 3 2.9 5.9 6.1.9-4.5 4.3 1.1 6.1L12 17.3 6.4 20.2l1.1-6.1L3 9.8l6.1-.9Z"/></svg>`,
      chev: HTML`<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 18 6-6-6-6"/></svg>`,
      bolt: HTML`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z"/></svg>`,
      calendar: HTML`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/></svg>`,
      trash: HTML`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>`,
    },
  }
})()
