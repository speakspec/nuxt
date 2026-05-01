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

/**
 * Minimal storage shape the AIDP cache helpers depend on. Compatible
 * with `unstorage`'s `Storage` interface (Nitro's `useStorage` returns
 * one) — broken out here so unit tests can supply a recording stub
 * without standing up a Nitro runtime.
 */
export interface CacheStorage {
  removeItem: (key: string) => Promise<unknown>
  getKeys: (base: string) => Promise<string[]>
}

/**
 * Clear all cache entries for a single entity. Removes the entity-
 * level directive key plus every content- and directory-level key
 * under that entity. Called from the webhook receiver when SpeakSpec
 * sends `scope: "entity"` — covers the directive (Step 3.1), every
 * per-content envelope (Step 3.2), and every paginated directory
 * variant (Step 3.3).
 */
export async function invalidateEntityCache(storage: CacheStorage, slug: string): Promise<void> {
  await storage.removeItem(cacheKey('entity', slug))
  for (const prefix of [cacheKey('content', `${slug}:`), cacheKey('directory', `${slug}:`)]) {
    const keys = await storage.getKeys(prefix)
    for (const key of keys) {
      await storage.removeItem(key)
    }
  }
}

/**
 * Clear a single per-content cache entry. Called from the webhook
 * receiver when SpeakSpec sends `scope: "content"`.
 *
 * Also sweeps directory variants for the same entity — a content edit
 * changes the directory listing's `items[].updated_at` (and possibly
 * the page's item count), so leaving directory pages cached would
 * mean staleness up to 5 minutes (TTL) on unrelated edits. Sweep cost
 * is bounded: directories are flat and a single entity rarely has
 * more than a handful of paginated variants in cache simultaneously.
 */
export async function invalidateContentCache(
  storage: CacheStorage,
  slug: string,
  contentId: string,
): Promise<void> {
  await storage.removeItem(cacheKey('content', `${slug}:${contentId}`))
  const dirPrefix = cacheKey('directory', `${slug}:`)
  const keys = await storage.getKeys(dirPrefix)
  for (const key of keys) {
    await storage.removeItem(key)
  }
}
