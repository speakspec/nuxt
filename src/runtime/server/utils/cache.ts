// Pure cache helpers for the AIDP SDK's server-side routes.
//
// Storage IO lives in route handlers (which import `useStorage` from
// `nitropack/runtime` explicitly) — this file stays pure so unit
// tests can run outside Nitro / Nuxt context without needing to mock
// the storage backend.

import type { H3Event } from 'h3'
import { setResponseHeader, setResponseStatus } from 'h3'

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

/** Build a `Cache-Control` header value from max-age + swr seconds.
 *  Centralised so the three route handlers don't drift. */
export function buildCacheControl(maxAge: number, swr: number): string {
  return `public, max-age=${maxAge}, stale-while-revalidate=${swr}`
}

export function cacheKey(scope: string, id: string): string {
  return `${scope}:${id}`
}

export function isFresh<T>(bundle: CachedBundle<T> | null): boolean {
  return !!bundle && bundle.expiresAt > Date.now()
}

/**
 * RFC 7232 §2.3.2 weak comparison: an inbound `If-None-Match` matches
 * the current ETag when both, after stripping any `W/` weak prefix,
 * have identical values. Spec §8.7 mandates that AIDP servers honour
 * If-None-Match by responding with 304; this helper is the comparison
 * primitive shared by the three GET routes.
 *
 * Empty inputs never match (no ETag, no conditional revalidation).
 * The list-form `If-None-Match: "a", "b"` is uncommon for AIDP agents
 * and not parsed here — only single-tag comparison is supported.
 *
 * The wildcard form `If-None-Match: *` (RFC 7232 §3.2: "match any
 * existing representation") is treated as a literal opaque tag and
 * therefore never matches. AI agents in practice send specific
 * validators, not wildcards; revisit if that assumption changes.
 */
export function etagMatches(inbound: string | undefined | null, current: string | undefined | null): boolean {
  if (!inbound || !current) return false
  const norm = (e: string) => (e.startsWith('W/') ? e.slice(2) : e).trim()
  return norm(inbound) === norm(current)
}

/**
 * True when `err` looks like an ofetch `FetchError` with a 4xx
 * upstream status. The route handlers use this to distinguish
 * "upstream told us no" (4xx — bad apiKey, removed entity, malformed
 * request — operator action required, do NOT serve stale) from
 * "transient outage" (5xx / network — serve stale per
 * stale-while-revalidate). Pure structural check — no instanceof —
 * so we don't need to take an ofetch dep here.
 */
export function isUpstream4xx(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const status = (err as { response?: { status?: number }, statusCode?: number }).response?.status
    ?? (err as { statusCode?: number }).statusCode
  // 429 is a transient quota/rate-limit signal — the SDK contract says
  // "fall back to last cached payload if available" (see enforceSdkFetchQuota
  // comment in aidp-server). Exclude it from the hard-error path so the
  // catch block can serve stale instead of throwing 502.
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 429
}

/**
 * Common response writer for the three AIDP GET routes. Sets the
 * Content-Type / ETag / Cache-Control / Access-Control-Allow-Origin /
 * Content-Usage headers per AIDP §8.3 + §11.6, and — per AIDP §8.7 —
 * short-circuits to `304 Not Modified` (empty body) when the inbound
 * `If-None-Match` matches the response ETag (RFC 7232 §2.3.2 weak
 * comparison via `etagMatches`).
 */
export function respondWithCache<T>(
  event: H3Event,
  etag: string,
  payload: T,
  cacheControl: string,
  inboundIfNoneMatch: string | undefined | null,
): T | null {
  setResponseHeader(event, 'Content-Type', 'application/aidp+json')
  setResponseHeader(event, 'Access-Control-Allow-Origin', '*')
  if (etag) setResponseHeader(event, 'ETag', etag)
  setResponseHeader(event, 'Cache-Control', cacheControl)
  const usage = buildContentUsage(payload)
  if (usage) setResponseHeader(event, 'Content-Usage', usage)
  if (etagMatches(inboundIfNoneMatch, etag)) {
    setResponseStatus(event, 304)
    return null
  }
  return payload
}

/**
 * Project `directives.access_control` to an AIPREF-compatible
 * `Content-Usage` header value per AIDP §11.6.
 *
 * Returns null when the payload is not an AIDP envelope (e.g. the
 * directory listing has no `directives` field) or when `access_control`
 * has no actionable flags — callers MUST NOT emit the header in that
 * case rather than emitting an empty value.
 */
export function buildContentUsage(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const directives = (payload as { directives?: unknown }).directives
  if (!directives || typeof directives !== 'object') return null
  const ac = (directives as { access_control?: unknown }).access_control
  if (!ac || typeof ac !== 'object') return null
  const flags = ac as { allow_training?: unknown, allow_derivative?: unknown }
  const parts: string[] = []
  if (flags.allow_training === true) parts.push('train-ai=y')
  else if (flags.allow_training === false) parts.push('train-ai=n')
  if (flags.allow_derivative === true) parts.push('search=y')
  else if (flags.allow_derivative === false) parts.push('search=n')
  return parts.length > 0 ? parts.join(', ') : null
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
  await storage.removeItem(cacheKey('llmstxt', slug))
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
