// AIDP 0.3 verification helpers — shared between the bin/speakspec
// CLI and runtime callers. Pure functions: HTTP fetches go through the
// global `fetch` (Node 18+), signature verification through `node:crypto`.
//
// Implements:
//   - JWKS fetch + key lookup (§8.11)
//   - canonical signed-string construction per §4.8.4
//   - ed25519 signature verification
//   - bundle expiry check (§4.8.4 verification step 4)
//   - revocation list fetch (§8.13)
//
// The verifier is conservative: any failure (network / shape / algo /
// signature mismatch / expiry) yields a structured `VerifyResult` with
// a machine-readable reason. Callers decide how to react — the spec
// (§4.8.4) requires treating failures as "unsigned" rather than
// rejecting the payload outright, but the CLI surfaces them so a
// customer running `speakspec verify-bundle` can fix the issue.

import { createPublicKey, verify as cryptoVerify } from 'node:crypto'
import { Buffer } from 'node:buffer'

import { SDK_USER_AGENT } from '../../version'

export interface JWKSKey {
  kid: string
  kty: string
  crv?: string
  x?: string
  use?: string
  alg?: string
  valid_from?: string
  valid_until?: string
  rotation?: string
}

export interface JWKS {
  $aidp?: string
  '@type'?: string
  issuer?: string
  keys: JWKSKey[]
}

export interface AIDPProof {
  type: string
  issuer: string
  key_id: string
  issued_at: string
  expires_at: string
  canonical_url?: string
  signature: string
  signed_fields: string[]
}

export interface VerifyOk {
  valid: true
  kid: string
  issuer: string
  expiresAt: string
  signedFields: string[]
}

/**
 * Discriminated union of every reason a `verifyBundle` can fail. New
 * reasons must be added here (and to the JSDoc on `verifyBundle`) so
 * callers stay exhaustive at the type level.
 */
export type VerifyFailReason =
  | 'missing-proof'
  | 'mixed-proof'
  | 'multi-proof-not-supported'
  | 'missing-canonical-url'
  | 'bad-algorithm'
  | 'unknown-kid'
  | 'key-out-of-window'
  | 'shape-error'
  | 'canonical-error'
  | 'bad-key'
  | 'bad-signature'
  | 'expired'

export interface VerifyFail {
  valid: false
  reason: VerifyFailReason
  detail?: string
}

export type VerifyResult = VerifyOk | VerifyFail

export interface FetchOptions {
  /** SSR / CLI fetch budget (default 5s). */
  timeoutMs?: number
  /** Optional User-Agent override; CLI sets `<sdk>/<ver> (validator)`. */
  userAgent?: string
  /** Hard cap on response body size in bytes. Defaults to 1 MB; the
   *  helpers below override per endpoint (10 MB for revocation lists).
   *  Larger responses abort with `response too large`. */
  maxBytes?: number
}

const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_MAX_BYTES = 1 * 1024 * 1024
const REVOCATION_MAX_BYTES = 10 * 1024 * 1024

/**
 * Fetches a JSON document with a hard timeout and a body-size cap so
 * a hostile or misconfigured upstream cannot DoS the SSR worker by
 * streaming an unbounded body. Throws on non-2xx, network failure,
 * size overrun, or invalid JSON. Error messages are human-readable
 * for direct CLI surfacing.
 */
export async function fetchJson<T = unknown>(url: string, opts: FetchOptions = {}): Promise<T> {
  const ctrl = new AbortController()
  const timeout = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': opts.userAgent ?? SDK_USER_AGENT,
        'accept': 'application/json',
      },
      signal: ctrl.signal,
    })
    if (!res.ok) {
      throw new Error(`GET ${url} → ${res.status} ${res.statusText}`)
    }
    // Content-Length pre-check is skipped for encoded responses
    // (gzip, br, ...) — Content-Length there is the compressed size,
    // which can be much smaller than the post-decode body. The
    // streaming cap below catches over-large decoded bodies anyway.
    const declared = Number(res.headers.get('content-length') ?? '')
    const encoded = !!res.headers.get('content-encoding')
    if (!encoded && Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`GET ${url}: response too large (Content-Length ${declared} > cap ${maxBytes})`)
    }
    const buf = await readCapped(res, maxBytes, url)
    try {
      return JSON.parse(buf.toString('utf8')) as T
    }
    catch (err) {
      throw new Error(`GET ${url}: invalid JSON (${(err as Error).message})`, { cause: err })
    }
  }
  finally {
    clearTimeout(timeout)
  }
}

