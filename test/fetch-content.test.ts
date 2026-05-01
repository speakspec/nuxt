import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchContentEnvelope } from '../src/runtime/server/utils/fetch-content'
import { ofetch, FetchError } from 'ofetch'

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

describe('fetchContentEnvelope', () => {
  it('GETs the SpeakSpec public per-content URL with auth header', async () => {
    mockedRaw.mockResolvedValueOnce({
      _data: { '@type': 'Content', id: 'etf-explainer' },
      headers: new Headers({ etag: 'W/"abc"' }),
    })

    const result = await fetchContentEnvelope({
      endpoint: 'https://api.speakspec.com',
      entityId: 'stockfeel',
      contentId: 'etf-explainer',
      apiKey: 'ssk_test',
    })

    expect(mockedRaw).toHaveBeenCalledTimes(1)
    const [url, init] = mockedRaw.mock.calls[0]!
    expect(url).toBe('https://api.speakspec.com/public/entity/stockfeel/content/etf-explainer/publish.json')
    const headers = (init as { headers: Record<string, string> }).headers
    expect(headers.Authorization).toBe('Bearer ssk_test')
    expect(headers['User-Agent']).toMatch(/^@speakspec\/nuxt\/\d/)

    expect(result.payload).toEqual({ '@type': 'Content', id: 'etf-explainer' })
    expect(result.etag).toBe('W/"abc"')
    expect(result.notModified).toBe(false)
  })

  it('strips trailing slash from endpoint', async () => {
    mockedRaw.mockResolvedValueOnce({ _data: {}, headers: new Headers() })
    await fetchContentEnvelope({
      endpoint: 'https://api.speakspec.com/',
      entityId: 'x',
      contentId: 'y',
    })
    expect(mockedRaw.mock.calls[0]![0]).toBe('https://api.speakspec.com/public/entity/x/content/y/publish.json')
  })

  it('URL-encodes both entityId and contentId', async () => {
    mockedRaw.mockResolvedValueOnce({ _data: {}, headers: new Headers() })
    await fetchContentEnvelope({
      endpoint: 'https://api.speakspec.com',
      entityId: 'with space',
      contentId: 'a/b',
    })
    expect(mockedRaw.mock.calls[0]![0])
      .toBe('https://api.speakspec.com/public/entity/with%20space/content/a%2Fb/publish.json')
  })

  it('passes If-None-Match when ifNoneMatch is supplied', async () => {
    mockedRaw.mockResolvedValueOnce({ _data: {}, headers: new Headers() })
    await fetchContentEnvelope({
      endpoint: 'https://x',
      entityId: 'a',
      contentId: 'b',
      ifNoneMatch: 'W/"prev"',
    })
    const init = mockedRaw.mock.calls[0]![1] as { headers: Record<string, string> }
    expect(init.headers['If-None-Match']).toBe('W/"prev"')
  })

  it('translates 304 into a notModified result', async () => {
    const err304 = new FetchError('304 Not Modified')
    ;(err304 as unknown as { response: { status: number, headers: Headers } }).response = {
      status: 304,
      headers: new Headers({ etag: 'W/"abc"' }),
    }
    mockedRaw.mockRejectedValueOnce(err304)

    const result = await fetchContentEnvelope({
      endpoint: 'https://x',
      entityId: 'a',
      contentId: 'b',
      ifNoneMatch: 'W/"abc"',
    })
    expect(result.notModified).toBe(true)
    expect(result.payload).toBeNull()
    expect(result.etag).toBe('W/"abc"')
  })

  it('rethrows non-304 errors', async () => {
    const err500 = new FetchError('500')
    ;(err500 as unknown as { response: { status: number } }).response = { status: 500 }
    mockedRaw.mockRejectedValueOnce(err500)

    await expect(
      fetchContentEnvelope({ endpoint: 'https://x', entityId: 'a', contentId: 'b' }),
    ).rejects.toBe(err500)
  })

  it('honors custom timeoutMs and defaults to 5s', async () => {
    mockedRaw.mockResolvedValueOnce({ _data: {}, headers: new Headers() })
    await fetchContentEnvelope({ endpoint: 'https://x', entityId: 'a', contentId: 'b', timeoutMs: 1234 })
    expect((mockedRaw.mock.calls[0]![1] as { timeout: number }).timeout).toBe(1234)

    mockedRaw.mockResolvedValueOnce({ _data: {}, headers: new Headers() })
    await fetchContentEnvelope({ endpoint: 'https://x', entityId: 'a', contentId: 'b' })
    expect((mockedRaw.mock.calls[1]![1] as { timeout: number }).timeout).toBe(5000)
  })

  it('omits Authorization when apiKey is not supplied', async () => {
    mockedRaw.mockResolvedValueOnce({ _data: {}, headers: new Headers() })
    await fetchContentEnvelope({ endpoint: 'https://x', entityId: 'a', contentId: 'b' })
    const init = mockedRaw.mock.calls[0]![1] as { headers: Record<string, string> }
    expect(init.headers.Authorization).toBeUndefined()
  })
})
