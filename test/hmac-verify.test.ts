import { describe, it, expect } from 'vitest'
import {
  computeSignature,
  verifyHmacSignature,
  isTimestampFresh,
  urnToSlug,
} from '../src/runtime/server/utils/hmac-verify'

describe('computeSignature', () => {
  it('produces a stable hmac-sha256 string for known input (golden)', () => {
    // Pin the exact byte layout. AIDP §8.10's signing-input format is
    // `${timestamp}\n${body}` (LF separator, no trailing newline).
    // A regression here would break agent-side verification silently.
    const got = computeSignature('shhh', '2026-05-01T03:22:00Z', '{"a":1}')
    expect(got).toBe('hmac-sha256=4e60b8e29d6452bee4d9b8bc3f746538fc3059a31ef0489eb83a3df2afb413b0')
  })

  it('produces different signatures for different bodies', () => {
    const a = computeSignature('s', '2026-05-01T03:22:00Z', 'a')
    const b = computeSignature('s', '2026-05-01T03:22:00Z', 'b')
    expect(a).not.toBe(b)
  })

  it('produces different signatures for different timestamps', () => {
    const a = computeSignature('s', '2026-05-01T03:22:00Z', 'x')
    const b = computeSignature('s', '2026-05-01T03:22:01Z', 'x')
    expect(a).not.toBe(b)
  })

  it('produces different signatures for different secrets', () => {
    const a = computeSignature('s1', '2026-05-01T03:22:00Z', 'x')
    const b = computeSignature('s2', '2026-05-01T03:22:00Z', 'x')
    expect(a).not.toBe(b)
  })
})

describe('verifyHmacSignature', () => {
  it('returns true for a freshly computed signature', () => {
    const signature = computeSignature('shhh', '2026-05-01T03:22:00Z', '{"x":1}')
    expect(verifyHmacSignature({
      secret: 'shhh',
      timestamp: '2026-05-01T03:22:00Z',
      body: '{"x":1}',
      signature,
    })).toBe(true)
  })

  it('returns false on body tamper', () => {
    const signature = computeSignature('shhh', '2026-05-01T03:22:00Z', '{"x":1}')
    expect(verifyHmacSignature({
      secret: 'shhh',
      timestamp: '2026-05-01T03:22:00Z',
      body: '{"x":2}', // tampered
      signature,
    })).toBe(false)
  })

  it('returns false on signature tamper', () => {
    expect(verifyHmacSignature({
      secret: 'shhh',
      timestamp: '2026-05-01T03:22:00Z',
      body: '{}',
      signature: 'hmac-sha256=' + '0'.repeat(64),
    })).toBe(false)
  })

  it('returns false on empty secret', () => {
    expect(verifyHmacSignature({
      secret: '',
      timestamp: '2026-05-01T03:22:00Z',
      body: '{}',
      signature: 'hmac-sha256=' + '0'.repeat(64),
    })).toBe(false)
  })

  it('returns false on empty signature', () => {
    expect(verifyHmacSignature({
      secret: 'shhh',
      timestamp: '2026-05-01T03:22:00Z',
      body: '{}',
      signature: '',
    })).toBe(false)
  })

  it('returns false on mismatched length without throwing', () => {
    expect(verifyHmacSignature({
      secret: 'shhh',
      timestamp: '2026-05-01T03:22:00Z',
      body: '{}',
      signature: 'short',
    })).toBe(false)
  })
})

describe('isTimestampFresh', () => {
  it('accepts a current ISO 8601 timestamp', () => {
    expect(isTimestampFresh(new Date().toISOString())).toBe(true)
  })

  it('rejects a timestamp 10 minutes old (default 5 min window)', () => {
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    expect(isTimestampFresh(old)).toBe(false)
  })

  it('rejects a timestamp 10 minutes in the future', () => {
    const future = new Date(Date.now() + 10 * 60 * 1000).toISOString()
    expect(isTimestampFresh(future)).toBe(false)
  })

  it('honors a custom window', () => {
    const old = new Date(Date.now() - 30 * 1000).toISOString()
    expect(isTimestampFresh(old, 60 * 1000)).toBe(true)
    expect(isTimestampFresh(old, 10 * 1000)).toBe(false)
  })

  it('rejects unparseable input', () => {
    expect(isTimestampFresh('not a date')).toBe(false)
    expect(isTimestampFresh('')).toBe(false)
  })
})

describe('urnToSlug', () => {
  it('strips the urn:aidp:entity: prefix', () => {
    expect(urnToSlug('urn:aidp:entity:stockfeel')).toBe('stockfeel')
  })

  it('accepts hyphenated slugs', () => {
    expect(urnToSlug('urn:aidp:entity:my-entity-2026')).toBe('my-entity-2026')
  })

  it('passes bare slugs through unchanged', () => {
    expect(urnToSlug('stockfeel')).toBe('stockfeel')
  })

  it('throws on URN with extra colons (invalid slug shape)', () => {
    expect(() => urnToSlug('urn:aidp:entity:foo:bar')).toThrow(/did not produce a valid AIDP slug/)
  })

  it('throws on the prefix alone (empty slug)', () => {
    expect(() => urnToSlug('urn:aidp:entity:')).toThrow(/did not produce a valid AIDP slug/)
  })

  it('throws on uppercase / underscored input that violates slug rule', () => {
    expect(() => urnToSlug('urn:aidp:entity:Foo_Bar')).toThrow(/did not produce a valid AIDP slug/)
  })

  it('throws on a slug with leading or trailing hyphen', () => {
    expect(() => urnToSlug('-leading')).toThrow(/did not produce a valid AIDP slug/)
    expect(() => urnToSlug('trailing-')).toThrow(/did not produce a valid AIDP slug/)
  })
})
