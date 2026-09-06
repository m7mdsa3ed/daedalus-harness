let pendingNewTab = false

export function markNewTab(): void {
  pendingNewTab = true
}

export function consumeNewTab(): boolean {
  const value = pendingNewTab
  pendingNewTab = false
  return value
}