async function readCapped(res: Response, maxBytes: number, url: string): Promise<Buffer> {
  const reader = res.body?.getReader()
  if (!reader) {
    const ab = await res.arrayBuffer()
    if (ab.byteLength > maxBytes) {
      throw new Error(`GET ${url}: response too large (${ab.byteLength} > cap ${maxBytes})`)
    }
    return Buffer.from(ab)
  }
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      try { await reader.cancel() }
      catch { /* ignore — already aborted */ }
      throw new Error(`GET ${url}: response too large (>${maxBytes} bytes)`)
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

/**
 * Returns the canonical JWKS URL for an issuer. Trims trailing
 * slashes so `${issuer}/.well-known/aidp-keys` never double-slashes.
 */
export function jwksUrl(issuer: string): string {
  return `${stripTrailingSlash(issuer)}/.well-known/aidp-keys`
}

/** Returns the canonical revocation list URL for an issuer. */
export function revocationUrl(issuer: string): string {
  return `${stripTrailingSlash(issuer)}/.well-known/aidp-revocation`
}

export async function fetchJwks(issuer: string, opts: FetchOptions = {}): Promise<JWKS> {
  return fetchJson<JWKS>(jwksUrl(issuer), opts)
}

export async function fetchRevocationList<T = unknown>(issuer: string, opts: FetchOptions = {}): Promise<T> {
  return fetchJson<T>(revocationUrl(issuer), { maxBytes: REVOCATION_MAX_BYTES, ...opts })
}

/** Find an active key by kid. Returns null when not present. */
export function findKey(jwks: JWKS, kid: string): JWKSKey | null {
  if (!jwks?.keys) return null
  return jwks.keys.find(k => k.kid === kid) ?? null
}

/**
 * Resolve a dot-path inside a payload. Returns `null` when any
 * intermediate segment is absent — matches §4.8.4 step 2.
 *
 * §4.8.4 step 2 explicitly excludes `_proof` / `_proofs` from
 * resolution: a malicious signer could otherwise list its own proof
 * block as a signed field and produce a self-referential signature.
 * We refuse such paths up front rather than relying on the spec
 * compliance of upstream signers.
 */
export function resolveDotPath(payload: unknown, path: string): unknown {
  if (payload == null) return null
  if (path === '_proof' || path === '_proofs' || path.startsWith('_proof.') || path.startsWith('_proofs.')) {
    return null
  }
  let cur: unknown = payload
  for (const seg of path.split('.')) {
    if (cur && typeof cur === 'object' && !Array.isArray(cur) && seg in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[seg]
    }
    else {
      return null
    }
  }
  return cur ?? null
}

/**
 * Canonical signed-string per §4.8.4:
 *   {key_id}\n{issued_at}\n{expires_at}\n{f1}\n{f2}\n...
 * where each `fi` is the RFC 8785 canonical JSON of the value at the
 * i-th `signed_fields` dot-path. For null we emit JSON `null`. For
 * strings we use JSON.stringify (matches the server's
 * SetEscapeHTML(false) since V8's JSON.stringify never HTML-escapes).
 *
 * Phase 3.6 covers string-typed, number/boolean, and null-valued
 * fields — every shape the server currently signs. Objects and arrays
 * throw rather than silently produce a non-canonical encoding (V8's
 * JSON.stringify does not sort keys, so it would diverge from a
 * proper RFC 8785 implementation and the verifier would silently
 * disagree with the signer). Re-enable when JCS lands.
 */
export function buildCanonicalInput(payload: unknown, proof: AIDPProof): Buffer {
  const parts: string[] = [proof.key_id, proof.issued_at, proof.expires_at]
  for (const path of proof.signed_fields) {
    const val = resolveDotPath(payload, path)
    parts.push(canonicalJson(val, path))
  }
  return Buffer.from(parts.join('\n'), 'utf8')
}

function canonicalJson(v: unknown, path: string): string {
  if (v === null || v === undefined) return 'null'
  const t = typeof v
  if (t === 'string' || t === 'number' || t === 'boolean') return JSON.stringify(v)
  throw new Error(`canonical JSON for non-scalar field "${path}" not supported (RFC 8785 JCS for objects/arrays not yet implemented)`)
}

/** Parse the spec's `ed25519:{86-char-base64url}` signature form. */
export function parseSignature(sig: string): Buffer {
  if (typeof sig !== 'string' || !sig.startsWith('ed25519:')) {
    throw new Error('signature must use the `ed25519:` prefix per §4.8.1')
  }
  const b64 = sig.slice('ed25519:'.length)
  if (b64.length !== 86) {
    throw new Error(`signature payload must be exactly 86 base64url chars, got ${b64.length}`)
  }
  const buf = Buffer.from(base64urlToStandard(b64), 'base64')
  if (buf.length !== 64) {
    throw new Error(`decoded signature must be 64 bytes, got ${buf.length}`)
  }
  return buf
}

function base64urlToStandard(s: string): string {
  // Inputs reach here only after the strict 86-char length check in
  // parseSignature, so the padding is always exactly two `=` (since
  // 86 % 4 === 2). Pad explicitly to satisfy strict base64 decoders
  // (Deno, Bun, browser polyfills) that reject unpadded input even
  // when the byte length is otherwise valid.
  return s.replace(/-/g, '+').replace(/_/g, '/') + '=='
}

/**
 * Verify an ed25519 signature given a JWK with `{kty:'OKP', crv:'Ed25519', x:'<base64url>'}`.
 * Returns true on match, false otherwise. Throws when the JWK shape
 * is invalid (so the caller can surface "key shape" vs "bad signature"
 * errors distinctly).
 */
export function verifyEd25519(jwk: JWKSKey, message: Buffer, signature: Buffer): boolean {
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.x) {
    throw new Error(`unsupported JWK: kty=${jwk.kty} crv=${jwk.crv}`)
  }
  const publicKey = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: 'jwk' })
  return cryptoVerify(null, message, publicKey, signature)
}

