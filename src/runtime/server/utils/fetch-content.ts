// Fetches a signed Content envelope (§8.7) from SpeakSpec for a single
// (entity, content) pair. The envelope already contains the directive
// overlay, body, media, links, and (when an active signing key exists
// upstream) a _proof. The SDK serves the result at
// /.well-known/aidp/content/{id}.json on the customer's own domain.
//
// SpeakSpec's public per-content envelope route is:
//   GET {endpoint}/public/entity/{entityId}/content/{contentId}/publish.json
//
// Authentication is OPTIONAL — the upstream endpoint accepts requests
// without an API key, but we attach Authorization when configured so
// usage shows up under the customer's account in SpeakSpec analytics.

import { ofetch, FetchError } from 'ofetch'
import { SDK_USER_AGENT } from '../../version'

export interface FetchContentOptions {
  endpoint: string
  entityId: string
  contentId: string
  apiKey?: string
  ifNoneMatch?: string
  timeoutMs?: number
}

export interface FetchContentResult {
  payload: Record<string, unknown> | null
  etag: string
  notModified: boolean
}

export async function fetchContentEnvelope(opts: FetchContentOptions): Promise<FetchContentResult> {
  const url = `${stripTrailingSlash(opts.endpoint)}/public/entity/${encodeURIComponent(opts.entityId)}/content/${encodeURIComponent(opts.contentId)}/publish.json`

  const headers: Record<string, string> = {
    'User-Agent': SDK_USER_AGENT,
    'Accept': 'application/json',
  }
  if (opts.apiKey) {
    headers.Authorization = `Bearer ${opts.apiKey}`
  }
  if (opts.ifNoneMatch) {
    headers['If-None-Match'] = opts.ifNoneMatch
  }

  try {
    const response = await ofetch.raw<Record<string, unknown>>(url, {
      method: 'GET',
      headers,
      retry: 0,
      timeout: opts.timeoutMs ?? 5000,
    })
    return {
      payload: response._data ?? null,
      etag: response.headers.get('etag') ?? '',
      notModified: false,
    }
  }
  catch (err) {
    if (err instanceof FetchError && err.response?.status === 304) {
      return {
        payload: null,
        etag: err.response.headers.get('etag') ?? opts.ifNoneMatch ?? '',
        notModified: true,
      }
    }
    throw err
  }
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s
}
