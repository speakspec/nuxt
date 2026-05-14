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
| 3.4 Link tag injection + `<AidpDirective>` component | done (link tags only; §8.9 inline embedding deferred) |
| 3.5 AI-bot detection middleware (opt-in) | done |
| 3.6 Validator + CLI + docs | done |

**3.4 deferral note.** The AIDP 0.3 spec §8.9 also describes an
optional `<script type="application/aidp+json">` inline-embedding
mode where a signed pointer (or a signed-full payload) is dropped
straight into the page HTML. Phase 3 ships only the link-tag
discovery surface (§8.5); inline embedding will follow in a later
phase. Customer sites publish the signed pointer at the per-content
endpoint today, which is sufficient for §8.7-aware AI agents.

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
| `webhookSecret` | yes (when `/api/_aidp/invalidate` is reachable) | — | Shared secret used to verify §8.10 cache-invalidation webhooks; the receiver returns 503 when it's unset |
| `siteOrigin` | recommended | — | Your site's canonical origin; used for absolute URLs in emitted payloads |
| `endpoint` | no | `https://api.speakspec.com` | Override for staging or self-hosted SpeakSpec |
| `botTracking.enabled` | no | `false` | Turn on the AI-crawler detection middleware |
| `botTracking.excludePaths` | no | `['/_nuxt/', '/api/_aidp/']` | URL prefixes the middleware will skip |
| `cache.ttlSec` | no | `300` | SDK internal cache TTL (seconds); webhook invalidation is the canonical refresh path |
| `cache.entityMaxAge` | no | `60` | `/.well-known/aidp.json` `Cache-Control: max-age` (seconds) — bounds revocation propagation through Cloudflare/CloudFront |
| `cache.entitySwr` | no | `300` | entity `stale-while-revalidate` |
| `cache.contentMaxAge` | no | `300` | per-content `max-age` |
| `cache.contentSwr` | no | `600` | per-content `stale-while-revalidate` |
| `cache.directoryMaxAge` | no | `60` | content directory `max-age` |
| `cache.directorySwr` | no | `300` | content directory `stale-while-revalidate` |

### Cache tuning

There are two layers of caching — they answer different questions:

| Layer | What it does | Default | Affects |
|---|---|---|---|
| **SDK internal** (`cache.ttlSec`) | how long the SDK process reuses a fetched bundle before re-fetching from SpeakSpec | 300s | origin load on SpeakSpec |
| **`Cache-Control: max-age`** (per-route) | how long downstream caches (Cloudflare, CloudFront, AI agents) reuse the response | 60s entity/directory, 300s content | revocation propagation, CDN cost |

The SDK internal TTL is mostly a safety net for missed webhooks — when SpeakSpec receives a revocation, it sends a webhook that clears the SDK cache instantly. Downstream `max-age` is the real ceiling on how quickly AI agents see the revocation.

**Why entity = 60s but content = 300s by default?** The entity directive (`/.well-known/aidp.json`) is the revocation pivot — when a customer revokes a fact, this is the document AI agents re-fetch first to learn what's still valid. Short `max-age` keeps revocation fast. Per-content envelopes (`/.well-known/aidp/content/{id}.json`) are content-addressed: each `updated_at` produces a new signed bundle, so longer caching is safe.

**Setting `max-age=0`** disables CDN caching for that route but does NOT disable `stale-while-revalidate` — the CDN still serves stale within the SWR window while it revalidates. To fully disable caching, set both `*MaxAge: 0` and `*Swr: 0`.

