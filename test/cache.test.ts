import { describe, it, expect } from 'vitest'
import {
  cacheKey,
  isFresh,
  DEFAULT_CACHE_TTL_MS,
  invalidateEntityCache,
  invalidateContentCache,
  type CachedBundle,
  type CacheStorage,
} from '../src/runtime/server/utils/cache'

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

class FakeStorage implements CacheStorage {
  store = new Map<string, unknown>()
  removed: string[] = []

  async setItem(key: string, value: unknown) {
    this.store.set(key, value)
  }

  async removeItem(key: string) {
    this.removed.push(key)
    this.store.delete(key)
  }

  async getKeys(base: string) {
    return [...this.store.keys()].filter(k => k.startsWith(base))
  }
}

describe('invalidateEntityCache', () => {
  it('removes the entity-level directive key', async () => {
    const s = new FakeStorage()
    await s.setItem(cacheKey('entity', 'stockfeel'), { foo: 'bar' })
    await invalidateEntityCache(s, 'stockfeel')
    expect(s.removed).toContain('entity:stockfeel')
    expect(s.store.has('entity:stockfeel')).toBe(false)
  })

  it('sweeps every per-content key under the same slug', async () => {
    const s = new FakeStorage()
    await s.setItem(cacheKey('entity', 'stockfeel'), { e: 1 })
    await s.setItem(cacheKey('content', 'stockfeel:etf-explainer'), { c: 1 })
    await s.setItem(cacheKey('content', 'stockfeel:tax-guide-2026'), { c: 2 })
    // Different entity — must NOT be touched.
    await s.setItem(cacheKey('content', 'other:thing'), { c: 3 })

    await invalidateEntityCache(s, 'stockfeel')

    expect(s.removed).toContain('entity:stockfeel')
    expect(s.removed).toContain('content:stockfeel:etf-explainer')
    expect(s.removed).toContain('content:stockfeel:tax-guide-2026')
    expect(s.removed).not.toContain('content:other:thing')
    expect(s.store.has('content:other:thing')).toBe(true)
  })

  it('is a no-op when no matching keys exist', async () => {
    const s = new FakeStorage()
    await invalidateEntityCache(s, 'nobody')
    // The entity key itself is unconditionally requested for removal,
    // so the storage call count is 1 even when the key doesn't exist.
    expect(s.removed).toEqual(['entity:nobody'])
  })
})

describe('invalidateContentCache', () => {
  it('removes only the named content key', async () => {
    const s = new FakeStorage()
    await s.setItem(cacheKey('content', 'stockfeel:a'), 1)
    await s.setItem(cacheKey('content', 'stockfeel:b'), 2)
    await invalidateContentCache(s, 'stockfeel', 'a')
    expect(s.removed).toEqual(['content:stockfeel:a'])
    expect(s.store.has('content:stockfeel:b')).toBe(true)
  })

  it('does not cascade to entity-level key', async () => {
    const s = new FakeStorage()
    await s.setItem(cacheKey('entity', 'stockfeel'), { e: 1 })
    await s.setItem(cacheKey('content', 'stockfeel:a'), 1)
    await invalidateContentCache(s, 'stockfeel', 'a')
    expect(s.store.has('entity:stockfeel')).toBe(true)
  })
})
