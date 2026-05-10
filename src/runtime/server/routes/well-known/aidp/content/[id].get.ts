// Customer-facing /.well-known/aidp/content/{id}.json route per AIDP
// 0.3 §8.7. Same cache + ETag + serve-stale-on-error workflow as the
// entity directive route — see ../aidp.json.get.ts for the design
// notes. The cache key is `content:{entityId}:{contentId}` so the
// webhook receiver's invalidateEntityCache + invalidateContentCache
// helpers match by prefix.
//
// Route registration uses `addServerHandler` in module.ts with the
// explicit path `/.well-known/aidp/content/:id`. The `[id].get.ts`
// filename mirrors Nitro's file-based-routing convention but is not
// itself active here — files under `src/runtime/server/routes/...` in
// an installed module are not picked up by the host's Nitro scanner;
// only the explicit `addServerHandler` registration is. radix3
// captures `:id` as the entire path segment verbatim (including the
// `.json` suffix), so the handler strips `.json` before lookup.

import { defineEventHandler, createError, getHeader, getRouterParam } from 'h3'
import { useStorage } from 'nitropack/runtime'
import { useRuntimeConfig } from '#imports'
import { fetchContentEnvelope } from '../../../../utils/fetch-content'
import {
  buildCacheControl,
  cacheKey,
  isFresh,
  isUpstream4xx,
  respondWithCache,
  STORAGE_NAMESPACE,
  type CachedBundle,
} from '../../../../utils/cache'

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig().speakspec

  if (!config?.entityId) {
    throw createError({
      statusCode: 503,
      statusMessage: 'AIDP module not configured: missing entityId',
    })
  }
  const FRESH_CACHE_CONTROL = buildCacheControl(config.cache.contentMaxAge, config.cache.contentSwr)
  const STALE_CACHE_CONTROL = buildCacheControl(10, 60)
  const ttlMs = config.cache.ttlSec * 1000

  const rawId = getRouterParam(event, 'id') ?? ''
  // Strip the `.json` suffix so the path
  //   /.well-known/aidp/content/etf-explainer-2026-04.json
  // resolves to contentId=etf-explainer-2026-04. The spec mandates
  // the `.json` suffix in the URL but the AIDP content_id itself
  // does not carry it.
  const contentId = rawId.endsWith('.json') ? rawId.slice(0, -5) : rawId
  if (!contentId) {
    throw createError({
      statusCode: 400,
      statusMessage: 'content id is required',
    })
  }

  const inboundIfNoneMatch = getHeader(event, 'if-none-match')
  const storage = useStorage(STORAGE_NAMESPACE)
  const key = cacheKey('content', `${config.entityId}:${contentId}`)
  const cached = (await storage.getItem(key)) as CachedBundle<Record<string, unknown>> | null

  if (isFresh(cached)) {
    return respondWithCache(event, cached!.etag, cached!.payload, FRESH_CACHE_CONTROL, inboundIfNoneMatch)
  }

  const upstreamIfNoneMatch = cached?.etag || undefined

  let result
  try {
    result = await fetchContentEnvelope({
      endpoint: config.endpoint,
      entityId: config.entityId,
      contentId,
      apiKey: config.apiKey,
      ifNoneMatch: upstreamIfNoneMatch,
    })
  }
  catch (err) {
    if (isUpstream4xx(err)) {
      throw createError({
        statusCode: 502,
        statusMessage: `AIDP upstream rejected the content fetch (${(err as { response?: { status?: number } }).response?.status})`,
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
