// Webhook receiver for AIDP 0.3 §8.10 cache invalidation.
//
//   POST /api/_aidp/invalidate
//   Headers: X-AIDP-Signature: hmac-sha256={hex}, X-AIDP-Timestamp
//   Body:    { $aidp, event, entity_id, scope, content_id?, timestamp }
//
// Verification flow:
//   1. webhookSecret must be configured (otherwise 503 — operator error).
//   2. X-AIDP-Signature and X-AIDP-Timestamp headers MUST be present
//      (400 otherwise — malformed request).
//   3. Timestamp MUST fall within ±5 min of server clock (401 — replay
//      protection; an attacker can't capture a delivery and replay it).
//   4. HMAC over `${timestamp}\n${raw body}` MUST match the header
//      using the pre-shared secret (401 — forgery rejection,
//      constant-time compare).
//   5. Parse the body as JSON; reject malformed (400).
//   6. Invalidate the corresponding cache key. For scope=entity we
//      also invalidate all per-content keys for that entity (so the
//      content endpoints from Step 3.2 stay consistent).
//   7. Respond 204.
//
// Failures are surfaced as 4xx so the SpeakSpec-side webhook
// dispatcher's audit log shows the failure category clearly.

import { defineEventHandler, readRawBody, getHeader, createError, setResponseStatus } from 'h3'
import { useStorage } from 'nitropack/runtime'
import { useRuntimeConfig } from '#imports'
import { verifyHmacSignature, isTimestampFresh, urnToSlug } from '../../utils/hmac-verify'
import {
  STORAGE_NAMESPACE,
  invalidateEntityCache,
  invalidateContentCache,
} from '../../utils/cache'

// Nonce tracking is intentionally omitted. The action this endpoint
// performs (clear cache key) is idempotent and bounded — replaying a
// captured payload within the ±5 min timestamp window only forces an
// extra upstream re-fetch on the next request. Nonce storage would
// add Nitro storage round-trips on every legitimate webhook for a
// negligible security gain. Customers who need stricter replay
// guarantees should rate-limit /api/_aidp/invalidate at their CDN.

// Body cap. Spec §8.10 webhook payloads are <1 KB. 64 KB is generous
// headroom for future fields without permitting a CPU-soak attack
// where a forged multi-megabyte body forces SHA-256 work pre-auth.
const MAX_WEBHOOK_BODY_BYTES = 64 * 1024

const VALID_SCOPES = new Set(['entity', 'content'])

// §8.10 v0.3 emits a single canonical event name. Reject anything
// else as defense-in-depth: HMAC catches forgery; a wrong `event`
// here surfaces a dispatcher bug at integration time rather than
// silently invalidating a cache key on an unintended trigger.
const VALID_EVENTS = new Set(['directive.updated'])

interface InvalidationPayload {
  $aidp?: string
  event?: string
  entity_id?: string
  scope?: 'entity' | 'content'
  content_id?: string
  timestamp?: string
}

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig().speakspec

  if (!config?.webhookSecret) {
    throw createError({
      statusCode: 503,
      statusMessage: 'AIDP webhook receiver not configured: missing webhookSecret',
    })
  }

  const signature = getHeader(event, 'x-aidp-signature')
  const timestamp = getHeader(event, 'x-aidp-timestamp')

  if (!signature || !timestamp) {
    throw createError({
      statusCode: 400,
      statusMessage: 'missing X-AIDP-Signature or X-AIDP-Timestamp header',
    })
  }

  if (!isTimestampFresh(timestamp)) {
    throw createError({
      statusCode: 401,
      statusMessage: 'X-AIDP-Timestamp outside ±5 minute window (replay protection)',
    })
  }

  const rawBody = await readRawBody(event, false)
  if (!rawBody || rawBody.byteLength === 0) {
    throw createError({ statusCode: 400, statusMessage: 'empty request body' })
  }
  if (rawBody.byteLength > MAX_WEBHOOK_BODY_BYTES) {
    throw createError({
      statusCode: 413,
      statusMessage: `webhook body exceeds ${MAX_WEBHOOK_BODY_BYTES} bytes`,
    })
  }
  const bodyString = Buffer.from(rawBody).toString('utf8')

  const valid = verifyHmacSignature({
    secret: config.webhookSecret,
    timestamp,
    body: bodyString,
    signature,
  })
  if (!valid) {
    throw createError({
      statusCode: 401,
      statusMessage: 'X-AIDP-Signature does not match',
    })
  }

  let payload: InvalidationPayload
  try {
    payload = JSON.parse(bodyString)
  }
  catch {
    throw createError({ statusCode: 400, statusMessage: 'invalid JSON body' })
  }

  if (!payload.scope || !payload.entity_id) {
    throw createError({
      statusCode: 400,
      statusMessage: 'payload missing required fields (scope, entity_id)',
    })
  }
  if (payload.event && !VALID_EVENTS.has(payload.event)) {
    throw createError({
      statusCode: 400,
      statusMessage: `unsupported event "${payload.event}" (expected one of: ${[...VALID_EVENTS].join(', ')})`,
    })
  }
  if (!VALID_SCOPES.has(payload.scope)) {
    throw createError({
      statusCode: 400,
      statusMessage: `unsupported scope "${payload.scope}" (expected entity|content)`,
    })
  }
  if (payload.scope === 'content' && !payload.content_id) {
    throw createError({
      statusCode: 400,
      statusMessage: 'scope=content requires content_id',
    })
  }
  // Cross-check the body's `timestamp` field against the
  // `X-AIDP-Timestamp` header. The Go dispatcher emits both with the
  // same value; a mismatch indicates the body was tampered with after
  // signing OR that someone replayed a captured timestamp under a
  // forged body. The HMAC check already rejects forged bodies, so
  // this is belt-and-braces — but cheap and useful in audit logs.
  if (payload.timestamp && payload.timestamp !== timestamp) {
    throw createError({
      statusCode: 400,
      statusMessage: 'body.timestamp does not match X-AIDP-Timestamp header',
    })
  }

  const slug = urnToSlug(payload.entity_id)
  const storage = useStorage(STORAGE_NAMESPACE)

  if (payload.scope === 'entity') {
    // Entity-level change cascades to the directive cache plus every
    // per-content cache entry under the same slug. Step 3.2 will start
    // populating the content keys; the sweep here is forward-compatible.
    await invalidateEntityCache(storage, slug)
  }
  else {
    await invalidateContentCache(storage, slug, payload.content_id!)
  }

  setResponseStatus(event, 204)
  return null
})
