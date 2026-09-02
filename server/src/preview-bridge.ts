/* ── Preview bridge ──
 *
 * The script `preview-proxy.ts` injects into every HTML page a project's dev
 * server answers. It runs *inside* the sandboxed preview iframe, in the app
 * being built, and it is the only channel between that app and the panel
 * around it: it reports where the app is (`daedalus:ready`), what broke
 * (`daedalus:error` — thrown errors, rejections, console.error, Vite's own
 * overlay events, and a `fetch` that failed or answered 4xx/5xx), what the
 * app logged (`daedalus:console`, every level, so the panel can show a
 * console without devtools), and what the user pointed at (`daedalus:pick`,
 * with the React component chain and an HTML snippet so the agent can find
 * the file), and it takes four commands back (`daedalus:inspect`,
 * `daedalus:navigate`, `daedalus:history`, `daedalus:reload`). The contract is `PreviewMessage`/`ParentMessage` in
 * docs; the panel verifies `event.source` because a sandboxed frame's origin
 * is opaque and `"*"` is the only target it can post to.
 *
 * Shipped as a string, not a `.js` beside it: `tsc` emits only what it
 * compiles, so a sibling asset would be in `src/` and missing from `dist/` —
 * the built server is the one that is deployed. Plain ES2020, no build step,
 * and **it must never throw into the app** — every hook is wrapped, because a
 * bridge that crashes the page it is watching reports its own bug as the
 * app's, and the user cannot tell the two apart.
 *
 * No backticks and no `${` inside the script: it lives in a template literal.
 */
