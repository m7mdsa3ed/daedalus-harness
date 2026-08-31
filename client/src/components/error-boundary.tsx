import * as React from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

type Props = {
  children: React.ReactNode
  /** Label for the failing region, shown in the fallback ("Something broke in {name}"). */
  name?: string
  /** Changing any entry resets the boundary — e.g. the open thread id. */
  resetKeys?: readonly unknown[]
  /** Custom fallback; receives the error and a reset callback. */
  fallback?: (error: Error, reset: () => void) => React.ReactNode
}

type State = { error: Error | null }

function keysChanged(a: readonly unknown[] = [], b: readonly unknown[] = []) {
  return a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]))
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && keysChanged(prev.resetKeys, this.props.resetKeys)) {
      this.setState({ error: null })
    }
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    console.error("[error-boundary]", this.props.name ?? "app", error, info.componentStack)
  }

  reset = () => this.setState({ error: null })

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    if (this.props.fallback) return this.props.fallback(error, this.reset)
    return <ErrorFallback error={error} name={this.props.name} onReset={this.reset} />
  }
}

export function ErrorFallback({
  error,
  name,
  onReset,
}: {
  error: Error
  name?: string
  onReset: () => void
}) {
  return (
    <div className="flex min-h-[var(--panel-h,100svh)] flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Something broke{name ? ` in ${name}` : ""}</CardTitle>
          <CardDescription>
            The interface hit an unexpected error. Retrying re-renders this area; reloading starts
            the app fresh.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <pre className="text-muted-foreground max-h-40 overflow-auto rounded-md border p-3 font-mono text-xs whitespace-pre-wrap">
            {error.message || String(error)}
          </pre>
          <div className="flex gap-2">
            <Button onClick={onReset}>Try again</Button>
            <Button variant="outline" onClick={() => location.reload()}>
              Reload
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
