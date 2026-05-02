import { describe, it, expect } from 'vitest'
import { parsePositiveInt } from '../src/runtime/server/utils/query'

describe('parsePositiveInt', () => {
  it('returns undefined on empty inputs', () => {
    expect(parsePositiveInt(undefined, 'page')).toBeUndefined()
    expect(parsePositiveInt(null, 'page')).toBeUndefined()
    expect(parsePositiveInt('', 'page')).toBeUndefined()
  })

  it('parses valid positive integers', () => {
    expect(parsePositiveInt('1', 'page')).toBe(1)
    expect(parsePositiveInt('100', 'page')).toBe(100)
    expect(parsePositiveInt(42, 'page')).toBe(42)
  })

  it('rejects 0 (page=0 normalised to 1 server-side, but fast-fail here)', () => {
    expect(() => parsePositiveInt('0', 'page')).toThrow(/positive integer/)
    expect(() => parsePositiveInt(0, 'page')).toThrow(/positive integer/)
  })

  it('rejects negative integers', () => {
    expect(() => parsePositiveInt('-1', 'page')).toThrow(/positive integer/)
    expect(() => parsePositiveInt(-3, 'page')).toThrow(/positive integer/)
  })

  it('rejects non-integers', () => {
    expect(() => parsePositiveInt('1.5', 'page')).toThrow(/positive integer/)
    expect(() => parsePositiveInt('abc', 'page')).toThrow(/positive integer/)
    expect(() => parsePositiveInt(NaN, 'page')).toThrow(/positive integer/)
    expect(() => parsePositiveInt(Infinity, 'page')).toThrow(/positive integer/)
  })

  it('rejects array form (`?page=1&page=2`)', () => {
    expect(() => parsePositiveInt(['1', '2'], 'page_size')).toThrow(/single value/)
  })

  it('echoes the field name in the error message', () => {
    expect(() => parsePositiveInt('0', 'page_size')).toThrow(/page_size/)
  })
})
