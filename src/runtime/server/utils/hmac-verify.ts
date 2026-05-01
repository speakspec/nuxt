// HMAC verification for AIDP §8.10 cache-invalidation webhooks.
//
// Spec mandates HMAC-SHA256 over `${X-AIDP-Timestamp}\n${raw body}`,
// presented as the header `X-AIDP-Signature: hmac-sha256={hex}`. We
// recompute the signature against the SDK's configured webhookSecret
// and compare in constant time. Timestamp is also bounded to ±5 min
// (default) so a captured webhook cannot be replayed days later.

import { createHmac, timingSafeEqual } from 'node:crypto'

export interface VerifyOptions {
  /** Pre-shared secret from `runtimeConfig.speakspec.webhookSecret`. */
  secret: string
  /** `X-AIDP-Timestamp` header value (RFC 3339). */
  timestamp: string
  /** Raw request body bytes (UTF-8 string). */
  body: string
  /** `X-AIDP-Signature` header value (`hmac-sha256={hex}`). */
  signature: string
}

const SIGNATURE_PREFIX = 'hmac-sha256='

/**
 * Returns the canonical signature string for (secret, timestamp, body).
 * Used by `verifyHmacSignature` and exposed for tests / golden fixtures.
 */
export function computeSignature(secret: string, timestamp: string, body: string): string {
  const mac = createHmac('sha256', secret)
  mac.update(timestamp + '\n' + body)
  return SIGNATURE_PREFIX + mac.digest('hex')
}

/**
 * Constant-time signature comparison. Returns false on any mismatch,
 * empty secret, or unequal length.
 */
export function verifyHmacSignature(opts: VerifyOptions): boolean {
  if (!opts.secret || !opts.signature) return false
  const expected = computeSignature(opts.secret, opts.timestamp, opts.body)
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(opts.signature, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Returns true when `timestamp` parses as ISO 8601 and falls within
 * `windowMs` of the current wall clock. Default window 5 minutes
 * matches the spec recommendation; SDK consumers can tighten it via
 * the optional argument if their delivery latency is consistently
 * sub-minute.
 */
export function isTimestampFresh(timestamp: string, windowMs: number = 5 * 60 * 1000): boolean {
  const ts = Date.parse(timestamp)
  if (Number.isNaN(ts)) return false
  return Math.abs(Date.now() - ts) <= windowMs
}

/** Strip the `urn:aidp:entity:` URN prefix to recover the bare slug. */
export function urnToSlug(entityId: string): string {
  return entityId.replace(/^urn:aidp:entity:/, '')
}
