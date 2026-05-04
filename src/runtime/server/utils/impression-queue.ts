// Buffered queue for AI-crawler impressions observed by the SDK
// middleware. Flushes to the SpeakSpec server's
// POST {endpoint}/api/v1/impressions endpoint in batches.
//
// Design contract:
//   - Fire-and-forget: enqueue() returns immediately, flush runs async
//   - Bounded memory: maxQueueBytes hard cap (drops oldest on overrun)
//   - Backoff on failure: N consecutive flush errors → pause 5 min
//   - Fallback on permanent failure: emit each impression to stdout so
//     the customer's log pipeline still sees it
//
// The queue is module-scoped — one instance per Nitro process. In
// serverless deployments with cold starts, items in flight may be
// lost (acceptable per fire-and-forget design).

import { Buffer } from 'node:buffer'
import { SDK_USER_AGENT } from '../../version'

export interface ImpressionRecord {
  msg: string
  crawler: string
  crawler_source: string
  path: string
  user_agent: string
  ts: string
  entity_id?: string
  content_id?: string
  client_ip?: string
}

export interface QueueConfig {
  endpoint: string
  apiKey: string
  batchSize: number
  flushIntervalMs: number
  maxQueueBytes: number
  onError: 'fallback-stdout' | 'silent'
  /** Override for tests; default uses global fetch. */
  fetcher?: typeof fetch
  /** Override for tests; default uses console.log. */
  logger?: (line: string) => void
}

const DEFAULT_CONFIG: Pick<QueueConfig, 'batchSize' | 'flushIntervalMs' | 'maxQueueBytes' | 'onError'> = {
  batchSize: 50,
  flushIntervalMs: 60_000,
  maxQueueBytes: 2 * 1024 * 1024,
  onError: 'fallback-stdout',
}

const BACKOFF_THRESHOLD = 5
const BACKOFF_DURATION_MS = 5 * 60_000

interface QueueState {
  items: ImpressionRecord[]
  bytes: number
  consecutiveFailures: number
  backoffUntil: number
  flushTimer: ReturnType<typeof setTimeout> | null
}

let state: QueueState = newState()
let activeConfig: QueueConfig | null = null

function newState(): QueueState {
  return { items: [], bytes: 0, consecutiveFailures: 0, backoffUntil: 0, flushTimer: null }
}

export function configureQueue(cfg: QueueConfig): void {
  activeConfig = { ...DEFAULT_CONFIG, ...cfg }
}

export function resetQueue(): void {
  if (state.flushTimer) clearTimeout(state.flushTimer)
  state = newState()
  activeConfig = null
}

export function enqueueImpression(impression: ImpressionRecord): void {
  if (!activeConfig) {
    fallbackLog(impression, 'fallback-stdout', console.log)
    return
  }
  const cfg = activeConfig
  const size = approximateSize(impression)
  while (state.bytes + size > cfg.maxQueueBytes && state.items.length > 0) {
    const dropped = state.items.shift()!
    state.bytes -= approximateSize(dropped)
    fallbackLog(dropped, cfg.onError, cfg.logger ?? console.log)
  }
  state.items.push(impression)
  state.bytes += size

  if (state.items.length >= cfg.batchSize) {
    void flushQueue()
    return
  }
  scheduleFlush(cfg)
}

function scheduleFlush(cfg: QueueConfig): void {
  if (state.flushTimer) return
  state.flushTimer = setTimeout(() => {
    state.flushTimer = null
    void flushQueue()
  }, cfg.flushIntervalMs)
  if (typeof state.flushTimer === 'object' && state.flushTimer && typeof (state.flushTimer as { unref?: () => void }).unref === 'function') {
    (state.flushTimer as { unref: () => void }).unref()
  }
}

export async function flushQueue(): Promise<void> {
  if (!activeConfig || state.items.length === 0) return
  if (state.flushTimer) {
    clearTimeout(state.flushTimer)
    state.flushTimer = null
  }
  const cfg = activeConfig
  if (Date.now() < state.backoffUntil) {
    drainTo(cfg, cfg.onError)
    return
  }

  const batch = state.items
  state.items = []
  state.bytes = 0

  const payload = {
    impressions: batch.map(i => ({
      user_agent: i.user_agent,
      path: i.path,
      content_id: i.content_id,
      client_ip: i.client_ip,
    })),
  }

  try {
    const fetcher = cfg.fetcher ?? fetch
    const url = `${stripTrailingSlash(cfg.endpoint)}/api/v1/impressions`
    const ctrl = new AbortController()
    const timeout = setTimeout(() => ctrl.abort(), 5000)
    const res = await fetcher(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json',
        'user-agent': SDK_USER_AGENT,
        'x-api-key': cfg.apiKey,
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    })
    clearTimeout(timeout)
    if (!res.ok) {
      throw new Error(`POST impressions → ${res.status} ${res.statusText}`)
    }
    state.consecutiveFailures = 0
  }
  catch {
    state.consecutiveFailures += 1
    if (state.consecutiveFailures >= BACKOFF_THRESHOLD) {
      state.backoffUntil = Date.now() + BACKOFF_DURATION_MS
    }
    for (const item of batch) {
      fallbackLog(item, cfg.onError, cfg.logger ?? console.log)
    }
  }
}

function drainTo(cfg: QueueConfig, mode: 'fallback-stdout' | 'silent'): void {
  const items = state.items
  state.items = []
  state.bytes = 0
  for (const i of items) fallbackLog(i, mode, cfg.logger ?? console.log)
}

function fallbackLog(impression: ImpressionRecord, mode: 'fallback-stdout' | 'silent', logger: (line: string) => void): void {
  if (mode === 'silent') return
  logger(JSON.stringify(impression))
}

function approximateSize(record: ImpressionRecord): number {
  return Buffer.byteLength(JSON.stringify(record), 'utf8')
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s
}

export function _peekQueue(): { count: number, bytes: number, consecutiveFailures: number, backoffUntil: number } {
  return { count: state.items.length, bytes: state.bytes, consecutiveFailures: state.consecutiveFailures, backoffUntil: state.backoffUntil }
}
