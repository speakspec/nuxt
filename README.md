# @speakspec/nuxt

> AIDP 0.3 publishing channel for Nuxt 4.

A Nuxt module that turns your site into a first-class [AIDP](https://github.com/speakspec/aidp-docs) source: publishes the entity directive at `/.well-known/aidp.json`, exposes signed content endpoints + a paginated content directory, injects `<link rel="aidp">` / `<link rel="aidp-content">` discovery tags, receives cache-invalidation webhooks from SpeakSpec when directives change, and ships a `speakspec` CLI for verifying that your deployment is wired up correctly.

## Status

Phase 3 of the AIDP 0.3 PKI rollout. All sub-steps below land in this branch.

| Milestone | Status |
|---|---|
| 3.0 Repo + module skeleton | done |
| 3.1 Entity directive route + cache + ETag | done |
| 3.1.5 Webhook receiver (HMAC + replay protection) | done |
| 3.2 Content endpoint + content source adapter | done |
| 3.3 Content directory route | done |
| 3.4 Link tag injection + `<AidpDirective>` component | done |
| 3.5 AI-bot detection middleware (opt-in) | done |
| 3.6 Validator + CLI + docs | done |

## Install

```bash
pnpm add @speakspec/nuxt
```

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['@speakspec/nuxt'],
  speakspec: {
    entityId: process.env.SPEAKSPEC_ENTITY_ID,
    apiKey: process.env.SPEAKSPEC_API_KEY,
    webhookSecret: process.env.SPEAKSPEC_WEBHOOK_SECRET,
    siteOrigin: process.env.NUXT_PUBLIC_SITE_URL,
    botTracking: { enabled: true },
  },
})
```

`apiKey` and `webhookSecret` are server-side only; they MUST live in `runtimeConfig` (private) and never in `runtimeConfig.public`.

## Configuration

| Option | Required | Default | Notes |
|---|---|---|---|
| `entityId` | yes | — | SpeakSpec entity slug (lowercase alphanumerics + hyphens) |
| `apiKey` | yes | — | SpeakSpec API key (`ssk_…`); server-side only |
| `webhookSecret` | yes | — | Shared secret used to verify §8.10 cache-invalidation webhooks |
| `siteOrigin` | recommended | — | Your site's canonical origin; used for absolute URLs in emitted payloads |
| `endpoint` | no | `https://api.speakspec.com` | Override for staging or self-hosted SpeakSpec |
| `botTracking.enabled` | no | `false` | Turn on the AI-crawler detection middleware |
| `botTracking.excludePaths` | no | `['/_nuxt/', '/api/_aidp/']` | URL prefixes the middleware will skip |

## What you get

### Server routes

- `GET /.well-known/aidp.json` — entity directive (cached + ETag)
- `GET /.well-known/aidp/content/{id}.json` — signed Content envelope (§8.7)
- `GET /.well-known/aidp/content/` — paginated content directory (§8.8)
- `POST /api/_aidp/invalidate` — cache-invalidation webhook receiver (§8.10)

### HTML head injection

Site-wide:

```html
<link rel="aidp" href="https://yoursite.com/.well-known/aidp.json">
<link rel="aidp-keys" href="https://api.speakspec.com/.well-known/aidp-keys">
```

Per-page (opt-in via `useAidpContent` / `<AidpDirective>`):

```html
<link rel="aidp-content" href="https://yoursite.com/.well-known/aidp/content/{id}.json">
```

### Per-page binding (`useAidpContent` / `<AidpDirective>`)

Article / product / policy pages should opt-in to the `<link rel="aidp-content">` tag so AI agents can find the per-content envelope endpoint. Either form works:

```vue
<script setup lang="ts">
const article = await useFetch(...)
useAidpContent({ id: article.value.id })
</script>
```

```vue
<template>
  <article>
    <AidpDirective :content-id="article.id" />
    <!-- ... -->
  </article>
</template>
```

**Call `useAidpContent` only from `<script setup>` of a component** (or from another composable that itself runs in setup context). Calling from middleware, plugins, or route hooks leaks the head entry past the page lifecycle.

