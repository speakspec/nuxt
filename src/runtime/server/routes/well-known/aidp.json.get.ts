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

import { defineEventHandler, setResponseHeader, createError, getHeader } from 'h3'
import { useStorage } from 'nitropack/runtime'
import { useRuntimeConfig } from '#imports'
import { fetchEntityDirective } from '../../utils/fetch-directive'
import {
  cacheKey,
  isFresh,
  STORAGE_NAMESPACE,
  DEFAULT_CACHE_TTL_MS,
  type CachedBundle,
} from '../../utils/cache'

const FRESH_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=300'
const STALE_CACHE_CONTROL = 'public, max-age=10, stale-while-revalidate=60'

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig().speakspec

  if (!config?.entityId) {
    throw createError({
      statusCode: 503,
      statusMessage: 'AIDP module not configured: missing entityId',
    })
  }

  const storage = useStorage(STORAGE_NAMESPACE)
  const key = cacheKey('entity', config.entityId)
  const cached = (await storage.getItem(key)) as CachedBundle<Record<string, unknown>> | null

  if (isFresh(cached)) {
    setResponseHeader(event, 'ETag', cached!.etag)
    setResponseHeader(event, 'Cache-Control', FRESH_CACHE_CONTROL)
    return cached!.payload
  }

  // Conditional GET: send the prior ETag so the upstream can reply
  // 304 when nothing has changed (saves the JSON parse roundtrip).
  const ifNoneMatch = cached?.etag || getHeader(event, 'if-none-match') || undefined

  let result
  try {
    result = await fetchEntityDirective({
      endpoint: config.endpoint,
      entityId: config.entityId,
      apiKey: config.apiKey,
      ifNoneMatch,
    })
  }
  catch {
    // Upstream unreachable. If we have any cached bundle (even
    // expired-by-TTL), serve it with a shorter Cache-Control so the
    // next request retries soon. This matches the
    // stale-while-revalidate intent at the SDK layer.
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
