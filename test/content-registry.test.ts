import { describe, it, expect, beforeEach } from 'vitest'
import {
  registerContent,
  lookupContentId,
  clearContentRegistry,
} from '../src/runtime/server/utils/content-registry'

beforeEach(() => clearContentRegistry())

describe('content-registry', () => {
  it('returns undefined for unregistered paths', () => {
    expect(lookupContentId('/articles/x')).toBeUndefined()
  })

  it('round-trips a registered path', () => {
    registerContent('/articles/etf-explainer', 'etf-explainer-2026-04')
    expect(lookupContentId('/articles/etf-explainer')).toBe('etf-explainer-2026-04')
  })

  it('overwrites on re-register (same path, new id)', () => {
    registerContent('/articles/x', 'old-id')
    registerContent('/articles/x', 'new-id')
    expect(lookupContentId('/articles/x')).toBe('new-id')
  })

  it('ignores empty inputs', () => {
    registerContent('', 'id')
    registerContent('/p', '')
    expect(lookupContentId('')).toBeUndefined()
    expect(lookupContentId('/p')).toBeUndefined()
  })

  it('isolates distinct paths', () => {
    registerContent('/a', 'a-id')
    registerContent('/b', 'b-id')
    expect(lookupContentId('/a')).toBe('a-id')
    expect(lookupContentId('/b')).toBe('b-id')
  })

  it('clearContentRegistry empties the map', () => {
    registerContent('/x', 'x-id')
    clearContentRegistry()
    expect(lookupContentId('/x')).toBeUndefined()
  })
})
