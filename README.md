# @speakspec/nuxt

> AIDP 0.3 publishing channel for Nuxt 4.

A Nuxt module that turns your site into a first-class AIDP source: publishes the entity directive at `/.well-known/aidp.json`, exposes signed content endpoints + a paginated content directory, injects `<link rel="aidp">` / `<link rel="aidp-content">` discovery tags, and receives cache-invalidation webhooks from SpeakSpec when directives change.

## Status

Phase 3 of the AIDP 0.3 PKI rollout. Step 3.0 (this commit) is repository scaffold only — `pnpm add @speakspec/nuxt` installs but the module is a no-op until the feature steps below land. See `docs/proposal-speakspec-nuxt-module.md` in the workspace for the full plan.

| Milestone | Status |
|---|---|
| 3.0 Repo + module skeleton | done |
| 3.1 Entity directive route + cache + ETag | not started |
| 3.1.5 Webhook receiver (HMAC + replay protection) | not started |
| 3.2 Content endpoint + content source adapter | not started |
| 3.3 Content directory route | not started |
| 3.4 Link tag injection + `<AidpDirective>` component | not started |
| 3.5 AI-bot detection middleware (opt-in) | not started |
| 3.6 Validator + CLI + docs | not started |

## Operations notes

- **Rate-limit `/api/_aidp/invalidate` at your CDN / WAF.** The route is HMAC-authenticated (so an attacker without the shared secret cannot evict cache), but the SDK does not throttle requests itself. Without a CDN-side limit an attacker can pin the customer's CPU on SHA-256 verification of forged payloads. SpeakSpec's dispatcher delivers at most a few webhooks per minute under normal operation, so a tight limit (e.g. 60 req/min per source IP) is safe.

## Design constraints

- **Publishing-first, not injection-first**: the module exposes endpoints; it does not blanket-inject directive JSON into every HTML page.
- **SDK is the only valid signing path**: signatures are issued by SpeakSpec server-side; the SDK relays signed bundles, it never holds the private key.
- **Customer body is never signed by SDK**: signed `_proof` covers identity + freshness + directives. Body is dynamic and stays unsigned per AIDP 0.3 §4.8.3.
- **All fetches are SSR-time**: no build-time baking. Cache hits are served from Nitro cache + ETag; cache misses fetch the latest signed bundle from SpeakSpec.
- **Webhook is mandatory**: directive changes propagate via the `/api/_aidp/invalidate` route the SDK exposes; the receiver verifies HMAC + timestamp before clearing any cache key.

## Install (later, when Step 3.1 lands)

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
  },
})
```

`apiKey` and `webhookSecret` are server-side only; they MUST live in `runtimeConfig` (private) and never in `runtimeConfig.public`.

## License

MIT

## Repository layout

```
src/
├── module.ts                 # defineNuxtModule entry
└── runtime/
    ├── server/               # nitro server handlers (Step 3.1+)
    │   └── routes/
    ├── composables/          # useAidpContent (Step 3.4)
    └── components/           # <AidpDirective> (Step 3.4)
```

The full proposal lives at `docs/proposal-speakspec-nuxt-module.md` in the workspace root; the AIDP 0.3 spec it implements is `aidp-docs/AIDP-SPEC.md` §4.8 / §8.5-8.13.
