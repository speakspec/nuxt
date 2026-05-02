import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchContentDirectory } from '../src/runtime/server/utils/fetch-directory'
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

describe('fetchContentDirectory', () => {
  it('GETs the SpeakSpec public directory URL with no query params by default', async () => {
    mockedRaw.mockResolvedValueOnce({
      _data: { '@type': 'ContentDirectory', total: 0, items: [] },
      headers: new Headers({ etag: 'W/"abc"' }),
    })

    const result = await fetchContentDirectory({
      endpoint: 'https://api.speakspec.com',
      entityId: 'stockfeel',
    })

    expect(mockedRaw).toHaveBeenCalledTimes(1)
    expect(mockedRaw.mock.calls[0]![0]).toBe('https://api.speakspec.com/public/entity/stockfeel/content/directory.json')
    expect(result.payload).toEqual({ '@type': 'ContentDirectory', total: 0, items: [] })
    expect(result.etag).toBe('W/"abc"')
    expect(result.notModified).toBe(false)
  })

  it('appends page / page_size / type query params when supplied', async () => {
    mockedRaw.mockResolvedValueOnce({ _data: {}, headers: new Headers() })
    await fetchContentDirectory({
      endpoint: 'https://api.speakspec.com',
      entityId: 'x',
      page: 2,
      pageSize: 50,
      contentType: 'article',
    })
    const url = mockedRaw.mock.calls[0]![0] as string
    expect(url).toContain('?')
    expect(url).toContain('page=2')
    expect(url).toContain('page_size=50')
    expect(url).toContain('type=article')
  })

  it('forwards §8.8 optional language and updated_since filters', async () => {
    mockedRaw.mockResolvedValueOnce({ _data: {}, headers: new Headers() })
    await fetchContentDirectory({
      endpoint: 'https://api.speakspec.com',
      entityId: 'x',
      language: 'zh-TW',
      updatedSince: '2026-01-01T00:00:00Z',
    })
    const url = mockedRaw.mock.calls[0]![0] as string
    expect(url).toContain('language=zh-TW')
    expect(url).toContain('updated_since=2026-01-01T00%3A00%3A00Z')
  })

  it('attaches Authorization header when apiKey is supplied', async () => {
    mockedRaw.mockResolvedValueOnce({ _data: {}, headers: new Headers() })
    await fetchContentDirectory({
      endpoint: 'https://x',
      entityId: 'a',
      apiKey: 'ssk_test',
    })
    const headers = (mockedRaw.mock.calls[0]![1] as { headers: Record<string, string> }).headers
    expect(headers.Authorization).toBe('Bearer ssk_test')
  })

  it('strips trailing slash from endpoint', async () => {
    mockedRaw.mockResolvedValueOnce({ _data: {}, headers: new Headers() })
    await fetchContentDirectory({
      endpoint: 'https://api.speakspec.com/',
      entityId: 'x',
    })
    expect(mockedRaw.mock.calls[0]![0]).toBe('https://api.speakspec.com/public/entity/x/content/directory.json')
  })

  it('passes If-None-Match through', async () => {
    mockedRaw.mockResolvedValueOnce({ _data: {}, headers: new Headers() })
    await fetchContentDirectory({
      endpoint: 'https://x',
      entityId: 'a',
      ifNoneMatch: 'W/"prev"',
    })
    const headers = (mockedRaw.mock.calls[0]![1] as { headers: Record<string, string> }).headers
    expect(headers['If-None-Match']).toBe('W/"prev"')
  })

  it('translates 304 into a notModified result', async () => {
    const err304 = new FetchError('304')
    ;(err304 as unknown as { response: { status: number, headers: Headers } }).response = {
      status: 304,
      headers: new Headers({ etag: 'W/"abc"' }),
    }
    mockedRaw.mockRejectedValueOnce(err304)

    const result = await fetchContentDirectory({
      endpoint: 'https://x',
      entityId: 'a',
      ifNoneMatch: 'W/"abc"',
    })
    expect(result.notModified).toBe(true)
    expect(result.payload).toBeNull()
  })

  it('rethrows non-304 errors', async () => {
    const err500 = new FetchError('500')
    ;(err500 as unknown as { response: { status: number } }).response = { status: 500 }
    mockedRaw.mockRejectedValueOnce(err500)

    await expect(
      fetchContentDirectory({ endpoint: 'https://x', entityId: 'a' }),
    ).rejects.toBe(err500)
  })

  it('honors custom timeoutMs and defaults to 5s', async () => {
    mockedRaw.mockResolvedValueOnce({ _data: {}, headers: new Headers() })
    await fetchContentDirectory({ endpoint: 'https://x', entityId: 'a', timeoutMs: 1234 })
    expect((mockedRaw.mock.calls[0]![1] as { timeout: number }).timeout).toBe(1234)

    mockedRaw.mockResolvedValueOnce({ _data: {}, headers: new Headers() })
    await fetchContentDirectory({ endpoint: 'https://x', entityId: 'a' })
    expect((mockedRaw.mock.calls[1]![1] as { timeout: number }).timeout).toBe(5000)
  })
})
