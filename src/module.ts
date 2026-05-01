// @speakspec/nuxt — AIDP 0.3 publishing channel for Nuxt
//
// Phase 3 of the v0.3 rollout. Exposes server routes for
// /.well-known/aidp.json + per-content endpoints, receives §8.10
// cache-invalidation webhooks, and inserts <link rel="aidp"> +
// <link rel="aidp-content"> into HTML head.
//
// Design constraints (from proposal-speakspec-nuxt-module.md):
//   - Publishing-first, not injection-first
//   - SDK is the only valid signing path (server-side only)
//   - Customer body NEVER signed by SDK; signed bundle from SpeakSpec
//   - All fetches are SSR-time, never build-time baked

import { defineNuxtModule, addServerHandler, createResolver } from '@nuxt/kit'
import { defu } from 'defu'

export interface ModuleOptions {
  /**
   * SpeakSpec entity slug (the public AIDP id, e.g. `stockfeel`).
   * Available from the customer dashboard at aidp-web after creating
   * an entity. Required.
   */
  entityId?: string

  /**
   * SpeakSpec API key (write scope), looks like `ssk_xxx`. Held
   * server-side only; NEVER injected into the client bundle. The
   * /.well-known/aidp.json fetch does not strictly require this
   * (the upstream is publicly readable) but later steps that fetch
   * signed content bundles do.
   */
  apiKey?: string

  /**
   * Shared secret for verifying §8.10 cache-invalidation webhook
   * deliveries. Each webhook payload is signed
   * `hmac-sha256(timestamp + "\n" + body)` and the receiver MUST verify
   * before invalidating any cache key. Required when the webhook
   * receiver lands in Step 3.1.5; ignored until then.
   */
  webhookSecret?: string

  /**
   * Origin URL of the customer's own site (e.g. `https://stockfeel.com.tw`).
   * Used to construct absolute URLs in emitted AIDP payloads when the
   * entity does not declare a custom domain.
   */
  siteOrigin?: string

  /**
   * Override the SpeakSpec API endpoint. Defaults to the production
   * platform; useful for staging or self-hosted SpeakSpec instances.
   */
  endpoint?: string
}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: '@speakspec/nuxt',
    configKey: 'speakspec',
    compatibility: {
      nuxt: '^4.0.0',
    },
  },
  defaults: {
    endpoint: 'https://api.speakspec.com',
  },
  setup(options, nuxt) {
    const resolver = createResolver(import.meta.url)

    // Belt-and-braces validation against SpeakSpec's slug rule
    // (aidp-server/internal/service/slug_validator.go). Catches the
    // common mistakes — uppercase, underscores, accidentally pasting
    // the full URN (`urn:aidp:entity:foo`) — at module-setup time
    // instead of letting them fail silently in the fetch path.
    if (options.entityId && !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(options.entityId)) {
      console.warn(
        `[@speakspec/nuxt] entityId %o does not match SpeakSpec's slug rule `
        + `(lowercase alphanumerics and hyphens, no leading/trailing hyphen). `
        + `Verify against your SpeakSpec dashboard — pasting the URN form `
        + `(urn:aidp:entity:foo) instead of the bare slug is a common mistake.`,
        options.entityId,
      )
    }

    // Private runtime config (server-side only). apiKey + webhookSecret
    // MUST stay out of the public bundle. defu merges with whatever the
    // host project already set in nuxt.config.ts, so users can plug
    // values in either via the module options OR the runtimeConfig.
    nuxt.options.runtimeConfig.speakspec = defu(
      nuxt.options.runtimeConfig.speakspec as Record<string, string>,
      {
        entityId: options.entityId ?? '',
        apiKey: options.apiKey ?? '',
        webhookSecret: options.webhookSecret ?? '',
        endpoint: options.endpoint ?? 'https://api.speakspec.com',
      },
    )

    // Public runtime config — non-secret values that may be referenced
    // from client-side code in later steps (e.g. siteOrigin for
    // composables).
    nuxt.options.runtimeConfig.public.speakspec = defu(
      nuxt.options.runtimeConfig.public.speakspec as Record<string, string>,
      {
        siteOrigin: options.siteOrigin ?? '',
      },
    )

    // /.well-known/aidp.json — entity directive cache + ETag wrapper.
    // Step 3.1 ships this route only; per-content endpoints land in 3.2.
    addServerHandler({
      route: '/.well-known/aidp.json',
      handler: resolver.resolve('./runtime/server/routes/well-known/aidp.json.get'),
    })

    // POST /api/_aidp/invalidate — receives §8.10 webhooks from
    // SpeakSpec when a directive / content / entity changes. Verifies
    // HMAC + timestamp window, then evicts the corresponding Nitro
    // cache key. Step 3.1.5.
    addServerHandler({
      route: '/api/_aidp/invalidate',
      method: 'post',
      handler: resolver.resolve('./runtime/server/api/_aidp/invalidate.post'),
    })
  },
})

declare module '@nuxt/schema' {
  interface RuntimeConfig {
    speakspec: {
      entityId: string
      apiKey: string
      webhookSecret: string
      endpoint: string
    }
  }
  interface PublicRuntimeConfig {
    speakspec: {
      siteOrigin: string
    }
  }
}
