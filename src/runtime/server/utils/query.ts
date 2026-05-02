// Pure helpers for parsing inbound HTTP query-string params on the
// AIDP routes. Kept separate from h3 so unit tests can run outside a
// Nitro context.

import { createError } from 'h3'

/**
 * Parse an optional positive-integer query value (>= 1). Returns
 * undefined when the input is unset, throws an h3 400 when the input
 * is malformed, an array (multiple `?key=...&key=...`), or a non
 * positive integer.
 *
 * `page=0` is rejected (the server normalises it but a fast-fail at
 * the SDK layer surfaces the customer's mistake immediately).
 */
export function parsePositiveInt(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (Array.isArray(value)) {
    throw createError({ statusCode: 400, statusMessage: `${name} must be a single value` })
  }
  const n = Number(value)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw createError({ statusCode: 400, statusMessage: `${name} must be a positive integer (>= 1)` })
  }
  return n
}
