#!/usr/bin/env node
// speakspec — CLI for @speakspec/nuxt customers.
//
// Three commands per the §4.7 proposal:
//   - validate-keys <issuer-url>      Fetch JWKS, list keys, sanity-check
//   - verify-bundle <bundle-url>      Fetch a signed AIDP bundle and verify
//                                     its _proof against the issuer's JWKS
//   - test-revocation <issuer-url>    Fetch revocation list, summarise
//
// Imports the verifier from dist/ — `pnpm prepack` must run before
// `pnpm speakspec` works locally; published installs ship the built
// output so `npx speakspec` works out of the box.

import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const distEntry = resolve(here, '..', 'dist', 'runtime', 'server', 'utils', 'aidp-verify.js')

if (!existsSync(distEntry)) {
  console.error('speakspec: build artefacts missing — run `pnpm prepack` (or `npm run build`) first.')
  console.error(`           expected: ${distEntry}`)
  process.exit(2)
}

const { fetchJwks, fetchRevocationList, fetchJson, verifyBundle } = await import(distEntry)

const { SDK_USER_AGENT, SDK_VERSION } = await import(resolve(here, '..', 'dist', 'runtime', 'version.js'))
const CLI_USER_AGENT = `${SDK_USER_AGENT} (validator)`

const argv = process.argv.slice(2)
const cmd = argv[0]
const rest = argv.slice(1)

const HELP = `speakspec — AIDP 0.3 validator

Usage:
  speakspec validate-keys <issuer-url>
  speakspec verify-bundle <bundle-url>
  speakspec test-revocation <issuer-url>
  speakspec --help
  speakspec --version

Examples:
  speakspec validate-keys https://api.speakspec.com
  speakspec verify-bundle https://stockfeel.com.tw/.well-known/aidp/content/etf-explainer.json
  speakspec test-revocation https://api.speakspec.com
`

if (cmd === '-v' || cmd === '--version') {
  console.log(SDK_VERSION)
  process.exit(0)
}

if (cmd === '-h' || cmd === '--help') {
  console.log(HELP)
  process.exit(0)
}

if (!cmd) {
  // Conventional UNIX behaviour: usage to stderr + exit 1 when invoked
  // without args. Tests assert exit 1 here.
  process.stderr.write(HELP)
  process.exit(1)
}

try {
  switch (cmd) {
    case 'validate-keys':
      await validateKeys(rest)
      break
    case 'verify-bundle':
      await verifyBundleCmd(rest)
      break
    case 'test-revocation':
      await testRevocation(rest)
      break
    default:
      console.error(`speakspec: unknown command "${cmd}"`)
      console.error(HELP)
      process.exit(1)
  }
}
catch (err) {
  console.error(`speakspec: ${err?.message ?? err}`)
  process.exit(1)
}

async function validateKeys(args) {
  const issuer = requireArg(args, 0, 'issuer-url', 'validate-keys')
  console.log(`fetching JWKS from ${issuer}/.well-known/aidp-keys ...`)
  const jwks = await fetchJwks(issuer, { userAgent: CLI_USER_AGENT })
  if (!jwks?.keys || !Array.isArray(jwks.keys)) {
    throw new Error('JWKS response missing `keys` array (expected per RFC 7517)')
  }
  console.log(`issuer:    ${jwks.issuer ?? '(not declared)'}`)
  console.log(`spec:      ${jwks.$aidp ?? '(not declared)'}`)
  console.log(`type:      ${jwks['@type'] ?? '(not declared)'}`)
  console.log(`keys:      ${jwks.keys.length}`)
  let anyIssue = false
  for (const k of jwks.keys) {
    const issues = []
    if (k.kty !== 'OKP') issues.push(`kty=${k.kty}`)
    if (k.crv !== 'Ed25519') issues.push(`crv=${k.crv}`)
    if (typeof k.x !== 'string' || k.x.length === 0) issues.push('missing x')
    if (k.use !== undefined && k.use !== 'sig') issues.push(`use=${k.use} (expected sig)`)
    if (k.alg !== undefined && k.alg !== 'EdDSA') issues.push(`alg=${k.alg} (expected EdDSA)`)
    if (!k.valid_from) issues.push('missing valid_from')
    if (!k.valid_until) issues.push('missing valid_until')
    if (issues.length) anyIssue = true
    const tag = issues.length ? `  (issues: ${issues.join(', ')})` : ''
    const fields = [`kid=${k.kid}`]
    if (k.alg) fields.push(`alg=${k.alg}`)
    if (k.valid_until) fields.push(`valid_until=${k.valid_until}`)
    if (k.rotation) fields.push(`rotation=${k.rotation}`)
    console.log(`  - ${fields.join('  ')}${tag}`)
  }
  if (jwks.keys.length === 0 || anyIssue) {
    console.error('validate-keys: FAIL — see issues above')
    process.exit(1)
  }
  console.log('validate-keys: OK')
}

async function verifyBundleCmd(args) {
  const url = requireArg(args, 0, 'bundle-url', 'verify-bundle')
  console.log(`fetching bundle ${url} ...`)
  const bundle = await fetchJson(url, { userAgent: CLI_USER_AGENT })
  const proof = bundle?._proof
  if (!proof) {
    throw new Error('bundle has no `_proof` block — only signed bundles can be verified')
  }
  if (!proof.issuer) {
    throw new Error('`_proof.issuer` missing; cannot locate JWKS')
  }
  console.log(`bundle proof: kid=${proof.key_id}  issuer=${proof.issuer}`)
  console.log(`fetching JWKS from declared issuer ${proof.issuer} (verify this is the trust provider you expect)`)
  const jwks = await fetchJwks(proof.issuer, { userAgent: CLI_USER_AGENT })
  const result = verifyBundle(bundle, jwks)
  if (result.valid) {
    console.log(`verify-bundle: OK (kid=${result.kid}, expires_at=${result.expiresAt})`)
    console.log(`  signed_fields: ${result.signedFields.join(', ')}`)
  }
  else {
    console.error(`verify-bundle: FAIL — reason=${result.reason}${result.detail ? `, detail=${result.detail}` : ''}`)
    process.exit(1)
  }
}

async function testRevocation(args) {
  const issuer = requireArg(args, 0, 'issuer-url', 'test-revocation')
  console.log(`fetching revocation list from ${issuer}/.well-known/aidp-revocation ...`)
  const list = await fetchRevocationList(issuer, { userAgent: CLI_USER_AGENT })
  const revs = Array.isArray(list?.revocations) ? list.revocations : []
  console.log(`issuer:        ${list?.issuer ?? '(not declared)'}`)
  console.log(`generated_at:  ${list?.generated_at ?? '(not declared)'}`)
  console.log(`expires_at:    ${list?.expires_at ?? '-'}`)
  console.log(`revocations:   ${revs.length}`)
  const sample = revs.slice(0, 5)
  for (const r of sample) {
    const target = r.entity_id ? `entity=${r.entity_id}` : r.content_id ? `content=${r.content_id}` : r.key_id ? `key=${r.key_id}` : '(unknown target)'
    console.log(`  - ${target}  reason=${r.reason}  revoked_at=${r.revoked_at}`)
  }
  if (revs.length > sample.length) {
    console.log(`  ... and ${revs.length - sample.length} more`)
  }
  console.log('test-revocation: OK')
}

function requireArg(args, idx, name, cmd) {
  const v = args[idx]
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`speakspec ${cmd}: missing required argument <${name}>`)
  }
  return v
}
