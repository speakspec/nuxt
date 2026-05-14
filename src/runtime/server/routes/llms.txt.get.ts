import { defineEventHandler, createError, setHeader } from 'h3'
import { useStorage } from 'nitropack/runtime'
import { useRuntimeConfig } from '#imports'
import { ofetch } from 'ofetch'
import { SDK_USER_AGENT } from '../../version'
import { cacheKey, isFresh, STORAGE_NAMESPACE, type CachedBundle } from '../utils/cache'

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig().speakspec

  if (!config?.entityId) {
    throw createError({ statusCode: 503, statusMessage: 'AIDP module not configured: missing entityId' })
  }

  const ttlMs = (config.cache as { ttlSec: number }).ttlSec * 1000
  const storage = useStorage(STORAGE_NAMESPACE)
  const key = cacheKey('llmstxt', config.entityId as string)
  const cached = (await storage.getItem(key)) as CachedBundle<string> | null

  if (isFresh(cached)) {
    setHeader(event, 'Content-Type', 'text/markdown; charset=utf-8')
    setHeader(event, 'Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400')
    return cached!.payload
  }

  const endpoint = (config.endpoint as string).replace(/\/$/, '')
  const entityId = config.entityId as string
  const apiKey = config.apiKey as string | undefined
  const url = `${endpoint}/public/entity/${encodeURIComponent(entityId)}`

  let text: string
  try {
    text = await ofetch<string>(url, {
      method: 'GET',
      headers: {
        'User-Agent': SDK_USER_AGENT,
        'Accept': 'text/markdown',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      responseType: 'text',
      retry: 0,
      timeout: 5000,
    })
  }
  catch {
    if (cached) {
      setHeader(event, 'Content-Type', 'text/markdown; charset=utf-8')
      setHeader(event, 'Cache-Control', 'public, max-age=60, stale-while-revalidate=300')
      return cached.payload
    }
    throw createError({ statusCode: 502, statusMessage: 'AIDP upstream unreachable and no cached llms.txt available' })
  }

  const fresh: CachedBundle<string> = { payload: text, etag: '', expiresAt: Date.now() + ttlMs }
  await storage.setItem(key, fresh)

  setHeader(event, 'Content-Type', 'text/markdown; charset=utf-8')
  setHeader(event, 'Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400')
  return text
})
