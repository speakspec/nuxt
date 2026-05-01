import { describe, it, expect } from 'vitest'
import {
  entityLink,
  keysLink,
  contentLink,
} from '../src/runtime/utils/links'

describe('entityLink', () => {
  it('points at the SDK-served entity directive', () => {
    expect(entityLink('https://stockfeel.com.tw')).toEqual({
      rel: 'aidp',
      href: 'https://stockfeel.com.tw/.well-known/aidp.json',
    })
  })

  it('strips trailing slash from siteOrigin', () => {
    expect(entityLink('https://stockfeel.com.tw/')).toEqual({
      rel: 'aidp',
      href: 'https://stockfeel.com.tw/.well-known/aidp.json',
    })
  })
})

describe('keysLink', () => {
  it('points at the trust provider JWKS endpoint', () => {
    expect(keysLink('https://api.speakspec.com')).toEqual({
      rel: 'aidp-keys',
      href: 'https://api.speakspec.com/.well-known/aidp-keys',
    })
  })

  it('strips trailing slash from endpoint', () => {
    expect(keysLink('https://api.speakspec.com/')).toEqual({
      rel: 'aidp-keys',
      href: 'https://api.speakspec.com/.well-known/aidp-keys',
    })
  })
})

describe('contentLink', () => {
  it('points at the per-content envelope endpoint on the SDK', () => {
    expect(contentLink('https://stockfeel.com.tw', 'etf-explainer-2026-04')).toEqual({
      rel: 'aidp-content',
      href: 'https://stockfeel.com.tw/.well-known/aidp/content/etf-explainer-2026-04.json',
    })
  })

  it('URL-encodes the contentId so weird characters never break the path', () => {
    expect(contentLink('https://x', 'with space')).toEqual({
      rel: 'aidp-content',
      href: 'https://x/.well-known/aidp/content/with%20space.json',
    })
    expect(contentLink('https://x', 'a/b')).toEqual({
      rel: 'aidp-content',
      href: 'https://x/.well-known/aidp/content/a%2Fb.json',
    })
  })

  it('preserves dots inside the contentId (e.g. policy versions)', () => {
    expect(contentLink('https://x', 'policy-v2.4')).toEqual({
      rel: 'aidp-content',
      href: 'https://x/.well-known/aidp/content/policy-v2.4.json',
    })
  })

  it('strips trailing slash from siteOrigin', () => {
    expect(contentLink('https://x/', 'a')).toEqual({
      rel: 'aidp-content',
      href: 'https://x/.well-known/aidp/content/a.json',
    })
  })
})
