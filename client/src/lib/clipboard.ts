export function writeClipboard(text: string): Promise<void> {
  if (window.desktop?.isElectron && window.desktop.writeClipboard) {
    return window.desktop.writeClipboard(text).then(() => undefined)
  }
  if (!navigator.clipboard?.writeText) {
    return Promise.reject(new Error("Clipboard access is unavailable"))
  }
  return navigator.clipboard.writeText(text)
}
