// Customer-facing /.well-known/aidp.json route per AIDP 0.3 §8.5.
//
// Workflow on each request:
//   1. Read cached payload + ETag from Nitro storage.
//   2. If cache is fresh (TTL not yet expired), return cached payload
//      with ETag + Cache-Control headers — no upstream call.
//   3. If cache is stale (or missing), call SpeakSpec with
//      If-None-Match. On 304, refresh expiresAt and return cached.
//      On 200, store new payload + ETag and return.
//   4. If upstream errors AND we have a stale-but-present cached
//      bundle, serve stale with a shorter Cache-Control so the next
//      request retries — matches the spec's stale-while-revalidate
//      semantic at the SDK layer, not just at the downstream CDN.
//
// Cache invalidation on directive changes happens via the §8.10
// webhook receiver (Step 3.1.5); the per-request TTL is the
// fallback when webhook delivery itself fails.
//
// Uses explicit imports rather than Nitro auto-imports so the SDK
// remains portable across host projects that may have different
// auto-import configurations or h3 versions.

import { defineEventHandler, createError, getHeader } from 'h3'
import { useStorage } from 'nitropack/runtime'
import { useRuntimeConfig } from '#imports'
import { fetchEntityDirective } from '../../utils/fetch-directive'
import {
  buildCacheControl,
  cacheKey,
  isFresh,
  isUpstream4xx,
  respondWithCache,
  STORAGE_NAMESPACE,
  type CachedBundle,
} from '../../utils/cache'

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig().speakspec

  if (!config?.entityId) {
    throw createError({
      statusCode: 503,
      statusMessage: 'AIDP module not configured: missing entityId',
    })
  }
  const FRESH_CACHE_CONTROL = buildCacheControl(config.cache.entityMaxAge, config.cache.entitySwr)
  const STALE_CACHE_CONTROL = buildCacheControl(10, 60)
  const ttlMs = config.cache.ttlSec * 1000

  const inboundIfNoneMatch = getHeader(event, 'if-none-match')
  const storage = useStorage(STORAGE_NAMESPACE)
  const key = cacheKey('entity', config.entityId)
  const cached = (await storage.getItem(key)) as CachedBundle<Record<string, unknown>> | null

  if (isFresh(cached)) {
    return respondWithCache(event, cached!.etag, cached!.payload, FRESH_CACHE_CONTROL, inboundIfNoneMatch)
  }

  // Conditional GET against upstream uses the cached etag (the only
  // value the upstream knows). The inbound `If-None-Match` is honoured
  // at this server layer per §8.7 once we know the response etag.
  const upstreamIfNoneMatch = cached?.etag || undefined

  let result
  try {
    result = await fetchEntityDirective({
      endpoint: config.endpoint,
      entityId: config.entityId,
      apiKey: config.apiKey,
      ifNoneMatch: upstreamIfNoneMatch,
    })
  }
  catch (err) {
    // Upstream 4xx → operator action required (bad apiKey, entity
    // removed, etc). Do NOT serve stale; surface a 502 with detail so
    // the customer's monitoring catches it. 5xx / network → serve
    // stale with shorter Cache-Control so the next hit retries.
    if (isUpstream4xx(err)) {
      throw createError({
        statusCode: 502,
        statusMessage: `AIDP upstream rejected the directive fetch (${(err as { response?: { status?: number } }).response?.status})`,
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