Listing / search / dynamic pages should NOT bind — there is no single content per page.

### AI-bot detection middleware (opt-in)

Set `speakspec.botTracking.enabled = true` and the SDK classifies inbound requests against 14 known AI-crawler patterns (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, CCBot, Bytespider, etc.). Each match emits a structured JSON line on stdout:

```json
{"msg":"aidp.crawler_impression","entity_id":"stockfeel","crawler":"gptbot","path":"/articles/etf-explainer","user_agent":"Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)","ts":"2026-05-01T07:53:27.000Z"}
```

Pipe these into your observability stack (Loki, Datadog, BigQuery, ...) — the SDK does not couple to any specific analytics backend. Excluded by default: `/_nuxt/`, `/api/_aidp/`. Add more under `botTracking.excludePaths`.

## CLI: `speakspec`

A validator that customers can run against their own deployment to confirm the SDK is publishing correctly.

```bash
# JWKS reachable + shape sane
pnpm speakspec validate-keys https://api.speakspec.com

# A specific signed bundle verifies against the issuer's JWKS
pnpm speakspec verify-bundle https://yoursite.com/.well-known/aidp/content/etf-explainer.json

# Revocation feed reachable
pnpm speakspec test-revocation https://api.speakspec.com
```

Each command exits 0 on success and 1 on any failure with a structured `reason=…` on stderr (`bad-signature`, `expired`, `unknown-kid`, `bad-algorithm`, `missing-proof`, `shape-error`, `bad-key`).

## Operations notes

- **Rate-limit `/api/_aidp/invalidate` at your CDN / WAF.** The route is HMAC-authenticated (so an attacker without the shared secret cannot evict cache), but the SDK does not throttle requests itself. Without a CDN-side limit an attacker can pin the customer's CPU on SHA-256 verification of forged payloads. SpeakSpec's dispatcher delivers at most a few webhooks per minute under normal operation, so a tight limit (e.g. 60 req/min per source IP) is safe.
- **Cache layer is Nitro `useStorage('speakspec')`.** Per-key TTLs follow `min(5min, _proof.expires_at)`; the webhook receiver invalidates on `directive` / `content` / `entity` events.
- **All upstream fetches are SSR-time.** The SDK never bakes signed bundles into the build artefact; cache misses fetch live, cache hits + `If-None-Match` keep the round-trip cheap.

## Design constraints

- **Publishing-first, not injection-first**: the module exposes endpoints; it does not blanket-inject directive JSON into every HTML page.
- **SDK is the only valid signing path**: signatures are issued by SpeakSpec server-side; the SDK relays signed bundles, it never holds the private key.
- **Customer body is never signed by SDK**: signed `_proof` covers identity + freshness + directives. Body is dynamic and stays unsigned per AIDP 0.3 §4.8.3.
- **All fetches are SSR-time**: no build-time baking. Cache hits are served from Nitro cache + ETag; cache misses fetch the latest signed bundle from SpeakSpec.
- **Webhook is mandatory**: directive changes propagate via the `/api/_aidp/invalidate` route the SDK exposes; the receiver verifies HMAC + timestamp before clearing any cache key.

## Repository layout

```
src/
├── module.ts                          # defineNuxtModule entry
└── runtime/
    ├── version.ts                     # generated: SDK_VERSION + UA constant
    ├── server/
    │   ├── routes/well-known/         # /.well-known/* handlers
    │   ├── api/_aidp/                 # invalidate webhook receiver
    │   ├── middleware/                # AI bot detection
    │   └── utils/                     # fetchers, cache, verify, hmac
    ├── composables/                   # useAidpContent
    ├── components/                    # <AidpDirective>
    └── plugins/                       # head link injection
bin/
└── speakspec.mjs                      # CLI entry (validator)
test/                                  # vitest: unit + CLI integration
scripts/
└── generate-version.mjs               # writes runtime/version.ts at build
```

The full proposal lives at `docs/proposal-speakspec-nuxt-module.md` in the workspace root; the AIDP 0.3 spec it implements is `aidp-docs/AIDP-SPEC.md` §4.8 / §8.5–8.13.

## License

MIT
