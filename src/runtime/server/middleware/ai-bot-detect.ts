// Opt-in server middleware that classifies inbound requests as AI
// crawler traffic and emits a structured slog event. Customers can
// pipe these events into their own observability stack (or scrape
// Nitro logs) to measure AI consumption end-to-end without coupling
// the SDK to any particular analytics backend.
//
// The middleware runs only when `botTracking.enabled` is true in the
// module config (default: false). Requests under any path in
// `botTracking.excludePaths` are skipped before UA inspection so
// /api/_aidp/invalidate, /_nuxt/, etc. don't pollute the signal.

import { defineEventHandler, getHeader, getRequestURL } from 'h3'
import { useRuntimeConfig } from '#imports'
import { detectAICrawler, isExcludedPath } from '../utils/bot-detect'

export default defineEventHandler((event) => {
  const config = useRuntimeConfig().speakspec
  const tracking = config?.botTracking

  if (!tracking?.enabled) return

  const path = getRequestURL(event).pathname
  if (isExcludedPath(path, tracking.excludePaths)) return

  const ua = getHeader(event, 'user-agent') ?? ''
  const matched = detectAICrawler(ua)
  if (!matched) return

  // Build the impression record. `entity_id` is omitted (rather than
  // logged as an empty string) when the module isn't configured —
  // empty fields are noise for log aggregation.
  const impression: Record<string, unknown> = {
    msg: 'aidp.crawler_impression',
    crawler: matched.label,
    crawler_source: matched.source,
    path,
    user_agent: ua.slice(0, 256),
    ts: new Date().toISOString(),
  }
  if (config?.entityId) impression.entity_id = config.entityId

  console.log(JSON.stringify(impression))
})
