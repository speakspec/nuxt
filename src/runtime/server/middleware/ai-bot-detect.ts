// Opt-in server middleware that classifies inbound requests as AI
// crawler traffic and emits a structured slog event. With
// `botTracking.upload.enabled`, impressions are batched and POSTed
// to SpeakSpec's `/api/v1/entities/{eid}/impressions` so the
// dashboard's analytics page surfaces them. Without upload (default),
// impressions print to stdout for the host's own log pipeline.
//
// Both modes never block the request path — upload is fire-and-forget
// via the in-memory queue.

import { defineEventHandler, getHeader, getRequestIP, getRequestURL } from 'h3'
import { useRuntimeConfig } from '#imports'
import { detectAICrawler, isExcludedPath } from '../utils/bot-detect'
import { lookupContentId } from '../utils/content-registry'
import { configureQueue, enqueueImpression, type ImpressionRecord } from '../utils/impression-queue'

let queueConfigured = false

export default defineEventHandler((event) => {
  const config = useRuntimeConfig().speakspec
  const tracking = config?.botTracking

  if (!tracking?.enabled) return

  const path = getRequestURL(event).pathname
  if (isExcludedPath(path, tracking.excludePaths)) return

  const ua = getHeader(event, 'user-agent') ?? ''
  const matched = detectAICrawler(ua)
  if (!matched) return

  const impression: ImpressionRecord = {
    msg: 'aidp.crawler_impression',
    crawler: matched.label,
    crawler_source: matched.source,
    path,
    user_agent: ua.slice(0, 256),
    ts: new Date().toISOString(),
  }
  if (config?.entityId) impression.entity_id = config.entityId
  const cid = lookupContentId(path)
  if (cid) impression.content_id = cid
  const ip = getRequestIP(event, { xForwardedFor: true })
  if (ip) impression.client_ip = ip

  const upload = tracking.upload
  if (upload?.enabled && config?.entityId && config?.apiKey) {
    if (!queueConfigured) {
      configureQueue({
        endpoint: config.endpoint,
        apiKey: config.apiKey,
        batchSize: upload.batchSize ?? 50,
        flushIntervalMs: upload.flushIntervalMs ?? 60_000,
        maxQueueBytes: upload.maxQueueBytes ?? 2 * 1024 * 1024,
        onError: upload.onError ?? 'fallback-stdout',
      })
      queueConfigured = true
    }
    enqueueImpression(impression)
    return
  }

  console.log(JSON.stringify(impression))
})
