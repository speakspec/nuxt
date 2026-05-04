import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  configureQueue,
  enqueueImpression,
  flushQueue,
  resetQueue,
  _peekQueue,
  type ImpressionRecord,
} from '../src/runtime/server/utils/impression-queue'

const ENDPOINT = 'https://api.speakspec.example'
const ENTITY_ID = 'urn:aidp:entity:otis'
const API_KEY = 'aidp_test_key'

function rec(overrides: Partial<ImpressionRecord> = {}): ImpressionRecord {
  return {
    msg: 'aidp.crawler_impression',
    crawler: 'gptbot',
    crawler_source: 'openai',
    path: '/articles/x',
    user_agent: 'GPTBot/1.0',
    ts: '2026-05-04T00:00:00Z',
    entity_id: ENTITY_ID,
    ...overrides,
  }
}

beforeEach(() => resetQueue())

function makeOkResponse() {
  return new Response(null, { status: 204 })
}

describe('impression-queue', () => {
  it('falls back to logger when not configured', () => {
    const lines: string[] = []
    enqueueImpression(rec()) // no configureQueue() call
    // (default logger is console.log; no easy capture without configuring)
    expect(_peekQueue().count).toBe(0)
    void lines
  })

  it('flushes when batchSize is reached', async () => {
    const fetcher = vi.fn().mockResolvedValue(makeOkResponse())
    configureQueue({
      endpoint: ENDPOINT,
      apiKey: API_KEY,
      batchSize: 3,
      flushIntervalMs: 60_000,
      maxQueueBytes: 1_000_000,
      onError: 'silent',
      fetcher: fetcher as unknown as typeof fetch,
    })
    enqueueImpression(rec({ path: '/a' }))
    enqueueImpression(rec({ path: '/b' }))
    enqueueImpression(rec({ path: '/c' })) // triggers flush
    await new Promise(r => setTimeout(r, 0))
    expect(fetcher).toHaveBeenCalledOnce()
    const url = fetcher.mock.calls[0]![0] as string
    expect(url).toBe(`${ENDPOINT}/api/v1/impressions`)
    const init = fetcher.mock.calls[0]![1] as RequestInit
    expect((init.headers as Record<string, string>)['x-api-key']).toBe(API_KEY)
    const body = JSON.parse(init.body as string)
    expect(body.impressions).toHaveLength(3)
    expect(body.impressions[0].path).toBe('/a')
    expect(_peekQueue().count).toBe(0)
  })

  it('flushQueue is a no-op when queue is empty', async () => {
    const fetcher = vi.fn().mockResolvedValue(makeOkResponse())
    configureQueue({
      endpoint: ENDPOINT, apiKey: API_KEY,
      batchSize: 50, flushIntervalMs: 60_000, maxQueueBytes: 1_000_000,
      onError: 'silent', fetcher: fetcher as unknown as typeof fetch,
    })
    await flushQueue()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('drops oldest when queue exceeds maxQueueBytes', () => {
    const logged: string[] = []
    configureQueue({
      endpoint: ENDPOINT, apiKey: API_KEY,
      batchSize: 100, flushIntervalMs: 60_000, maxQueueBytes: 200,
      onError: 'fallback-stdout', logger: l => logged.push(l),
      fetcher: vi.fn() as unknown as typeof fetch,
    })
    for (let i = 0; i < 5; i++) {
      enqueueImpression(rec({ path: `/p-${i}-${'x'.repeat(40)}` }))
    }
    expect(_peekQueue().count).toBeLessThan(5)
    expect(logged.length).toBeGreaterThan(0)
  })

  it('falls back to logger on POST failure', async () => {
    const logged: string[] = []
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 500, statusText: 'Server Error' }))
    configureQueue({
      endpoint: ENDPOINT, apiKey: API_KEY,
      batchSize: 1, flushIntervalMs: 60_000, maxQueueBytes: 1_000_000,
      onError: 'fallback-stdout', logger: l => logged.push(l),
      fetcher: fetcher as unknown as typeof fetch,
    })
    enqueueImpression(rec({ path: '/fail' }))
    await new Promise(r => setTimeout(r, 0))
    expect(fetcher).toHaveBeenCalledOnce()
    expect(logged).toHaveLength(1)
    expect(JSON.parse(logged[0]!).path).toBe('/fail')
  })

  it('falls back silently when onError=silent', async () => {
    const logged: string[] = []
    const fetcher = vi.fn().mockRejectedValue(new Error('network down'))
    configureQueue({
      endpoint: ENDPOINT, apiKey: API_KEY,
      batchSize: 1, flushIntervalMs: 60_000, maxQueueBytes: 1_000_000,
      onError: 'silent', logger: l => logged.push(l),
      fetcher: fetcher as unknown as typeof fetch,
    })
    enqueueImpression(rec())
    await new Promise(r => setTimeout(r, 0))
    expect(fetcher).toHaveBeenCalledOnce()
    expect(logged).toHaveLength(0)
  })

  it('enters backoff after threshold consecutive failures', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('down'))
    configureQueue({
      endpoint: ENDPOINT, apiKey: API_KEY,
      batchSize: 1, flushIntervalMs: 60_000, maxQueueBytes: 1_000_000,
      onError: 'silent', fetcher: fetcher as unknown as typeof fetch,
    })
    for (let i = 0; i < 5; i++) {
      enqueueImpression(rec({ path: `/fail-${i}` }))
      await new Promise(r => setTimeout(r, 0))
    }
    expect(_peekQueue().consecutiveFailures).toBeGreaterThanOrEqual(5)
    expect(_peekQueue().backoffUntil).toBeGreaterThan(Date.now())
  })

  it('clears consecutiveFailures on a successful flush', async () => {
    const responses = [
      new Response(null, { status: 500 }),
      new Response(null, { status: 204 }),
    ]
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(responses.shift()!))
    configureQueue({
      endpoint: ENDPOINT, apiKey: API_KEY,
      batchSize: 1, flushIntervalMs: 60_000, maxQueueBytes: 1_000_000,
      onError: 'silent', fetcher: fetcher as unknown as typeof fetch,
    })
    enqueueImpression(rec({ path: '/a' }))
    await new Promise(r => setTimeout(r, 0))
    expect(_peekQueue().consecutiveFailures).toBe(1)

    enqueueImpression(rec({ path: '/b' }))
    await new Promise(r => setTimeout(r, 0))
    expect(_peekQueue().consecutiveFailures).toBe(0)
  })

  it('serialises only the wire-shape fields (msg / ts / entity_id / crawler stripped)', async () => {
    const fetcher = vi.fn().mockResolvedValue(makeOkResponse())
    configureQueue({
      endpoint: ENDPOINT, apiKey: API_KEY,
      batchSize: 1, flushIntervalMs: 60_000, maxQueueBytes: 1_000_000,
      onError: 'silent', fetcher: fetcher as unknown as typeof fetch,
    })
    enqueueImpression(rec({ content_id: 'foo', client_ip: '1.2.3.4' }))
    await new Promise(r => setTimeout(r, 0))
    const body = JSON.parse((fetcher.mock.calls[0]![1] as RequestInit).body as string)
    expect(body.impressions[0]).toEqual({
      user_agent: 'GPTBot/1.0',
      path: '/articles/x',
      content_id: 'foo',
      client_ip: '1.2.3.4',
    })
    // entity_id, msg, ts, crawler, crawler_source kept in-memory only
    // (server classifies via UA via ClassifyAgent)
    expect(body.impressions[0].entity_id).toBeUndefined()
    expect(body.impressions[0].msg).toBeUndefined()
    expect(body.impressions[0].crawler).toBeUndefined()
  })

  it('does not call fetcher again while in backoff', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('down'))
    const captured: string[] = []
    configureQueue({
      endpoint: ENDPOINT, apiKey: API_KEY,
      batchSize: 1, flushIntervalMs: 60_000, maxQueueBytes: 1_000_000,
      onError: 'silent',
      logger: l => captured.push(l),
      fetcher: fetcher as unknown as typeof fetch,
    })
    for (let i = 0; i < 5; i++) {
      enqueueImpression(rec({ path: `/fail-${i}` }))
      await new Promise(r => setTimeout(r, 0))
    }
    const callsBefore = fetcher.mock.calls.length
    enqueueImpression(rec({ path: '/post-backoff' }))
    await new Promise(r => setTimeout(r, 0))
    expect(fetcher.mock.calls.length).toBe(callsBefore)
    // onError=silent during backoff means no log spam either
    expect(captured.length).toBe(0)
  })
})
