// Pure helper: classify a User-Agent string as an AI crawler when it
// matches one of the known patterns. Used by the opt-in middleware
// at `src/runtime/server/middleware/ai-bot-detect.ts` to surface
// structured impressions for AI traffic.
//
// Patterns ordered most-specific-first to keep the match label
// useful: e.g. `GPTBot/1.0` returns `gptbot`, not the generic
// `chatgpt-user`. Patterns are matched case-insensitively.
//
// Sources for the canonical UA strings:
//   - OpenAI:    https://platform.openai.com/docs/bots
//   - Anthropic: https://docs.anthropic.com/en/docs/about-claude/claude-bot
//   - Google AI: https://developers.google.com/search/docs/crawling-indexing/google-extended
//   - Perplexity: https://docs.perplexity.ai/guides/bots
//   - Common Crawl + Bytedance / Cohere / Diffbot: industry references

const PATTERNS: Array<{ label: string, regex: RegExp }> = [
  // OpenAI
  { label: 'gptbot', regex: /\bGPTBot\b/i },
  { label: 'chatgpt-user', regex: /\bChatGPT-User\b/i },
  { label: 'oai-searchbot', regex: /\bOAI-SearchBot\b/i },
  // Anthropic
  { label: 'claudebot', regex: /\bClaudeBot\b/i },
  { label: 'claude-web', regex: /\bClaude-Web\b/i },
  { label: 'anthropic-ai', regex: /\bAnthropic-AI\b/i },
  // Perplexity
  { label: 'perplexitybot', regex: /\bPerplexityBot\b/i },
  // Google AI
  { label: 'google-extended', regex: /\bGoogle-Extended\b/i },
  // Common Crawl (training data)
  { label: 'ccbot', regex: /\bCCBot\b/i },
  // ByteDance
  { label: 'bytespider', regex: /\bBytespider\b/i },
  // Cohere
  { label: 'cohere-ai', regex: /\bcohere-ai\b/i },
  // Diffbot (used by some LLM data pipelines)
  { label: 'diffbot', regex: /\bDiffbot\b/i },
  // Apple
  { label: 'applebot-extended', regex: /\bApplebot-Extended\b/i },
  // Meta
  { label: 'meta-externalagent', regex: /\bmeta-externalagent\b/i },
]

export interface CrawlerMatch {
  /** Lowercased label identifying the matched crawler. */
  label: string
}

/**
 * Returns the matched crawler label when `ua` looks like a known AI
 * bot, or `null` otherwise. Empty / undefined input always returns
 * null (we don't classify unknown UAs).
 */
export function detectAICrawler(ua: string | null | undefined): CrawlerMatch | null {
  if (!ua) return null
  for (const { label, regex } of PATTERNS) {
    if (regex.test(ua)) {
      return { label }
    }
  }
  return null
}

/** Returns true when `ua` matches any known AI crawler pattern. */
export function isAICrawler(ua: string | null | undefined): boolean {
  return detectAICrawler(ua) !== null
}

/**
 * Returns true when `path` matches any of the `excludePaths` prefixes.
 * Comparison is exact-prefix; trailing slashes on the configured
 * prefix are tolerated.
 */
export function isExcludedPath(path: string, excludePaths: string[] = []): boolean {
  for (const raw of excludePaths) {
    if (!raw) continue
    const prefix = raw.endsWith('/') ? raw : raw + '/'
    if (path === raw || path.startsWith(prefix)) return true
  }
  return false
}
