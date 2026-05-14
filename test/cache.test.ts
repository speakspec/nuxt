import { describe, it, expect } from 'vitest'
import { createEvent } from 'h3'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import {
  cacheKey,
  isFresh,
  isUpstream4xx,
  etagMatches,
  respondWithCache,
  buildContentUsage,
  DEFAULT_CACHE_TTL_MS,
  invalidateEntityCache,
  invalidateContentCache,
  type CachedBundle,
  type CacheStorage,
} from '../src/runtime/server/utils/cache'

function fakeEvent() {
  const req = new IncomingMessage(new Socket())
  const res = new ServerResponse(req)
  return createEvent(req, res) as unknown as Parameters<typeof respondWithCache>[0]
}

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

  it('also sweeps every paginated directory variant under the same slug', async () => {
    const s = new FakeStorage()
    await s.setItem(cacheKey('directory', 'stockfeel:p1s100t'), { d: 1 })
    await s.setItem(cacheKey('directory', 'stockfeel:p2s100t'), { d: 2 })
    await s.setItem(cacheKey('directory', 'stockfeel:p1s100tarticle'), { d: 3 })
    await s.setItem(cacheKey('directory', 'other:p1s100t'), { d: 4 })

    await invalidateEntityCache(s, 'stockfeel')

    expect(s.removed).toContain('directory:stockfeel:p1s100t')
    expect(s.removed).toContain('directory:stockfeel:p2s100t')
    expect(s.removed).toContain('directory:stockfeel:p1s100tarticle')
    expect(s.removed).not.toContain('directory:other:p1s100t')
  })

  it('is a no-op when no matching keys exist', async () => {
    const s = new FakeStorage()
    await invalidateEntityCache(s, 'nobody')
    // The entity and llmstxt keys are unconditionally removed; content/
    // directory keys are only removed when they actually exist in storage.
    expect(s.removed).toEqual(['entity:nobody', 'llmstxt:nobody'])
  })
})

describe('etagMatches', () => {
  it('matches identical strong tags', () => {
    expect(etagMatches('"abc"', '"abc"')).toBe(true)
  })
  it('matches identical weak tags', () => {
    expect(etagMatches('W/"abc"', 'W/"abc"')).toBe(true)
  })
  it('matches a weak tag against a strong tag with the same opaque value (RFC 7232 §2.3.2 weak compare)', () => {
    expect(etagMatches('W/"abc"', '"abc"')).toBe(true)
    expect(etagMatches('"abc"', 'W/"abc"')).toBe(true)
  })
  it('does not match different values', () => {
    expect(etagMatches('"abc"', '"def"')).toBe(false)
  })
  it('returns false on missing inputs', () => {
    expect(etagMatches('', '"abc"')).toBe(false)
    expect(etagMatches('"abc"', '')).toBe(false)
    expect(etagMatches(undefined, '"abc"')).toBe(false)
    expect(etagMatches(null, null)).toBe(false)
  })
})

describe('respondWithCache', () => {
  it('returns the payload and writes ETag + Cache-Control when no inbound match', () => {
    const event = fakeEvent()
    const out = respondWithCache(event, '"abc"', { hello: 'world' }, 'public, max-age=60', undefined)
    expect(out).toEqual({ hello: 'world' })
    expect(event.node.res.getHeader('ETag')).toBe('"abc"')
    expect(event.node.res.getHeader('Cache-Control')).toBe('public, max-age=60')
    expect(event.node.res.statusCode).toBe(200)
  })

  it('returns null and sets 304 when the inbound If-None-Match matches', () => {
    const event = fakeEvent()
    const out = respondWithCache(event, '"abc"', { hello: 'world' }, 'public, max-age=60', '"abc"')
    expect(out).toBeNull()
    expect(event.node.res.statusCode).toBe(304)
    // §8.7 304 response still carries the validators per RFC 7232 §4.1
    expect(event.node.res.getHeader('ETag')).toBe('"abc"')
    expect(event.node.res.getHeader('Cache-Control')).toBe('public, max-age=60')
  })

  it('treats W/"abc" inbound and "abc" current as a match (weak compare)', () => {
    const event = fakeEvent()
    const out = respondWithCache(event, '"abc"', {}, 'public, max-age=60', 'W/"abc"')
    expect(out).toBeNull()
    expect(event.node.res.statusCode).toBe(304)
  })

  it('omits ETag header when the etag is empty', () => {
    const event = fakeEvent()
    respondWithCache(event, '', { x: 1 }, 'public, max-age=60', undefined)
    expect(event.node.res.getHeader('ETag')).toBeUndefined()
  })

  it('sets AIDP-spec Content-Type and permissive CORS on the 200 path', () => {
    const event = fakeEvent()
    respondWithCache(event, '"abc"', { hello: 'world' }, 'public, max-age=60', undefined)
    expect(event.node.res.getHeader('Content-Type')).toBe('application/aidp+json')
    expect(event.node.res.getHeader('Access-Control-Allow-Origin')).toBe('*')
  })

  it('emits Content-Usage when payload directives.access_control is present', () => {
    const event = fakeEvent()
    respondWithCache(
      event,
      '"abc"',
      { directives: { access_control: { allow_training: true, allow_derivative: true } } },
      'public, max-age=60',
      undefined,
    )
    expect(event.node.res.getHeader('Content-Usage')).toBe('train-ai=y, search=y')
  })

  it('omits Content-Usage when payload has no access_control', () => {
    const event = fakeEvent()
    respondWithCache(event, '"abc"', { hello: 'world' }, 'public, max-age=60', undefined)
    expect(event.node.res.getHeader('Content-Usage')).toBeUndefined()
  })
})

