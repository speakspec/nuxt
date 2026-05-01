import { describe, it, expect } from 'vitest'
import { cacheKey, isFresh, DEFAULT_CACHE_TTL_MS, type CachedBundle } from '../src/runtime/server/utils/cache'

describe('cacheKey', () => {
  it('namespaces scope and id with a colon', () => {
    expect(cacheKey('entity', 'stockfeel')).toBe('entity:stockfeel')
    expect(cacheKey('content', 'etf-explainer-2026-04')).toBe('content:etf-explainer-2026-04')
  })

  it('does not URL-encode — keys are storage-internal, not HTTP paths', () => {
    expect(cacheKey('entity', 'with spaces')).toBe('entity:with spaces')
    expect(cacheKey('entity', 'with/slash')).toBe('entity:with/slash')
  })
})

describe('isFresh', () => {
  it('returns false on null', () => {
    expect(isFresh(null)).toBe(false)
  })

  it('returns true when expiresAt is in the future', () => {
    const bundle: CachedBundle<unknown> = {
      payload: {},
      etag: '',
      expiresAt: Date.now() + 60_000,
    }
    expect(isFresh(bundle)).toBe(true)
  })

  it('returns false when expiresAt has passed', () => {
    const bundle: CachedBundle<unknown> = {
      payload: {},
      etag: '',
      expiresAt: Date.now() - 1,
    }
    expect(isFresh(bundle)).toBe(false)
  })

  it('returns false when expiresAt is exactly now (boundary)', () => {
    const bundle: CachedBundle<unknown> = {
      payload: {},
      etag: '',
      expiresAt: Date.now(),
    }
    expect(isFresh(bundle)).toBe(false)
  })
})

describe('DEFAULT_CACHE_TTL_MS', () => {
  it('is 5 minutes', () => {
    expect(DEFAULT_CACHE_TTL_MS).toBe(5 * 60 * 1000)
  })
})
