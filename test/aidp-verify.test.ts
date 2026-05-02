import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest'
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { Buffer } from 'node:buffer'
import {
  type AIDPProof,
  type JWKS,
  type JWKSKey,
  buildCanonicalInput,
  fetchJson,
  fetchJwks,
  fetchRevocationList,
  findKey,
  isExpired,
  jwksUrl,
  parseSignature,
  resolveDotPath,
  revocationUrl,
  verifyBundle,
  verifyEd25519,
} from '../src/runtime/server/utils/aidp-verify'

interface KeyPair {
  publicKey: KeyObject
  privateKey: KeyObject
}

const ISSUER = 'https://api.speakspec.example'

let kp: KeyPair
let pubJwk: { kty: string, crv: string, x: string }
const KID = 'test-key-1'

beforeAll(() => {
  kp = generateKeyPairSync('ed25519') as KeyPair
  pubJwk = kp.publicKey.export({ format: 'jwk' }) as { kty: string, crv: string, x: string }
})

function makeJwks(): JWKS {
  return {
    $aidp: '0.3.0',
    '@type': 'TrustProviderKeys',
    issuer: ISSUER,
    keys: [{
      kid: KID,
      kty: pubJwk.kty,
      crv: pubJwk.crv,
      x: pubJwk.x,
      use: 'sig',
      alg: 'EdDSA',
      valid_from: '2026-01-01T00:00:00Z',
      valid_until: '2099-01-01T00:00:00Z',
    }],
  }
}

function signEnvelope(payload: Record<string, unknown>, signedFields: string[], expiresAt = '2099-05-01T00:00:00Z'): { proof: AIDPProof, signed: Record<string, unknown> } {
  const proof: AIDPProof = {
    type: 'ed25519-jws',
    issuer: ISSUER,
    key_id: KID,
    issued_at: '2026-05-01T00:00:00Z',
    expires_at: expiresAt,
    canonical_url: 'https://api.speakspec.example/v/foo/bar',
    signature: '',
    signed_fields: signedFields,
  }
  const msg = buildCanonicalInput(payload, proof)
  const sig = sign(null, msg, kp.privateKey)
  proof.signature = 'ed25519:' + sig.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
  return { proof, signed: { ...payload, _proof: proof } }
}

const baseEnv = {
  '$aidp': '0.3.0',
  '@type': 'ContentEnvelope',
  'entity': { id: 'urn:aidp:entity:foo' },
  'id': 'article-1',
  'url': 'https://foo.example/articles/1',
  'updated_at': '2026-04-30T12:00:00Z',
}

const STD_FIELDS = ['entity.id', 'id', 'url', 'updated_at']

describe('jwksUrl / revocationUrl', () => {
  it('appends well-known paths', () => {
    expect(jwksUrl('https://api.example.com')).toBe('https://api.example.com/.well-known/aidp-keys')
    expect(revocationUrl('https://api.example.com')).toBe('https://api.example.com/.well-known/aidp-revocation')
  })
  it('strips trailing slash', () => {
    expect(jwksUrl('https://api.example.com/')).toBe('https://api.example.com/.well-known/aidp-keys')
    expect(revocationUrl('https://api.example.com/')).toBe('https://api.example.com/.well-known/aidp-revocation')
  })
})

describe('resolveDotPath', () => {
  it('resolves nested objects', () => {
    expect(resolveDotPath({ a: { b: { c: 1 } } }, 'a.b.c')).toBe(1)
  })
  it('returns null on missing intermediate', () => {
    expect(resolveDotPath({ a: { } }, 'a.b.c')).toBeNull()
  })
  it('returns null on missing leaf', () => {
    expect(resolveDotPath({ a: { b: undefined } }, 'a.b')).toBeNull()
  })
  it('returns null when input is null/undefined', () => {
    expect(resolveDotPath(null, 'a')).toBeNull()
    expect(resolveDotPath(undefined, 'a')).toBeNull()
  })
  it('returns null when crossing into a non-object', () => {
    expect(resolveDotPath({ a: 'string' }, 'a.b')).toBeNull()
    expect(resolveDotPath({ a: [1, 2] }, 'a.0')).toBeNull()
  })
})

