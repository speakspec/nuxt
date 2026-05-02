// CLI integration test — spawns `node bin/speakspec.mjs` against a
// localhost HTTP server that emits real signed AIDP responses, then
// asserts on exit code + stdout/stderr.
//
// Requires `pnpm prepack` to have produced dist/. The test runs
// `pnpm prepack` itself in a beforeAll so it's self-contained.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const BIN = resolve(here, '..', 'bin', 'speakspec.mjs')
const DIST_VERIFIER = resolve(here, '..', 'dist', 'runtime', 'server', 'utils', 'aidp-verify.js')

interface KP { publicKey: KeyObject, privateKey: KeyObject }
let kp: KP
let pubJwk: { kty: string, crv: string, x: string }
const KID = 'cli-test-key'

let server: Server
let issuerUrl = ''

const baseEnv = {
  '$aidp': '0.3.0',
  '@type': 'ContentEnvelope',
  'entity': { id: 'urn:aidp:entity:cli-test' },
  'id': 'cli-article-1',
  'url': 'https://example.com/cli-article-1',
  'updated_at': '2026-04-30T00:00:00Z',
}

// Intentionally duplicated from src/runtime/server/utils/aidp-verify.ts
// to test the dist build end-to-end. Keep in sync with the SDK's own
// buildCanonicalInput / canonicalJson if either ever evolves (e.g.
// when JCS object support lands).
function canonicalJson(v: unknown): string {
  return v === null || v === undefined ? 'null' : JSON.stringify(v)
}

function signEnv(payload: Record<string, unknown>, signedFields: string[], expiresAt = '2099-05-01T00:00:00Z'): Record<string, unknown> {
  const proof = {
    type: 'ed25519-jws',
    issuer: issuerUrl,
    key_id: KID,
    issued_at: '2026-05-01T00:00:00Z',
    expires_at: expiresAt,
    canonical_url: `${issuerUrl}/v/cli/test`,
    signature: '',
    signed_fields: signedFields,
  }
  const parts = [proof.key_id, proof.issued_at, proof.expires_at]
  for (const path of signedFields) {
    let cur: unknown = payload
    for (const seg of path.split('.')) {
      cur = cur && typeof cur === 'object' && !Array.isArray(cur) ? (cur as Record<string, unknown>)[seg] : null
    }
    parts.push(canonicalJson(cur))
  }
  const msg = Buffer.from(parts.join('\n'), 'utf8')
  const sig = sign(null, msg, kp.privateKey)
  proof.signature = 'ed25519:' + sig.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
  return { ...payload, _proof: proof }
}

function startServer(): Promise<void> {
  return new Promise((resolveStart, reject) => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? ''
      res.setHeader('Content-Type', 'application/json')
      if (url === '/.well-known/aidp-keys') {
        res.end(JSON.stringify({
          $aidp: '0.3.0',
          '@type': 'TrustProviderKeys',
          issuer: issuerUrl,
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
        }))
        return
      }
      if (url === '/.well-known/aidp-revocation') {
        res.end(JSON.stringify({
          $aidp: '0.3.0',
          '@type': 'RevocationList',
          issuer: issuerUrl,
          generated_at: '2026-05-01T00:00:00Z',
          revocations: [
            { content_id: 'urn:aidp:content:dropped-1', reason: 'superseded', revoked_at: '2026-04-25T00:00:00Z' },
            { key_id: 'old-key', reason: 'rotation', revoked_at: '2026-04-01T00:00:00Z' },
          ],
        }))
        return
      }
      if (url === '/bundles/good') {
        res.end(JSON.stringify(signEnv(baseEnv, ['entity.id', 'id', 'url', 'updated_at'])))
        return
      }
      if (url === '/bundles/expired') {
        res.end(JSON.stringify(signEnv(baseEnv, ['entity.id', 'id', 'url', 'updated_at'], '2020-01-01T00:00:00Z')))
        return
      }
      if (url === '/bundles/tampered') {
        const env = signEnv(baseEnv, ['entity.id', 'id', 'url', 'updated_at'])
        env.id = 'tampered-after-sign'
        res.end(JSON.stringify(env))
        return
      }
      if (url === '/bundles/no-proof') {
        res.end(JSON.stringify(baseEnv))
        return
      }
      res.statusCode = 404
      res.end('not found')
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (typeof addr === 'object' && addr) {
        issuerUrl = `http://127.0.0.1:${addr.port}`
        resolveStart()
      }
      else {
        reject(new Error('failed to start server'))
      }
    })
  })
}

