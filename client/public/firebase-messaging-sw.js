/* global firebase, clients */
importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js")
importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js")

// Config arrives via the registration URL (?config=...) — nothing is baked in.
const config = JSON.parse(new URL(self.location.href).searchParams.get("config"))
firebase.initializeApp(config)
firebase.messaging()

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const data = event.notification.data || {}
  const sessionId = data.sessionId || (data.FCM_MSG && data.FCM_MSG.data && data.FCM_MSG.data.sessionId)
  // One route per thread — see client/src/lib/router.ts.
  event.waitUntil(clients.openWindow(sessionId ? "/t/" + encodeURIComponent(sessionId) : "/"))
})