describe('parseSignature', () => {
  it('decodes a valid signature', () => {
    const buf = Buffer.alloc(64, 7)
    const b64 = buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
    const out = parseSignature(`ed25519:${b64}`)
    expect(out.length).toBe(64)
    expect(out[0]).toBe(7)
  })
  it('rejects missing prefix', () => {
    expect(() => parseSignature('zzzz')).toThrow(/ed25519:/)
  })
  it('rejects wrong length', () => {
    expect(() => parseSignature('ed25519:short')).toThrow(/86 base64url chars/)
  })
  it('rejects non-string input', () => {
    // @ts-expect-error — explicit invalid input for the runtime guard
    expect(() => parseSignature(null)).toThrow(/ed25519:/)
  })
})

describe('isExpired', () => {
  it('detects past', () => {
    expect(isExpired('2020-01-01T00:00:00Z', new Date('2026-05-01T00:00:00Z'))).toBe(true)
  })
  it('treats future as not expired', () => {
    expect(isExpired('2099-01-01T00:00:00Z', new Date('2026-05-01T00:00:00Z'))).toBe(false)
  })
  it('treats unparseable as expired (fail-safe)', () => {
    expect(isExpired('not-a-date')).toBe(true)
  })
  it('treats exact equality as expired', () => {
    const t = '2026-05-01T00:00:00Z'
    expect(isExpired(t, new Date(t))).toBe(true)
  })
})

describe('findKey', () => {
  it('finds by kid', () => {
    const j = makeJwks()
    expect(findKey(j, KID)).toEqual(j.keys[0])
  })
  it('returns null on miss', () => {
    expect(findKey(makeJwks(), 'nope')).toBeNull()
  })
  it('returns null on empty JWKS', () => {
    expect(findKey({ keys: [] }, 'k')).toBeNull()
  })
})

describe('verifyEd25519', () => {
  it('rejects unsupported JWK shape', () => {
    const bad: JWKSKey = { kid: KID, kty: 'RSA' }
    const sig = Buffer.alloc(64)
    expect(() => verifyEd25519(bad, Buffer.from('x'), sig)).toThrow(/unsupported JWK/)
  })
})

