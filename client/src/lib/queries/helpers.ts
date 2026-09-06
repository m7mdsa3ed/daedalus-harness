/* The primitives every query hook in this directory is built on. Components
   never call `api()` or build a key by hand — they call a typed hook from
   catalog.ts / routines.ts / surfaces.ts, and those call these.

   The invalidation rule (inherited from rest-actions.ts, whose job this now
   is): a mutation is not done when the server answers 200, it is done when
   the cached list every screen reads has been invalidated. A page calling
   `api()` itself would leave a deleted routine on screen until something else
   happened to refresh. */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationOptions,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult,
} from "@tanstack/react-query"

import { api, type ServerSettings } from "@/lib/settings"
import { useServer } from "@/lib/server-context"

/** A GET bound to the active connection, cancellable by the query's own
    signal (api() rethrows the abort, so a cancelled read is not a failure). */
export function useApiQuery<T>(
  key: readonly unknown[],
  path: string,
  options?: Omit<UseQueryOptions<T, Error, T, readonly unknown[]>, "queryKey" | "queryFn">
): UseQueryResult<T, Error> {
  const settings = useServer()
  return useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api<T>(settings, path, { signal }),
    ...options,
  })
}

/** A write against the active connection that invalidates the given keys
    (prefix-matched, so `profiles` covers the whole catalog key family that
    hangs off it) once it succeeds. `invalidate` may also be a function of the
    result and the input, for the writes whose target depends on the row — a
    knowledge delete knows its project only through its argument. `apply` is
    the other reconciliation: for mutations the server answers with
    authoritative rows, patch the cache with them instead of re-reading. The
    server row also comes back to the caller — a create that navigates, a run
    that toasts. */
export function useApiMutation<TInput, TOut>(
  invalidate:
    | readonly (readonly unknown[])[]
    | ((data: TOut, input: TInput) => readonly (readonly unknown[])[]),
  fn: (settings: ServerSettings, input: TInput) => Promise<TOut>,
  apply?: (data: TOut, input: TInput) => void,
  options?: Omit<UseMutationOptions<TOut, Error, TInput>, "mutationFn" | "onSuccess">
): UseMutationResult<TOut, Error, TInput> {
  const settings = useServer()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: TInput) => fn(settings, input),
    onSuccess: (data, variables) => {
      apply?.(data, variables)
      const keys = typeof invalidate === "function" ? invalidate(data, variables) : invalidate
      void Promise.all(keys.map((key) => qc.invalidateQueries({ queryKey: key })))
    },
    ...options,
  })
}

/** For the writes that happen outside this hook family — an import, a backup
    restore, a project deletion with cascades — the same rule, by hand. */
export function useInvalidate() {
  const qc = useQueryClient()
  return (...keys: readonly (readonly unknown[])[]) =>
    Promise.all(keys.map((key) => qc.invalidateQueries({ queryKey: key })))
}
