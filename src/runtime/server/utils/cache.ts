// Pure cache helpers for the AIDP SDK's server-side routes.
//
// Storage IO lives in route handlers (which import `useStorage` from
// `nitropack/runtime` explicitly) — this file stays pure so unit
// tests can run outside Nitro / Nuxt context without needing to mock
// the storage backend.

export interface CachedBundle<T = unknown> {
  payload: T
  etag: string
  expiresAt: number
}

/** Storage namespace used by every AIDP-SDK cache key. */
export const STORAGE_NAMESPACE = 'cache:speakspec'

/**
 * Default TTL for a cached SpeakSpec response. 5 minutes per
 * docs/proposal-speakspec-nuxt-module.md §8 — short enough that
 * webhook-driven invalidation is the canonical refresh path,
 * long enough to absorb burst traffic between cache misses.
 */
export const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000

export function cacheKey(scope: string, id: string): string {
  return `${scope}:${id}`
}

export function isFresh<T>(bundle: CachedBundle<T> | null): boolean {
  return !!bundle && bundle.expiresAt > Date.now()
}