/**
 * True when `expiresAt` is at or before `now`. Unparseable inputs
 * fail-safe to true so a malformed `expires_at` is never accepted as
 * fresh — the verifier will surface `reason: 'expired'` and the CLI
 * will exit non-zero rather than silently treating garbage as valid.
 */
export function isExpired(expiresAt: string, now: Date = new Date()): boolean {
  const t = Date.parse(expiresAt)
  if (Number.isNaN(t)) return true
  return t <= now.getTime()
}

/**
 * Verify a signed payload against the issuer's JWKS. The payload must
 * carry a `_proof` block (§4.8.1). Multi-proof `_proofs` (§4.8.5) is
 * recognised but not yet verified — the verifier returns the
 * dedicated `multi-proof-not-supported` reason rather than the
 * misleading `missing-proof`.
 *
 * Failure modes (each returns `{valid:false, reason}`):
 *   - missing-proof:             payload has no `_proof` and no `_proofs`
 *   - mixed-proof:               both `_proof` and `_proofs` present (§4.8.5
 *                                forbids the combination)
 *   - multi-proof-not-supported: `_proofs` (plural) present without `_proof`
 *   - missing-canonical-url:     `_proof.canonical_url` absent (§4.8.2 marks
 *                                it required)
 *   - bad-algorithm:             `_proof.type` !== 'ed25519-jws'
 *   - unknown-kid:               no JWKS entry matches `_proof.key_id`
 *   - key-out-of-window:         JWKS entry exists but `_proof.issued_at`
 *                                falls outside [valid_from, valid_until]
 *   - bad-signature:             ed25519 verification returned false
 *   - expired:                   now > `_proof.expires_at`
 *   - bad-key:                   JWKS entry exists but has unsupported shape
 *   - shape-error:               signature parsing failed (wrong prefix / length)
 *   - canonical-error:           canonical-input construction threw (e.g.
 *                                object-typed signed_field encountered)
 *
 * `_proof.issuer` is intentionally NOT in the canonical signed input
 * per §4.8.4, so an attacker who controls a JWKS at a different
 * issuer URL with the same `kid` could in theory substitute the
 * issuer. Spec-conformant behaviour; callers that don't trust the
 * issuer field must verify it externally (the CLI surfaces it for
 * the operator to check).
 */