describe('buildContentUsage', () => {
  it('returns null for non-objects', () => {
    expect(buildContentUsage(null)).toBeNull()
    expect(buildContentUsage('payload')).toBeNull()
    expect(buildContentUsage(123)).toBeNull()
  })

  it('returns null when directives is absent', () => {
    expect(buildContentUsage({ hello: 'world' })).toBeNull()
  })

  it('returns null when access_control is absent or empty', () => {
    expect(buildContentUsage({ directives: {} })).toBeNull()
    expect(buildContentUsage({ directives: { access_control: {} } })).toBeNull()
  })

  it('emits train-ai=n when allow_training is false', () => {
    expect(buildContentUsage({ directives: { access_control: { allow_training: false } } }))
      .toBe('train-ai=n')
  })

  it('combines training + derivative flags with comma separator', () => {
    expect(buildContentUsage({ directives: { access_control: { allow_training: true, allow_derivative: true } } }))
      .toBe('train-ai=y, search=y')
  })
})

describe('isUpstream4xx', () => {
  it('detects ofetch-style { response: { status: 4xx } }', () => {
    expect(isUpstream4xx({ response: { status: 401 } })).toBe(true)
    expect(isUpstream4xx({ response: { status: 404 } })).toBe(true)
    expect(isUpstream4xx({ response: { status: 499 } })).toBe(true)
  })
  it('detects bare { statusCode: 4xx }', () => {
    expect(isUpstream4xx({ statusCode: 403 })).toBe(true)
  })
  it('returns false for 5xx', () => {
    expect(isUpstream4xx({ response: { status: 502 } })).toBe(false)
    expect(isUpstream4xx({ statusCode: 503 })).toBe(false)
  })
  it('returns false for non-error shapes', () => {
    expect(isUpstream4xx(undefined)).toBe(false)
    expect(isUpstream4xx(null)).toBe(false)
    expect(isUpstream4xx('not-an-object')).toBe(false)
    expect(isUpstream4xx(new Error('network'))).toBe(false)
  })
})

describe('invalidateContentCache', () => {
  it('removes the named content key without touching siblings', async () => {
    const s = new FakeStorage()
    await s.setItem(cacheKey('content', 'stockfeel:a'), 1)
    await s.setItem(cacheKey('content', 'stockfeel:b'), 2)
    await invalidateContentCache(s, 'stockfeel', 'a')
    expect(s.removed).toContain('content:stockfeel:a')
    expect(s.store.has('content:stockfeel:b')).toBe(true)
  })

  it('does not cascade to entity-level key', async () => {
    const s = new FakeStorage()
    await s.setItem(cacheKey('entity', 'stockfeel'), { e: 1 })
    await s.setItem(cacheKey('content', 'stockfeel:a'), 1)
    await invalidateContentCache(s, 'stockfeel', 'a')
    expect(s.store.has('entity:stockfeel')).toBe(true)
  })

  it('sweeps directory variants for the same entity', async () => {
    const s = new FakeStorage()
    await s.setItem(cacheKey('content', 'stockfeel:a'), 1)
    await s.setItem(cacheKey('directory', 'stockfeel:p1s100t'), { d: 1 })
    await s.setItem(cacheKey('directory', 'stockfeel:p2s100t'), { d: 2 })
    // Other entity's directory must NOT be touched.
    await s.setItem(cacheKey('directory', 'other:p1s100t'), { d: 3 })

    await invalidateContentCache(s, 'stockfeel', 'a')

    expect(s.removed).toContain('content:stockfeel:a')
    expect(s.removed).toContain('directory:stockfeel:p1s100t')
    expect(s.removed).toContain('directory:stockfeel:p2s100t')
    expect(s.removed).not.toContain('directory:other:p1s100t')
  })
})
