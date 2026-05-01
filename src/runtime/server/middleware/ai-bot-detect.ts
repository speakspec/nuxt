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

  console.log(JSON.stringify({
    msg: 'aidp.crawler_impression',
    entity_id: config.entityId ?? '',
    crawler: matched.label,
    path,
    user_agent: ua.slice(0, 256),
    ts: new Date().toISOString(),
  }))
})