**Trade-off**: longer `max-age` means lower origin/CDN cost but slower revocation. Worst-case revocation propagation is bounded by `max-age + stale-while-revalidate`. If you want sub-minute revocation across Cloudflare, additionally wire SpeakSpec's webhook to a Cloudflare cache-purge — out of SDK scope.

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['@speakspec/nuxt'],
  speakspec: {
    entityId: 'your-slug',
    cache: {
      // High-traffic site behind Cloudflare: trade revocation speed for cost
      entityMaxAge: 600,    // 10 min instead of default 1 min
      entitySwr: 1800,      // 30 min SWR
      contentMaxAge: 3600,  // 1 hour
      contentSwr: 7200,     // 2 hour SWR
    },
  },
})
```

## What you get

### Server routes

- `GET /.well-known/aidp.json` — entity directive (cached + ETag)
- `GET /.well-known/aidp/content/{id}.json` — signed Content envelope (§8.7)
- `GET /.well-known/aidp/content/` — paginated content directory (§8.8)
- `POST /api/_aidp/invalidate` — cache-invalidation webhook receiver (§8.10)
- `GET /llms.txt` — llms.txt projection per spec §11.3 (opt-in, see below)

**llms.txt (opt-in)**

```ts
// nuxt.config.ts
speakspec: {
  entityId: 'your-entity',
  llmsTxt: true,   // enables GET /llms.txt
}
```

The route serves a live `text/markdown` projection of your AIDP entity data. The cache is swept automatically when the webhook receiver invalidates the entity directive.

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
{"msg":"aidp.crawler_impression","entity_id":"stockfeel","crawler":"gptbot","crawler_source":"openai","path":"/articles/etf-explainer","user_agent":"Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)","ts":"2026-05-01T07:53:27.000Z"}
```

`crawler_source` aggregates labels by trust provider (`openai`, `anthropic`, `perplexity`, `google`, `commoncrawl`, `bytedance`, `cohere`, `diffbot`, `apple`, `meta`) — useful for log-side filtering. `entity_id` is omitted when the module isn't configured.

Pipe these into your observability stack (Loki, Datadog, BigQuery, ...) — the SDK does not couple to any specific analytics backend. Excluded by default: `/_nuxt/`, `/api/_aidp/`. Add more under `botTracking.excludePaths`.

## Content inline vs directory (v0.4+)

AIDP v0.4 introduces per-type content strategy. The entity owner can decide, per content type, whether content appears:

- **Inline** (`inline`, default): full content envelopes appear inside `/.well-known/aidp.json`'s `content` array
- **Directory** (`directory`): the type is omitted from `aidp.json.content`; AI agents fetch `/.well-known/aidp/content/directory.json` for the index, and `/.well-known/aidp/content/{id}.json` for individual envelopes

The `content_index` field in `aidp.json` declares which types are inlined vs indexed:

```json
{
  "content_index": {
    "url": "https://example.com/.well-known/aidp/content/directory.json",
    "types_inlined": ["faq", "service"],
    "types_indexed": ["article", "event"],
    "total_by_type": { "article": 1240, "event": 387, "faq": 18, "service": 6 },
    "pinned_count": 3,
    "updated_at": "2026-05-12T10:00:00Z"
  }
}
```

The SDK proxies the upstream response transparently—no client code change is needed when an entity owner switches strategy. AI consumers should check `content_index.types_indexed` and pull `directory.json` when needed.

### Pinned content

Any content can be marked `pinned: true`. Pinned content always appears in `aidp.json.content` regardless of the type's strategy, sorted first.

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

Each command exits 0 on success and 1 on any failure with a structured `reason=…` on stderr. Possible reasons (matching the spec failure modes): `missing-proof`, `mixed-proof`, `multi-proof-not-supported`, `missing-canonical-url`, `bad-algorithm`, `unknown-kid`, `key-out-of-window`, `shape-error`, `canonical-error`, `bad-key`, `bad-signature`, `expired`.

## Operations notes

- **Rate-limit `/api/_aidp/invalidate` at your CDN / WAF.** The route is HMAC-authenticated (so an attacker without the shared secret cannot evict cache) and caps inbound bodies at 64 KB before the HMAC pass to bound the pre-auth CPU cost. Without a CDN-side limit an attacker can still drive SHA-256 work on small forged payloads. SpeakSpec's dispatcher delivers at most a few webhooks per minute under normal operation, so a tight limit (e.g. 60 req/min per source IP) is safe. Customers running their own WAF can additionally allowlist SpeakSpec's egress IP (publish a single CIDR for production deliveries) to reject everything else outright.
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
