// Fetches the customer's entity directive from SpeakSpec. The SDK
// serves the result at /.well-known/aidp.json on the customer's own
// domain (per AIDP 0.3 §8.5). All fetches are SSR-time only — never
// build-time baked, so directive changes propagate within one cache
// TTL plus eventual webhook invalidation (Step 3.1.5).
//
// SpeakSpec's public entity-directive route is:
//   GET {endpoint}/public/entity/{entityId}
// Authentication is OPTIONAL (the route is publicly readable); we
// pass an Authorization header anyway so usage shows up under the
// customer's API key in SpeakSpec analytics.

import { ofetch, FetchError } from 'ofetch'
import { SDK_USER_AGENT } from '../../version'

export interface FetchOptions {
  endpoint: string
  entityId: string
  apiKey?: string
  /** Existing ETag, sent as If-None-Match for conditional fetch. */
  ifNoneMatch?: string
  /** SSR-time fetch budget. Defaults to 5s — long enough to absorb
   * typical TLS/DNS latency, short enough that a slow upstream cannot
   * block downstream rendering past one normal request budget.
   */
  timeoutMs?: number
}

export interface FetchResult {
  /** Parsed AIDP entity directive payload, OR null on 304. */
  payload: Record<string, unknown> | null
  /** Server-issued ETag for next round-trip; empty string if missing. */
  etag: string
  /** True when the upstream returned 304 — caller keeps cached payload. */
  notModified: boolean
}

export async function fetchEntityDirective(opts: FetchOptions): Promise<FetchResult> {
  const url = `${stripTrailingSlash(opts.endpoint)}/public/entity/${encodeURIComponent(opts.entityId)}`

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