export const PREVIEW_BRIDGE_JS = String.raw`(function () {
  "use strict";
  if (window.__daedalusBridge) return;
  window.__daedalusBridge = true;

  /* ── Where we are ── */
  var script = document.currentScript;
  var src = (script && script.src) || "";
  // ".../__daedalus/bridge.js" → the preview prefix, with its trailing slash.
  var marker = src.indexOf("__daedalus/bridge.js");
  var prefix = marker >= 0 ? new URL(src.slice(0, marker)).pathname : "/";
  if (prefix.charAt(prefix.length - 1) !== "/") prefix += "/";

  function post(msg) {
    try {
      if (window.parent && window.parent !== window) window.parent.postMessage(msg, "*");
    } catch (e) {
      /* an opaque parent, or a message that cannot be cloned — nothing to do */
    }
  }

  /** The in-app path: location minus the preview prefix, always starting "/". */
  function appPath() {
    var path = location.pathname + location.search;
    var base = prefix.slice(0, -1);
    if (base && path.indexOf(base) === 0) path = path.slice(base.length);
    if (path.charAt(0) !== "/") path = "/" + path;
    return path;
  }

  function ready() {
    var title = "";
    try { title = String(document.title || "").slice(0, 120); } catch (e) {}
    post({ type: "daedalus:ready", path: appPath(), title: title });
  }

  /* ── Errors, deduped ── */
  var lastMessage = "";
  var lastAt = 0;
  function report(err) {
    try {
      var message = String(err.message || "");
      var now = Date.now();
      if (message === lastMessage && now - lastAt < 1000) return;
      lastMessage = message;
      lastAt = now;
      err.type = "daedalus:error";
      post(err);
    } catch (e) {
      /* never into the app */
    }
  }

  function describe(value) {
    try {
      if (value instanceof Error) return value.stack || value.message || String(value);
      if (typeof value === "string") return value;
      if (value === undefined) return "undefined";
      return JSON.stringify(value);
    } catch (e) {
      return String(value);
    }
  }

  try {
    window.addEventListener("error", function (ev) {
      try {
        var error = ev.error;
        report({
          kind: "runtime",
          message: (error && error.message) || ev.message || "Unknown error",
          stack: error && error.stack ? String(error.stack) : undefined,
          file: ev.filename || undefined,
          line: ev.lineno || undefined,
          column: ev.colno || undefined,
        });
      } catch (e) {}
    });
    window.addEventListener("unhandledrejection", function (ev) {
      try {
        var reason = ev.reason;
        report({
          kind: "rejection",
          message: (reason && reason.message) || describe(reason) || "Unhandled rejection",
          stack: reason && reason.stack ? String(reason.stack) : undefined,
        });
      } catch (e) {}
    });
  } catch (e) {}

  /* ── Console ──
     Every level is forwarded as a daedalus:console line (the panel draws
     the console), and error additionally lands as an error. Text is cut
     at 2000 characters and bursts at 200 lines per second: a render loop
     logging on every frame must not turn the message channel into the
     bottleneck it is complaining about. */
  var CONSOLE_LEVELS = ["log", "info", "warn", "error", "debug"];
  var consoleWindowAt = 0;
  var consoleWindowCount = 0;
  function forwardConsole(level, args) {
    try {
      var now = Date.now();
      if (now - consoleWindowAt > 1000) { consoleWindowAt = now; consoleWindowCount = 0; }
      if (++consoleWindowCount > 200) return;
      var parts = [];
      for (var i = 0; i < args.length; i++) parts.push(describe(args[i]));
      var text = parts.join(" ");
      if (text.length > 2000) text = text.slice(0, 2000) + "…";
      post({ type: "daedalus:console", level: level, text: text, at: now });
      if (level === "error") {
        var first = null;
        for (var j = 0; j < args.length; j++) {
          if (args[j] instanceof Error) { first = args[j]; break; }
        }
        report({
          kind: "console",
          message: text.split("\n")[0].slice(0, 500),
          stack: first && first.stack ? String(first.stack) : undefined,
        });
      }
    } catch (e) {}
  }
  try {
    CONSOLE_LEVELS.forEach(function (level) {
      var original = console[level];
      if (typeof original !== "function") return;
      console[level] = function () {
        forwardConsole(level, arguments);
        return original.apply(console, arguments);
      };
    });
  } catch (e) {}

  /* ── Network ──
     A fetch that rejects (the server is down, CORS, a bad URL) or answers
     4xx/5xx is an error the user cannot otherwise see without devtools. The
     body's first 300 characters travel as the detail — usually the API's own
     message. The bridge's own Vite import is exempt, and so is anything
     under the preview prefix's __daedalus/. */
  try {
    var nativeFetch = window.fetch;
    if (typeof nativeFetch === "function") {
      window.fetch = function (input, init) {
        var url = "";
        var method = "GET";
        try {
          url = typeof input === "string" ? input : input && input.url ? input.url : String(input);
          method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
        } catch (e) {}
        var shown = url;
        try {
          var u = new URL(url, location.href);
          shown = u.pathname + u.search;
          var base = prefix.slice(0, -1);
          if (base && shown.indexOf(base) === 0) shown = shown.slice(base.length) || "/";
        } catch (e) {}
        var p = nativeFetch.apply(this, arguments);
        if (shown.indexOf("/__daedalus/") >= 0 || shown.indexOf("/@vite/") >= 0) return p;
        return p.then(
          function (res) {
            try {
              if (res && res.status >= 400) {
                var clone = res.clone();
                clone.text().then(function (body) {
                  var snippet = (body || "").replace(/\s+/g, " ").trim().slice(0, 300);
                  report({
                    kind: "network",
                    message: method + " " + shown + " → " + res.status + (res.statusText ? " " + res.statusText : ""),
                    stack: snippet || undefined,
                  });
                }, function () {
                  report({ kind: "network", message: method + " " + shown + " → " + res.status });
                });
              }
            } catch (e) {}
            return res;
          },
          function (err) {
            try {
              report({
                kind: "network",
                message: method + " " + shown + " failed: " + ((err && err.message) || String(err)),
              });
            } catch (e) {}
            throw err;
          }
        );
      };
    }
  } catch (e) {}

  /* Vite's own overlay events: a compile error never reaches window.onerror,
     it arrives on the HMR socket. Absent in a production build, hence the
     catch on the import. */
  try {
    var hmr = import(prefix + "@vite/client");
    hmr.then(function (m) {
      try {
        if (!m || typeof m.createHotContext !== "function") return;
        var hot = m.createHotContext("/__daedalus");
        hot.on("vite:error", function (p) {
          var e = (p && p.err) || {};
          report({
            kind: "vite",
            message: e.message || "Vite error",
            stack: e.stack || undefined,
            file: e.id || (e.loc && e.loc.file) || undefined,
            line: e.loc && e.loc.line,
            column: e.loc && e.loc.column,
            frame: e.frame || undefined,
          });
        });
        hot.on("vite:ws:disconnect", function () {
          report({ kind: "disconnect", message: "The dev server connection was lost." });
        });
      } catch (e) {}
    }, function () {});
  } catch (e) {}

  /* ── Navigation ── */
  try {
    var pushState = history.pushState;
    var replaceState = history.replaceState;
    history.pushState = function () {
      var r = pushState.apply(this, arguments);
      setTimeout(ready, 0);
      return r;
    };
    history.replaceState = function () {
      var r = replaceState.apply(this, arguments);
      setTimeout(ready, 0);
      return r;
    };
    window.addEventListener("popstate", function () { setTimeout(ready, 0); });
  } catch (e) {}

  /* ── Element picker ── */
  var picking = false;
  var overlay = null;
  var label = null;
  var hovered = null;

  function ensureOverlay() {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.setAttribute("data-daedalus", "overlay");
    var s = overlay.style;
    s.position = "fixed";
    s.pointerEvents = "none";
    s.zIndex = "2147483646";
    s.border = "2px solid #3b82f6";
    s.background = "rgba(59,130,246,0.12)";
    s.borderRadius = "3px";
    s.boxSizing = "border-box";
    s.display = "none";
    s.transition = "all 60ms ease-out";
    label = document.createElement("div");
    var l = label.style;
    l.position = "absolute";
    l.left = "0";
    l.top = "-22px";
    l.font = "11px/18px ui-monospace, SFMono-Regular, Menlo, monospace";
    l.padding = "0 6px";
    l.background = "#3b82f6";
    l.color = "#fff";
    l.borderRadius = "3px";
    l.whiteSpace = "nowrap";
    l.maxWidth = "60vw";
    l.overflow = "hidden";
    l.textOverflow = "ellipsis";
    overlay.appendChild(label);
    (document.body || document.documentElement).appendChild(overlay);
  }

  function isOurs(el) {
    return !!(el && el.getAttribute && el.getAttribute("data-daedalus"));
  }

  function componentOf(el) {
    try {
      var node = el;
      while (node) {
        var keys = Object.keys(node);
        var key = null;
        for (var i = 0; i < keys.length; i++) {
          if (keys[i].indexOf("__reactFiber$") === 0) { key = keys[i]; break; }
        }
        if (key) {
          var fiber = node[key];
          var hops = 0;
          while (fiber && hops++ < 200) {
            var t = fiber.type;
            if (typeof t === "function") return t.displayName || t.name || undefined;
            if (t && typeof t === "object" && (t.displayName || (t.render && t.render.name)))
              return t.displayName || t.render.name;
            fiber = fiber.return;
          }
          return undefined;
        }
        node = node.parentElement;
      }
    } catch (e) {}
    return undefined;
  }

  /** The React component ancestry of an element, nearest first, capped —
      "Button < TodoItem < TodoList" is what tells the agent which file. */
  function componentsOf(el) {
    var out = [];
    try {
      var node = el;
      var key = null;
      while (node && !key) {
        var keys = Object.keys(node);
        for (var i = 0; i < keys.length; i++) {
          if (keys[i].indexOf("__reactFiber$") === 0) { key = keys[i]; break; }
        }
        if (!key) node = node.parentElement;
      }
      if (!key) return out;
      var fiber = node[key];
      var hops = 0;
      while (fiber && hops++ < 400 && out.length < 6) {
        var t = fiber.type;
        var name = null;
        if (typeof t === "function") name = t.displayName || t.name;
        else if (t && typeof t === "object" && (t.displayName || (t.render && t.render.name)))
          name = t.displayName || t.render.name;
        if (name && name !== "Fragment" && out[out.length - 1] !== name) out.push(name);
        fiber = fiber.return;
      }
    } catch (e) {}
    return out;
  }

  function nthOfType(el) {
    var i = 1;
    var sib = el;
    while ((sib = sib.previousElementSibling)) if (sib.tagName === el.tagName) i++;
    return i;
  }

  function classesOf(el) {
    var out = [];
    try {
      var list = el.classList ? Array.prototype.slice.call(el.classList) : [];
      for (var i = 0; i < list.length; i++) {
        // Utility soup is not a selector anyone wants to read back.
        if (/[:\[\]\/!.%]/.test(list[i])) continue;
        out.push(list[i]);
      }
    } catch (e) {}
    return out;
  }

  function selectorOf(el) {
    try {
      var tag = el.tagName.toLowerCase();
      var own = tag;
      if (el.id) own += "#" + el.id;
      else {
        var cls = classesOf(el).slice(0, 3);
        for (var i = 0; i < cls.length; i++) own += "." + cls[i];
      }
      var parts = [own];
      var node = el.parentElement;
      var depth = 0;
      while (node && node !== document.body && node !== document.documentElement && depth < 2) {
        var p = node.tagName.toLowerCase();
        if (node.id) { parts.unshift(p + "#" + node.id); break; }
        parts.unshift(p + ":nth-of-type(" + nthOfType(node) + ")");
        node = node.parentElement;
        depth++;
      }
      return parts.join(" > ");
    } catch (e) {
      return el.tagName ? el.tagName.toLowerCase() : "*";
    }
  }

  function paint(el) {
    try {
      ensureOverlay();
      if (!el) { overlay.style.display = "none"; return; }
      var r = el.getBoundingClientRect();
      var s = overlay.style;
      s.display = "block";
      s.left = r.left + "px";
      s.top = r.top + "px";
      s.width = r.width + "px";
      s.height = r.height + "px";
      var name = componentOf(el);
      label.textContent = el.tagName.toLowerCase() + (name ? " · <" + name + ">" : "");
      label.style.top = r.top < 24 ? "100%" : "-22px";
    } catch (e) {}
  }

  function targetAt(ev) {
    var el = ev.target;
    if (!el || isOurs(el) || el === document.documentElement || el === document.body) return null;
    return el;
  }

  function onMove(ev) {
    try {
      var el = targetAt(ev);
      if (el === hovered) return;
      hovered = el;
      paint(el);
    } catch (e) {}
  }

  function onClick(ev) {
    try {
      ev.preventDefault();
      ev.stopPropagation();
      var el = targetAt(ev) || hovered;
      if (!el) return;
      var r = el.getBoundingClientRect();
      var text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200);
      var component = componentOf(el);
      var html = "";
      try {
        html = String(el.outerHTML || "").replace(/\s+/g, " ").trim();
        if (html.length > 400) html = html.slice(0, 399) + "…";
      } catch (e) {}
      var msg = {
        type: "daedalus:pick",
        tag: el.tagName.toLowerCase(),
        classes: classesOf(el),
        text: text,
        selector: selectorOf(el),
        components: componentsOf(el),
        html: html,
        rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      };
      if (el.id) msg.id = el.id;
      if (component) msg.component = component;
      post(msg);
      setInspect(false);
    } catch (e) {}
  }

  function onKey(ev) {
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      setInspect(false);
    }
  }

  function swallow(ev) {
    try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
  }

  function setInspect(on) {
    try {
      if (on === picking) return;
      picking = on;
      var opts = { capture: true };
      if (on) {
        ensureOverlay();
        document.addEventListener("mousemove", onMove, opts);
        document.addEventListener("click", onClick, opts);
        document.addEventListener("mousedown", swallow, opts);
        document.addEventListener("mouseup", swallow, opts);
        document.addEventListener("keydown", onKey, opts);
        document.documentElement.style.cursor = "crosshair";
      } else {
        document.removeEventListener("mousemove", onMove, opts);
        document.removeEventListener("click", onClick, opts);
        document.removeEventListener("mousedown", swallow, opts);
        document.removeEventListener("mouseup", swallow, opts);
        document.removeEventListener("keydown", onKey, opts);
        document.documentElement.style.cursor = "";
        hovered = null;
        paint(null);
      }
    } catch (e) {}
  }

  /* ── Commands from the panel ── */
  try {
    window.addEventListener("message", function (ev) {
      try {
        if (ev.source !== window.parent) return;
        var data = ev.data;
        if (!data || typeof data.type !== "string") return;
        if (data.type === "daedalus:inspect") setInspect(!!data.on);
        else if (data.type === "daedalus:navigate" && typeof data.path === "string") {
          var path = data.path.charAt(0) === "/" ? data.path : "/" + data.path;
          history.pushState(null, "", prefix.slice(0, -1) + path);
          // Routers listen for popstate, not for pushState — tell them.
          try { window.dispatchEvent(new PopStateEvent("popstate", { state: null })); } catch (e) {}
          setTimeout(ready, 0);
        } else if (data.type === "daedalus:history" && typeof data.delta === "number") {
          history.go(data.delta);
        } else if (data.type === "daedalus:reload") location.reload();
      } catch (e) {}
    });
  } catch (e) {}

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready);
  else ready();
})();
`;