beforeAll(async () => {
  if (!existsSync(DIST_VERIFIER)) {
    const r = spawnSync('pnpm', ['prepack'], { stdio: 'inherit' })
    if (r.status !== 0) throw new Error('pnpm prepack failed; cannot run CLI integration tests')
  }
  kp = generateKeyPairSync('ed25519') as KP
  pubJwk = kp.publicKey.export({ format: 'jwk' }) as { kty: string, crv: string, x: string }
  await startServer()
}, 60_000)

afterAll(() => {
  return new Promise<void>(r => server.close(() => r()))
})

interface CliResult { status: number, stdout: string, stderr: string }

function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolveRun) => {
    const child = spawn('node', [BIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => (stdout += d.toString('utf8')))
    child.stderr.on('data', d => (stderr += d.toString('utf8')))
    child.on('close', code => resolveRun({ status: code ?? 0, stdout, stderr }))
  })
}

describe('CLI: --help / --version', () => {
  it('prints usage and exits 0 on --help', async () => {
    const r = await runCli(['--help'])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/AIDP 0\.3 validator/)
    expect(r.stdout).toMatch(/validate-keys/)
    expect(r.stdout).toMatch(/verify-bundle/)
    expect(r.stdout).toMatch(/test-revocation/)
  })
  it('prints package version and exits 0 on --version', async () => {
    const r = await runCli(['--version'])
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
  })
  it('prints usage to stderr and exits 1 when no command given', async () => {
    const r = await runCli([])
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/AIDP 0\.3 validator/)
  })
  it('exits 1 on unknown command', async () => {
    const r = await runCli(['bogus-cmd'])
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/unknown command "bogus-cmd"/)
  })
})

describe('CLI: validate-keys', () => {
  it('reports OK on a valid JWKS', async () => {
    const r = await runCli(['validate-keys', issuerUrl])
    expect(r.stdout).toMatch(/validate-keys: OK/)
    expect(r.stdout).toContain(KID)
    expect(r.status).toBe(0)
  })
  it('exits 1 when issuer-url is missing', async () => {
    const r = await runCli(['validate-keys'])
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/missing required argument/)
  })
  it('exits 1 when issuer is unreachable', async () => {
    const r = await runCli(['validate-keys', 'http://127.0.0.1:1'])
    expect(r.status).toBe(1)
  })
})

describe('CLI: verify-bundle', () => {
  it('verifies a good bundle', async () => {
    const r = await runCli(['verify-bundle', `${issuerUrl}/bundles/good`])
    expect(r.stdout).toMatch(/verify-bundle: OK/)
    expect(r.status).toBe(0)
  })
  it('rejects a tampered bundle', async () => {
    const r = await runCli(['verify-bundle', `${issuerUrl}/bundles/tampered`])
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/reason=bad-signature/)
  })
  it('rejects an expired bundle', async () => {
    const r = await runCli(['verify-bundle', `${issuerUrl}/bundles/expired`])
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/reason=expired/)
  })
  it('rejects an unsigned bundle', async () => {
    const r = await runCli(['verify-bundle', `${issuerUrl}/bundles/no-proof`])
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/no `_proof` block/)
  })
})

describe('CLI: test-revocation', () => {
  it('lists revocation entries', async () => {
    const r = await runCli(['test-revocation', issuerUrl])
    expect(r.stdout).toMatch(/test-revocation: OK/)
    expect(r.stdout).toMatch(/revocations:\s+2/)
    expect(r.stdout).toMatch(/content=urn:aidp:content:dropped-1/)
    expect(r.stdout).toMatch(/key=old-key/)
    expect(r.status).toBe(0)
  })
})
