// Fetches the paginated content directory (§8.8) from SpeakSpec.
// SDK serves the result at /.well-known/aidp/content/ on the
// customer's own domain. The directory itself is not signed (per the
// proposal, security boundary is per-content envelopes); this fetcher
// is a thin proxy with the same User-Agent / auth / 304 handling as
// the entity-directive and content-envelope fetchers.

import { ofetch, FetchError } from 'ofetch'
import { SDK_USER_AGENT } from '../../version'

export interface FetchDirectoryOptions {
  endpoint: string
  entityId: string
  apiKey?: string
  page?: number
  pageSize?: number
  contentType?: string
  /** §8.8 optional filter: BCP 47 language tag. */
  language?: string
  /** §8.8 optional filter: RFC 3339 timestamp; only items updated
   *  strictly after this point are returned. */
  updatedSince?: string
  ifNoneMatch?: string
  timeoutMs?: number
}

export interface FetchDirectoryResult {
  payload: Record<string, unknown> | null
  etag: string
  notModified: boolean
}

export async function fetchContentDirectory(opts: FetchDirectoryOptions): Promise<FetchDirectoryResult> {
  const base = `${stripTrailingSlash(opts.endpoint)}/public/entity/${encodeURIComponent(opts.entityId)}/content/directory.json`
  const params = new URLSearchParams()
  if (typeof opts.page === 'number') params.set('page', String(opts.page))
  if (typeof opts.pageSize === 'number') params.set('page_size', String(opts.pageSize))
  if (opts.contentType) params.set('type', opts.contentType)
  if (opts.language) params.set('language', opts.language)
  if (opts.updatedSince) params.set('updated_since', opts.updatedSince)
  const url = params.size > 0 ? `${base}?${params.toString()}` : base

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