export function verifyBundle(payload: Record<string, unknown>, jwks: JWKS, now: Date = new Date()): VerifyResult {
  const proof = payload?._proof as AIDPProof | undefined
  const proofs = payload?._proofs

  if (proof && proofs !== undefined) {
    return { valid: false, reason: 'mixed-proof', detail: '§4.8.5 forbids `_proof` and `_proofs` coexisting' }
  }
  if (!proof && Array.isArray(proofs) && proofs.length > 0) {
    return { valid: false, reason: 'multi-proof-not-supported', detail: '§4.8.5 multi-proof verification is not yet implemented' }
  }
  if (!proof) return { valid: false, reason: 'missing-proof' }

  if (proof.type !== 'ed25519-jws') {
    return { valid: false, reason: 'bad-algorithm', detail: `unsupported proof type: ${proof.type}` }
  }

  if (typeof proof.canonical_url !== 'string' || proof.canonical_url.length === 0) {
    return { valid: false, reason: 'missing-canonical-url', detail: '§4.8.2 requires _proof.canonical_url' }
  }

  const key = findKey(jwks, proof.key_id)
  if (!key) {
    return { valid: false, reason: 'unknown-kid', detail: `kid=${proof.key_id} not found in JWKS` }
  }

  // §8.11: JWKS already excludes revoked keys, but a stale cached
  // copy or a misconfigured trust provider could still surface a key
  // outside its [valid_from, valid_until] window. Reject if the
  // signature was issued outside the key's validity period.
  const issuedAtMs = Date.parse(proof.issued_at)
  if (!Number.isNaN(issuedAtMs)) {
    if (key.valid_from) {
      const fromMs = Date.parse(key.valid_from)
      if (!Number.isNaN(fromMs) && issuedAtMs < fromMs) {
        return { valid: false, reason: 'key-out-of-window', detail: `issued_at=${proof.issued_at} before key valid_from=${key.valid_from}` }
      }
    }
    if (key.valid_until) {
      const untilMs = Date.parse(key.valid_until)
      if (!Number.isNaN(untilMs) && issuedAtMs > untilMs) {
        return { valid: false, reason: 'key-out-of-window', detail: `issued_at=${proof.issued_at} after key valid_until=${key.valid_until}` }
      }
    }
  }

  let signature: Buffer
  try {
    signature = parseSignature(proof.signature)
  }
  catch (err) {
    return { valid: false, reason: 'shape-error', detail: (err as Error).message }
  }

  let message: Buffer
  try {
    message = buildCanonicalInput(payload, proof)
  }
  catch (err) {
    return { valid: false, reason: 'canonical-error', detail: (err as Error).message }
  }

  let ok: boolean
  try {
    ok = verifyEd25519(key, message, signature)
  }
  catch (err) {
    return { valid: false, reason: 'bad-key', detail: (err as Error).message }
  }
  if (!ok) {
    return { valid: false, reason: 'bad-signature' }
  }

  if (isExpired(proof.expires_at, now)) {
    return { valid: false, reason: 'expired', detail: `expires_at=${proof.expires_at}` }
  }

  return {
    valid: true,
    kid: proof.key_id,
    issuer: proof.issuer,
    expiresAt: proof.expires_at,
    signedFields: proof.signed_fields,
  }
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s
}
