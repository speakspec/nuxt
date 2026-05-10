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

import { defineEventHandler, getQuery, createError, getHeader } from 'h3'
import { useStorage } from 'nitropack/runtime'
import { useRuntimeConfig } from '#imports'
import { fetchContentDirectory } from '../../../../utils/fetch-directory'
import { parsePositiveInt } from '../../../../utils/query'
import {
  buildCacheControl,
  cacheKey,
  isFresh,
  isUpstream4xx,
  respondWithCache,
  STORAGE_NAMESPACE,
  type CachedBundle,
} from '../../../../utils/cache'

const ALLOWED_QUERY = new Set(['page', 'page_size', 'type', 'language', 'updated_since'])

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig().speakspec

  if (!config?.entityId) {
    throw createError({
      statusCode: 503,
      statusMessage: 'AIDP module not configured: missing entityId',
    })
  }
  const FRESH_CACHE_CONTROL = buildCacheControl(config.cache.directoryMaxAge, config.cache.directorySwr)
  const STALE_CACHE_CONTROL = buildCacheControl(10, 60)
  const ttlMs = config.cache.ttlSec * 1000

  const query = getQuery(event)
  for (const k of Object.keys(query)) {
    if (!ALLOWED_QUERY.has(k)) {
      throw createError({
        statusCode: 400,
        statusMessage: `unsupported filter: ${k}`,
      })
    }
  }

  const page = parsePositiveInt(query.page, 'page')
  const pageSize = parsePositiveInt(query.page_size, 'page_size')
  const contentType = typeof query.type === 'string' ? query.type : undefined
  const language = typeof query.language === 'string' ? query.language : undefined
  const updatedSince = typeof query.updated_since === 'string' ? query.updated_since : undefined

  // Cache key fingerprint uses JSON to guarantee no aliasing between
  // distinct filter combinations (e.g. `type=foo` vs `language=foo`).
  const fingerprint = JSON.stringify({ page, pageSize, contentType, language, updatedSince })
  const inboundIfNoneMatch = getHeader(event, 'if-none-match')
  const storage = useStorage(STORAGE_NAMESPACE)
  const key = cacheKey('directory', `${config.entityId}:${fingerprint}`)
  const cached = (await storage.getItem(key)) as CachedBundle<Record<string, unknown>> | null

  if (isFresh(cached)) {
    return respondWithCache(event, cached!.etag, cached!.payload, FRESH_CACHE_CONTROL, inboundIfNoneMatch)
  }

  const upstreamIfNoneMatch = cached?.etag || undefined

  let result
  try {
    result = await fetchContentDirectory({
      endpoint: config.endpoint,
      entityId: config.entityId,
      apiKey: config.apiKey,
      page,
      pageSize,
      contentType,
      language,
      updatedSince,
      ifNoneMatch: upstreamIfNoneMatch,
    })
  }
  catch (err) {
    if (isUpstream4xx(err)) {
      throw createError({
        statusCode: 502,
        statusMessage: `AIDP upstream rejected the directory fetch (${(err as { response?: { status?: number } }).response?.status})`,
      })
    }
    if (cached) {
      return respondWithCache(event, cached.etag, cached.payload, STALE_CACHE_CONTROL, inboundIfNoneMatch)
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
      expiresAt: Date.now() + ttlMs,
    }
    await storage.setItem(key, refreshed)
    return respondWithCache(event, refreshed.etag, refreshed.payload, FRESH_CACHE_CONTROL, inboundIfNoneMatch)
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
    expiresAt: Date.now() + ttlMs,
  }
  await storage.setItem(key, fresh)
  return respondWithCache(event, fresh.etag, fresh.payload, FRESH_CACHE_CONTROL, inboundIfNoneMatch)
})

