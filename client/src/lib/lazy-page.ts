import * as React from "react"

/** A named export of a lazily loaded module, as a component. Keeps the
    component's own prop types, so a route tree still type-checks the props it
    hands over; `React.lazy`'s own signature erases them to whatever the
    module's default export is. Several pages of one module each call this with
    the same loader — the module is fetched once. */
export function lazyPage<K extends string, M extends Record<K, React.ComponentType<any>>>(
  load: () => Promise<M>,
  key: K
): M[K] {
  return React.lazy(async () => ({ default: (await load())[key] })) as unknown as M[K]
}