describe('verifyBundle', () => {
  it('accepts a valid signed envelope', () => {
    const { signed } = signEnvelope(baseEnv, STD_FIELDS)
    const r = verifyBundle(signed, makeJwks())
    expect(r.valid).toBe(true)
    if (r.valid) expect(r.kid).toBe(KID)
  })

  it('returns missing-proof when _proof absent', () => {
    expect(verifyBundle({ ...baseEnv }, makeJwks())).toMatchObject({ valid: false, reason: 'missing-proof' })
  })

  it('returns bad-algorithm for non-ed25519', () => {
    const { signed } = signEnvelope(baseEnv, STD_FIELDS)
    ;(signed._proof as AIDPProof).type = 'rsa-jws'
    expect(verifyBundle(signed, makeJwks())).toMatchObject({ valid: false, reason: 'bad-algorithm' })
  })

  it('returns unknown-kid when JWKS has no matching key', () => {
    const { signed } = signEnvelope(baseEnv, STD_FIELDS)
    const j = makeJwks()
    j.keys[0]!.kid = 'someone-else'
    expect(verifyBundle(signed, j)).toMatchObject({ valid: false, reason: 'unknown-kid' })
  })

  it('returns bad-signature when payload is tampered', () => {
    const { signed } = signEnvelope(baseEnv, STD_FIELDS)
    ;(signed as Record<string, unknown>).id = 'tampered'
    expect(verifyBundle(signed, makeJwks())).toMatchObject({ valid: false, reason: 'bad-signature' })
  })

  it('returns bad-signature when signature bytes are flipped', () => {
    const { signed } = signEnvelope(baseEnv, STD_FIELDS)
    const proof = signed._proof as AIDPProof
    // Flip a high-information char in the middle. The trailing
    // base64url char encodes only 4 significant bits of the 64-byte
    // signature so flipping the last character may leave the decoded
    // bytes identical — pick a middle character to guarantee the
    // signature actually changes.
    const i = Math.floor(proof.signature.length / 2)
    const ch = proof.signature[i]
    const flipped = ch === 'A' ? 'B' : 'A'
    proof.signature = proof.signature.slice(0, i) + flipped + proof.signature.slice(i + 1)
    expect(verifyBundle(signed, makeJwks())).toMatchObject({ valid: false, reason: 'bad-signature' })
  })

  it('returns shape-error when signature prefix wrong', () => {
    const { signed } = signEnvelope(baseEnv, STD_FIELDS)
    ;(signed._proof as AIDPProof).signature = 'rsa:zzzzzz'
    expect(verifyBundle(signed, makeJwks())).toMatchObject({ valid: false, reason: 'shape-error' })
  })

  it('returns expired when expires_at is in the past, even with good sig', () => {
    const { signed } = signEnvelope(baseEnv, STD_FIELDS, '2020-01-01T00:00:00Z')
    expect(verifyBundle(signed, makeJwks(), new Date('2026-05-01T00:00:00Z'))).toMatchObject({ valid: false, reason: 'expired' })
  })

  it('handles null-valued signed fields without throwing', () => {
    const env = { ...baseEnv, optional_field: null }
    const { signed } = signEnvelope(env, [...STD_FIELDS, 'optional_field'])
    expect(verifyBundle(signed, makeJwks())).toMatchObject({ valid: true })
  })

  it('handles missing dot-path as null per §4.8.4', () => {
    const env = { ...baseEnv }
    const { signed } = signEnvelope(env, [...STD_FIELDS, 'nonexistent.field'])
    expect(verifyBundle(signed, makeJwks())).toMatchObject({ valid: true })
  })

  it('returns mixed-proof when both _proof and _proofs are present (§4.8.5)', () => {
    const { signed } = signEnvelope(baseEnv, STD_FIELDS)
    ;(signed as Record<string, unknown>)._proofs = [signed._proof]
    expect(verifyBundle(signed, makeJwks())).toMatchObject({ valid: false, reason: 'mixed-proof' })
  })

  it('returns multi-proof-not-supported when only _proofs (plural) is present', () => {
    const { signed } = signEnvelope(baseEnv, STD_FIELDS)
    const proofs = [signed._proof]
    const noSingle: Record<string, unknown> = { ...signed }
    delete noSingle._proof
    noSingle._proofs = proofs
    expect(verifyBundle(noSingle as Record<string, unknown>, makeJwks())).toMatchObject({ valid: false, reason: 'multi-proof-not-supported' })
  })

  it('returns canonical-error when a signed_field references an object value', () => {
    // Sign normally over string fields (the helper would itself throw
    // if asked to sign an object), then mutate the proof's
    // signed_fields list and inject the object value. verifyBundle
    // now hits the canonical-error path rather than silently
    // producing non-canonical bytes against a permissive verifier.
    const { signed } = signEnvelope(baseEnv, STD_FIELDS)
    ;(signed._proof as AIDPProof).signed_fields = [...STD_FIELDS, 'complex']
    ;(signed as Record<string, unknown>).complex = { nested: 'value' }
    expect(verifyBundle(signed, makeJwks())).toMatchObject({ valid: false, reason: 'canonical-error' })
  })

  it('refuses self-referential signed_fields paths (_proof / _proofs)', () => {
    // A malicious signer that lists `_proof.signature` in signed_fields
    // would otherwise produce a signature over its own signature
    // bytes. resolveDotPath returns null for any `_proof*` path,
    // forcing the signer's hand into producing a verifiable canonical
    // input that does NOT cover the proof itself.
    expect(resolveDotPath({ _proof: { signature: 'x' } }, '_proof')).toBeNull()
    expect(resolveDotPath({ _proof: { signature: 'x' } }, '_proof.signature')).toBeNull()
    expect(resolveDotPath({ _proofs: [{ signature: 'x' }] }, '_proofs')).toBeNull()
    expect(resolveDotPath({ _proofs: [{}] }, '_proofs.0')).toBeNull()
  })
})

