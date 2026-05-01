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

import { defineEventHandler, setResponseHeader, createError, getHeader, getRouterParam } from 'h3'
import { useStorage } from 'nitropack/runtime'
import { useRuntimeConfig } from '#imports'
import { fetchContentEnvelope } from '../../../../utils/fetch-content'
import {
  cacheKey,
  isFresh,
  STORAGE_NAMESPACE,
  DEFAULT_CACHE_TTL_MS,
  type CachedBundle,
} from '../../../../utils/cache'

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

  const storage = useStorage(STORAGE_NAMESPACE)
  const key = cacheKey('content', `${config.entityId}:${contentId}`)
  const cached = (await storage.getItem(key)) as CachedBundle<Record<string, unknown>> | null

  if (isFresh(cached)) {
    setResponseHeader(event, 'ETag', cached!.etag)
    setResponseHeader(event, 'Cache-Control', FRESH_CACHE_CONTROL)
    return cached!.payload
  }

  const ifNoneMatch = cached?.etag || getHeader(event, 'if-none-match') || undefined

  let result
  try {
    result = await fetchContentEnvelope({
      endpoint: config.endpoint,
      entityId: config.entityId,
      contentId,
      apiKey: config.apiKey,
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
