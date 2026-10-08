/* ── A browser of one page ──
   What `chrome-devtools-mcp` (Puppeteer) connects to when it drives a thread's
   Preview. Puppeteer wants a *browser* endpoint — it lists contexts, discovers
   targets and auto-attaches — and a `<webview>` offers only its own page's
   debugger (`webContents.debugger`). So the browser-level questions are
   answered here, with exactly one target, the preview; everything addressed
   to that page's session (or a child of it: an iframe, a worker) goes to the
   guest's debugger verbatim, and its events come back tagged with the session.

   Deliberately not `--remote-debugging-port`: that is every window of the app,
   the harness's own page and its token included, open to anything local. Here
   the only page there is to find is the one the person turned Drive on for.
   Opening or closing pages is refused — the preview is navigated, not replaced. */

const TARGET_ID = "daedalus-preview"
const PAGE_SESSION = "daedalus-preview-session"

/**
 * @param {Electron.WebContents} guest the `<webview>`'s contents
 * @param {(message: string) => void} emit a CDP message for the client
 * @param {(reason: string) => void} onEnd the connection is over
 */
function createCdpShim(guest, emit, onEnd) {
  const dbg = guest.debugger
  let ended = false
  let attached = false

  const send = (message) => {
    if (!ended) emit(JSON.stringify(message))
  }
  const info = () => ({
    targetId: TARGET_ID,
    type: "page",
    title: guest.getTitle(),
    url: guest.getURL(),
    attached,
    canAccessOpener: false,
  })

  const onMessage = (_event, method, params, sessionId) => send({ method, params, sessionId: sessionId || PAGE_SESSION })
  const onDetach = (_event, reason) => end(`the debugger detached (${reason})`)
  const onInfo = () => send({ method: "Target.targetInfoChanged", params: { targetInfo: info() } })
  const onGone = () => {
    send({ method: "Target.detachedFromTarget", params: { sessionId: PAGE_SESSION, targetId: TARGET_ID } })
    send({ method: "Target.targetDestroyed", params: { targetId: TARGET_ID } })
    end("the preview closed")
  }
  dbg.on("message", onMessage)
  dbg.on("detach", onDetach)
  guest.on("did-navigate", onInfo)
  guest.on("page-title-updated", onInfo)
  guest.once("destroyed", onGone)

  function end(reason) {
    if (ended) return
    ended = true
    dbg.off("message", onMessage)
    dbg.off("detach", onDetach)
    if (!guest.isDestroyed()) {
      guest.off("did-navigate", onInfo)
      guest.off("page-title-updated", onInfo)
      guest.off("destroyed", onGone)
      if (attached && dbg.isAttached()) dbg.detach()
    }
    onEnd(reason)
  }

  /* The browser-level methods Puppeteer sends on connect and on use. Each
     returns its result; events it owes go through `send` *before* the reply,
     which is the order Chrome uses. */
  const browser = {
    "Browser.getVersion": () => ({
      protocolVersion: "1.3",
      product: `Chrome/${process.versions.chrome}`,
      revision: "",
      userAgent: guest.getUserAgent(),
      jsVersion: process.versions.v8,
    }),
    "Target.getBrowserContexts": () => ({ browserContextIds: [] }),
    "Target.setDiscoverTargets": ({ discover }) => {
      if (discover) send({ method: "Target.targetCreated", params: { targetInfo: info() } })
      return {}
    },
    "Target.setAutoAttach": ({ autoAttach }) => {
      if (autoAttach && !attached) {
        if (!dbg.isAttached()) dbg.attach("1.3")
        attached = true
        send({
          method: "Target.attachedToTarget",
          params: { sessionId: PAGE_SESSION, targetInfo: info(), waitingForDebugger: false },
        })
      }
      return {}
    },
    "Target.getTargets": () => ({ targetInfos: [info()] }),
    "Target.getTargetInfo": () => ({ targetInfo: info() }),
    "Target.activateTarget": () => ({}),
    "Target.detachFromTarget": () => ({}),
    /* Puppeteer's `browser.close()`. Closing is the person's, not the agent's. */
    "Browser.close": () => ({}),
    "Browser.setDownloadBehavior": () => ({}),
    "Browser.grantPermissions": () => ({}),
    "Browser.resetPermissions": () => ({}),
    "Browser.setPermission": () => ({}),
  }

  return {
    /** One message from the client. */
    handle(raw) {
      let message
      try {
        message = JSON.parse(raw)
      } catch {
        return
      }
      const { id, method, params = {}, sessionId } = message
      if (sessionId) {
        dbg
          .sendCommand(method, params, sessionId === PAGE_SESSION ? undefined : sessionId)
          .then(
            (result) => send({ id, sessionId, result }),
            (error) => send({ id, sessionId, error: { code: -32000, message: error.message } })
          )
        return
      }
      const answer = browser[method]
      if (!answer) {
        send({
          id,
          error: {
            code: -32601,
            message: `${method} is not available: this connection is one page, the thread's preview. Navigate it rather than opening, closing or selecting another.`,
          },
        })
        return
      }
      try {
        send({ id, result: answer(params) })
      } catch (error) {
        send({ id, error: { code: -32000, message: error.message } })
      }
    },
    end,
  }
}

module.exports = { createCdpShim }