describe('buildCanonicalInput', () => {
  it('produces deterministic bytes', () => {
    const proof: AIDPProof = {
      type: 'ed25519-jws',
      issuer: ISSUER,
      key_id: KID,
      issued_at: '2026-05-01T00:00:00Z',
      expires_at: '2099-05-01T00:00:00Z',
      signature: '',
      signed_fields: STD_FIELDS,
    }
    const a = buildCanonicalInput(baseEnv, proof)
    const b = buildCanonicalInput(baseEnv, proof)
    expect(a.equals(b)).toBe(true)
    expect(a.toString('utf8')).toBe(
      [
        KID,
        '2026-05-01T00:00:00Z',
        '2099-05-01T00:00:00Z',
        '"urn:aidp:entity:foo"',
        '"article-1"',
        '"https://foo.example/articles/1"',
        '"2026-04-30T12:00:00Z"',
      ].join('\n'),
    )
  })

  it('does not HTML-escape strings (matches Go SetEscapeHTML(false))', () => {
    const proof: AIDPProof = {
      type: 'ed25519-jws',
      issuer: ISSUER,
      key_id: KID,
      issued_at: 'i',
      expires_at: 'e',
      signature: '',
      signed_fields: ['title'],
    }
    const got = buildCanonicalInput({ title: 'A & B <c>' }, proof).toString('utf8')
    expect(got.endsWith('"A & B <c>"')).toBe(true)
  })
})

describe('fetchJson + fetchJwks + fetchRevocationList', () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  afterEach(() => fetchSpy.mockReset())

  it('fetches JSON happy path', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: 1 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const out = await fetchJson<{ ok: number }>('https://x/y')
    expect(out).toEqual({ ok: 1 })
    const callArgs = fetchSpy.mock.calls[0]!
    expect(callArgs[0]).toBe('https://x/y')
    const headers = (callArgs[1] as RequestInit).headers as Record<string, string>
    // Headers are case-insensitive — fetch helpers use lowercase keys
    // for portability across runtimes.
    expect(headers['user-agent']).toMatch(/^@speakspec\/nuxt\//)
    expect(headers.accept).toBe('application/json')
  })

  it('throws on non-2xx with status info', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('nope', { status: 503, statusText: 'Service Unavailable' }))
    await expect(fetchJson('https://x/y')).rejects.toThrow(/503/)
  })

  it('throws on invalid JSON with a wrapped, contextful message', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('not-json{', { status: 200, headers: { 'content-type': 'application/json' } }))
    await expect(fetchJson('https://x/y')).rejects.toThrow(/invalid JSON/)
  })

  it('rejects responses larger than the declared cap (Content-Length)', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'content-length': '999999999' },
    }))
    await expect(fetchJson('https://x/y', { maxBytes: 1024 })).rejects.toThrow(/response too large/)
  })

  it('rejects responses larger than the cap when Content-Length lies (streamed)', async () => {
    const big = 'x'.repeat(2048)
    fetchSpy.mockResolvedValueOnce(new Response(`"${big}"`, { status: 200 }))
    await expect(fetchJson('https://x/y', { maxBytes: 1024 })).rejects.toThrow(/response too large/)
  })

  it('fetchJwks calls the canonical URL', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(makeJwks()), { status: 200 }))
    const j = await fetchJwks(ISSUER)
    expect(j.keys[0]!.kid).toBe(KID)
    expect(fetchSpy.mock.calls[0]![0]).toBe(`${ISSUER}/.well-known/aidp-keys`)
  })

  it('fetchRevocationList calls the canonical URL', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ revocations: [] }), { status: 200 }))
    await fetchRevocationList(ISSUER)
    expect(fetchSpy.mock.calls[0]![0]).toBe(`${ISSUER}/.well-known/aidp-revocation`)
  })

  it('honours custom User-Agent', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))
    await fetchJson('https://x/y', { userAgent: 'speakspec-cli/0.0.1' })
    const headers = (fetchSpy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>
    expect(headers['user-agent']).toBe('speakspec-cli/0.0.1')
  })
})
