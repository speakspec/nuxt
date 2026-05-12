import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchEntityDirective } from '../src/runtime/server/utils/fetch-directive'
import { ofetch, FetchError } from 'ofetch'

// We test fetch-directive in isolation by monkey-patching ofetch.raw.
// This keeps the test free of any real HTTP and any Nuxt / Nitro
// runtime — it's a pure SSR-time fetcher whose only IO is the upstream.

vi.mock('ofetch', async (importOriginal) => {
  const orig = await importOriginal<typeof import('ofetch')>()
  return {
    ...orig,
    ofetch: Object.assign(vi.fn(), { raw: vi.fn() }),
  }
})

const mockedRaw = ofetch.raw as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  mockedRaw.mockReset()
})

describe('fetchEntityDirective', () => {
  it('GETs the SpeakSpec public entity URL with auth header', async () => {
    mockedRaw.mockResolvedValueOnce({
      _data: {
        '$aidp': '0.4.0',
        entity: { id: 'urn:aidp:entity:stockfeel' },
        content: [
          { spec_version: '0.4.0', content_id: 'fixture-faq-1', type: 'faq', pinned: false },
        ],
        content_index: {
          url: 'https://stockfeel.com.tw/.well-known/aidp/content/directory.json',
          types_inlined: ['faq'],
          types_indexed: ['article'],
          total_by_type: { faq: 2, article: 5 },
          pinned_count: 0,
          updated_at: '2026-05-12T10:00:00Z',
        },
      },
      headers: new Headers({ etag: 'W/"abc"' }),
    })

    const result = await fetchEntityDirective({
      endpoint: 'https://api.speakspec.com',
      entityId: 'stockfeel',
      apiKey: 'ssk_test',
    })

    expect(mockedRaw).toHaveBeenCalledTimes(1)
    const [url, init] = mockedRaw.mock.calls[0]!
    expect(url).toBe('https://api.speakspec.com/public/entity/stockfeel')
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer ssk_test')
    // User-Agent must include the SDK version so SpeakSpec analytics
    // can slice usage by version (RFC 9110 §10.1.5 convention).
    expect((init as { headers: Record<string, string> }).headers['User-Agent']).toMatch(/^@speakspec\/nuxt\/\d/)

    expect(result.payload).toEqual({
      '$aidp': '0.4.0',
      entity: { id: 'urn:aidp:entity:stockfeel' },
      content: [
        { spec_version: '0.4.0', content_id: 'fixture-faq-1', type: 'faq', pinned: false },
      ],
      content_index: {
        url: 'https://stockfeel.com.tw/.well-known/aidp/content/directory.json',
        types_inlined: ['faq'],
        types_indexed: ['article'],
        total_by_type: { faq: 2, article: 5 },
        pinned_count: 0,
        updated_at: '2026-05-12T10:00:00Z',
      },
    })
    expect(result.etag).toBe('W/"abc"')
    expect(result.notModified).toBe(false)
  })

  it('honors a custom timeoutMs', async () => {
    mockedRaw.mockResolvedValueOnce({ _data: {}, headers: new Headers() })
    await fetchEntityDirective({
      endpoint: 'https://api.speakspec.com',
      entityId: 'x',
      timeoutMs: 1234,
    })
    const init = mockedRaw.mock.calls[0]![1] as { timeout: number }
    expect(init.timeout).toBe(1234)
  })

  it('defaults to a 5-second timeout for SSR safety', async () => {
    mockedRaw.mockResolvedValueOnce({ _data: {}, headers: new Headers() })
    await fetchEntityDirective({ endpoint: 'https://x', entityId: 'y' })
    const init = mockedRaw.mock.calls[0]![1] as { timeout: number }
    expect(init.timeout).toBe(5000)
  })

  it('strips trailing slash from endpoint', async () => {
    mockedRaw.mockResolvedValueOnce({
      _data: {},
      headers: new Headers(),
    })

    await fetchEntityDirective({
      endpoint: 'https://api.speakspec.com/',
      entityId: 'x',
    })
    expect(mockedRaw.mock.calls[0]![0]).toBe('https://api.speakspec.com/public/entity/x')
  })

  it('passes If-None-Match when ifNoneMatch is supplied', async () => {
    mockedRaw.mockResolvedValueOnce({
      _data: {},
      headers: new Headers(),
    })

    await fetchEntityDirective({
      endpoint: 'https://api.speakspec.com',
      entityId: 'x',
      ifNoneMatch: 'W/"prev-etag"',
    })

    const init = mockedRaw.mock.calls[0]![1] as { headers: Record<string, string> }
    expect(init.headers['If-None-Match']).toBe('W/"prev-etag"')
  })

  it('omits Authorization when apiKey is not supplied', async () => {
    mockedRaw.mockResolvedValueOnce({
      _data: {},
      headers: new Headers(),
    })

    await fetchEntityDirective({
      endpoint: 'https://api.speakspec.com',
      entityId: 'x',
    })

    const init = mockedRaw.mock.calls[0]![1] as { headers: Record<string, string> }
    expect(init.headers.Authorization).toBeUndefined()
  })

  it('translates 304 into a notModified result', async () => {
    const err304 = new FetchError('304 Not Modified')
    ;(err304 as unknown as { response: { status: number, headers: Headers } }).response = {
      status: 304,
      headers: new Headers({ etag: 'W/"abc"' }),
    }
    mockedRaw.mockRejectedValueOnce(err304)

    const result = await fetchEntityDirective({
      endpoint: 'https://api.speakspec.com',
      entityId: 'stockfeel',
      ifNoneMatch: 'W/"abc"',
    })

    expect(result.notModified).toBe(true)
    expect(result.payload).toBeNull()
    expect(result.etag).toBe('W/"abc"')
  })

  it('preserves the prior ETag on 304 even when upstream omits it', async () => {
    const err304 = new FetchError('304')
    ;(err304 as unknown as { response: { status: number, headers: Headers } }).response = {
      status: 304,
      headers: new Headers(),
    }
    mockedRaw.mockRejectedValueOnce(err304)

    const result = await fetchEntityDirective({
      endpoint: 'https://api.speakspec.com',
      entityId: 'stockfeel',
      ifNoneMatch: 'W/"client-etag"',
    })

    expect(result.notModified).toBe(true)
    expect(result.etag).toBe('W/"client-etag"')
  })

  it('rethrows non-304 fetch errors', async () => {
    const err500 = new FetchError('500 Internal Server Error')
    ;(err500 as unknown as { response: { status: number } }).response = { status: 500 }
    mockedRaw.mockRejectedValueOnce(err500)

    await expect(
      fetchEntityDirective({
        endpoint: 'https://api.speakspec.com',
        entityId: 'stockfeel',
      }),
    ).rejects.toBe(err500)
  })

  it('URL-encodes the entityId so slashes / spaces never break the path', async () => {
    mockedRaw.mockResolvedValueOnce({
      _data: {},
      headers: new Headers(),
    })

    await fetchEntityDirective({
      endpoint: 'https://api.speakspec.com',
      entityId: 'with space',
    })
    expect(mockedRaw.mock.calls[0]![0]).toBe('https://api.speakspec.com/public/entity/with%20space')
  })
})
