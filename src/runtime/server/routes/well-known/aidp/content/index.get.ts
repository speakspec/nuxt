// Customer-facing /.well-known/aidp/content/ route per AIDP 0.3 §8.8.
// Proxies the paginated content directory from SpeakSpec, caches with
// TTL + ETag, falls through to stale-served on upstream error. Same
// pattern as the entity directive and per-content endpoints.
//
// Cache key includes the query-string fingerprint (page, page_size,
// type) so distinct paginations / filters don't share a cache entry.
// Webhook invalidation (entity-scope) sweeps `directory:{slug}:*` so
// every paginated variant gets invalidated together.
//
// Spec mandates the trailing slash on the URL pattern; the module's
// addServerHandler registration handles that — h3 normalises both
// forms internally.

import { defineEventHandler, getQuery, setResponseHeader, createError, getHeader } from 'h3'
import { useStorage } from 'nitropack/runtime'
import { useRuntimeConfig } from '#imports'
import { fetchContentDirectory } from '../../../../utils/fetch-directory'
import {
  cacheKey,
  isFresh,
  STORAGE_NAMESPACE,
  DEFAULT_CACHE_TTL_MS,
  type CachedBundle,
} from '../../../../utils/cache'

const FRESH_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=300'
const STALE_CACHE_CONTROL = 'public, max-age=10, stale-while-revalidate=60'

const ALLOWED_QUERY = new Set(['page', 'page_size', 'type'])

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig().speakspec

  if (!config?.entityId) {
    throw createError({
      statusCode: 503,
      statusMessage: 'AIDP module not configured: missing entityId',
    })
  }

  const query = getQuery(event)
  for (const k of Object.keys(query)) {
    if (!ALLOWED_QUERY.has(k)) {
      throw createError({
        statusCode: 400,
        statusMessage: `unsupported filter: ${k}`,
      })
    }
  }

  const page = parseOptionalInt(query.page, 'page')
  const pageSize = parseOptionalInt(query.page_size, 'page_size')
  const contentType = typeof query.type === 'string' ? query.type : undefined

  // Cache-key fingerprint shape: `p{page}s{pageSize}t{type}`.
  // Collision-resistance relies on parseOptionalInt rejecting any
  // non-integer for `page` / `pageSize` — without that guarantee a
  // value like `?type=s2t` would alias `?page=1&page_size=2`. If the
  // validator ever loosens, switch to a delimiter-based key.
  const fingerprint = `p${page ?? ''}s${pageSize ?? ''}t${contentType ?? ''}`
  const storage = useStorage(STORAGE_NAMESPACE)
  const key = cacheKey('directory', `${config.entityId}:${fingerprint}`)
  const cached = (await storage.getItem(key)) as CachedBundle<Record<string, unknown>> | null

  if (isFresh(cached)) {
    setResponseHeader(event, 'ETag', cached!.etag)
    setResponseHeader(event, 'Cache-Control', FRESH_CACHE_CONTROL)
    return cached!.payload
  }

  const ifNoneMatch = cached?.etag || getHeader(event, 'if-none-match') || undefined

  let result
  try {
    result = await fetchContentDirectory({
      endpoint: config.endpoint,
      entityId: config.entityId,
      apiKey: config.apiKey,
      page,
      pageSize,
      contentType,
      ifNoneMatch,
    })
  }
  catch {
    if (cached) {
      setResponseHeader(event, 'ETag', cached.etag)
      setResponseHeader(event, 'Cache-Control', STALE_CACHE_CONTROL)
      return cached.payload
    }
    throw createError({
      statusCode: 502,
      statusMessage: 'AIDP upstream unreachable and no cached payload available',
    })
  }

  if (result.notModified && cached) {
    const refreshed: CachedBundle<Record<string, unknown>> = {
      payload: cached.payload,
      etag: cached.etag,
      expiresAt: Date.now() + DEFAULT_CACHE_TTL_MS,
    }
    await storage.setItem(key, refreshed)
    setResponseHeader(event, 'ETag', refreshed.etag)
    setResponseHeader(event, 'Cache-Control', FRESH_CACHE_CONTROL)
    return refreshed.payload
  }

  if (!result.payload) {
    throw createError({
      statusCode: 502,
      statusMessage: 'AIDP upstream returned empty payload',
    })
  }

  const fresh: CachedBundle<Record<string, unknown>> = {
    payload: result.payload,
    etag: result.etag,
    expiresAt: Date.now() + DEFAULT_CACHE_TTL_MS,
  }
  await storage.setItem(key, fresh)

  if (fresh.etag) {
    setResponseHeader(event, 'ETag', fresh.etag)
  }
  setResponseHeader(event, 'Cache-Control', FRESH_CACHE_CONTROL)
  return fresh.payload
})

function parseOptionalInt(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (Array.isArray(value)) {
    throw createError({ statusCode: 400, statusMessage: `${name} must be a single value` })
  }
  const n = Number(value)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw createError({ statusCode: 400, statusMessage: `${name} must be a non-negative integer` })
  }
  return n
}
