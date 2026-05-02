import { describe, it, expect } from 'vitest'
import {
  detectAICrawler,
  isAICrawler,
  isExcludedPath,
} from '../src/runtime/server/utils/bot-detect'

describe('detectAICrawler', () => {
  const positive: Array<[string, string, string]> = [
    ['Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)', 'gptbot', 'openai'],
    ['Mozilla/5.0 ChatGPT-User/1.0', 'chatgpt-user', 'openai'],
    ['Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)', 'oai-searchbot', 'openai'],
    ['Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)', 'claudebot', 'anthropic'],
    ['Mozilla/5.0 (compatible; Claude-Web/1.0; +https://claude.ai)', 'claude-web', 'anthropic'],
    ['Mozilla/5.0 (compatible; Anthropic-AI/1.0)', 'anthropic-ai', 'anthropic'],
    ['Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai)', 'perplexitybot', 'perplexity'],
    ['Mozilla/5.0 (compatible; Google-Extended)', 'google-extended', 'google'],
    ['Mozilla/5.0 (compatible; CCBot/2.0; +https://commoncrawl.org/faq)', 'ccbot', 'commoncrawl'],
    ['Mozilla/5.0 (compatible; Bytespider; spider-feedback@bytedance.com)', 'bytespider', 'bytedance'],
    ['Mozilla/5.0 cohere-ai', 'cohere-ai', 'cohere'],
    ['Mozilla/5.0 (compatible; Diffbot/0.1)', 'diffbot', 'diffbot'],
    ['Mozilla/5.0 (compatible; Applebot-Extended)', 'applebot-extended', 'apple'],
    ['Mozilla/5.0 (compatible; meta-externalagent/1.1)', 'meta-externalagent', 'meta'],
  ]

  for (const [ua, label, source] of positive) {
    it(`matches ${label} (${source}) for ${JSON.stringify(ua)}`, () => {
      expect(detectAICrawler(ua)).toEqual({ label, source })
    })
  }

  it('matches case-insensitively', () => {
    expect(detectAICrawler('mozilla/5.0 gptbot/1.0')?.label).toBe('gptbot')
    expect(detectAICrawler('MOZILLA/5.0 CLAUDEBOT/1.0')?.label).toBe('claudebot')
  })

  const negative = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', // regular Googlebot — NOT Google-Extended
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
    'curl/7.79.1',
    '',
    'AppleBot', // matches Applebot? — no, only Applebot-Extended is the AI variant
  ]

  for (const ua of negative) {
    it(`does NOT match ${JSON.stringify(ua)}`, () => {
      expect(detectAICrawler(ua)).toBeNull()
    })
  }

  it('returns null for null / undefined', () => {
    expect(detectAICrawler(null)).toBeNull()
    expect(detectAICrawler(undefined)).toBeNull()
  })

  it('uses word boundaries — substring inside another word does not match', () => {
    // The word boundary in `\bGPTBot\b` prevents false positives like
    // `MyGPTBotAdapter` (no boundary on either side of GPTBot when
    // joined to letters). This guards against a UA that mentions an
    // AI bot in a comment but is actually something else.
    expect(detectAICrawler('Mozilla/5.0 MyGPTBotAdapter/1.0')).toBeNull()
  })
})

describe('isAICrawler', () => {
  it('matches detectAICrawler results', () => {
    expect(isAICrawler('GPTBot/1.0')).toBe(true)
    expect(isAICrawler('Mozilla/5.0 Safari')).toBe(false)
    expect(isAICrawler('')).toBe(false)
  })
})

describe('isExcludedPath', () => {
  const excludes = ['/_nuxt/', '/api/_aidp/', '/admin']

  it('excludes paths under prefix', () => {
    expect(isExcludedPath('/_nuxt/abc.js', excludes)).toBe(true)
    expect(isExcludedPath('/api/_aidp/invalidate', excludes)).toBe(true)
    expect(isExcludedPath('/admin/dashboard', excludes)).toBe(true)
  })

  it('matches the prefix itself when path === prefix', () => {
    expect(isExcludedPath('/_nuxt/', excludes)).toBe(true)
    expect(isExcludedPath('/admin', excludes)).toBe(true)
  })

  it('does NOT exclude paths that share a prefix substring but not boundary', () => {
    // /_nuxt-config-test/ should NOT match /_nuxt/ — the trailing
    // slash in the configured prefix is what enforces the boundary.
    expect(isExcludedPath('/_nuxt-config-test/abc', excludes)).toBe(false)
    // /administrator should NOT match /admin — boundary required.
    expect(isExcludedPath('/administrator', excludes)).toBe(false)
  })

  it('tolerates configured prefixes without trailing slash', () => {
    // `excludes` includes both `/admin` (no trailing slash) and
    // `/api/_aidp/` (with). Both should work end-to-end.
    expect(isExcludedPath('/admin/x', excludes)).toBe(true)
    expect(isExcludedPath('/api/_aidp/x', excludes)).toBe(true)
  })

  it('returns false on empty exclude list', () => {
    expect(isExcludedPath('/anything', [])).toBe(false)
    expect(isExcludedPath('/anything')).toBe(false)
  })

  it('skips empty / falsy entries in the list', () => {
    expect(isExcludedPath('/x', ['', '/x'])).toBe(true)
  })
})
