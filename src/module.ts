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

import { defineNuxtModule, addServerHandler, addPlugin, addImports, addComponent, createResolver } from '@nuxt/kit'
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

  /**
   * AI crawler detection middleware. Off by default. When enabled,
   * the SDK inspects every incoming request's User-Agent and emits a
   * structured `aidp.crawler_impression` JSON log line on matches.
   * Pipe these into your observability stack to measure AI traffic
   * without coupling to any specific analytics backend.
   */
  botTracking?: {
    enabled?: boolean
    /** URL path prefixes to skip (e.g. `/_nuxt/`, `/api/`). */
    excludePaths?: string[]
  }
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
    const mergedPrivate = defu(
      nuxt.options.runtimeConfig.speakspec as Record<string, unknown>,
      {
        entityId: options.entityId ?? '',
        apiKey: options.apiKey ?? '',
        webhookSecret: options.webhookSecret ?? '',
        endpoint: options.endpoint ?? 'https://api.speakspec.com',
        botTracking: {
          enabled: options.botTracking?.enabled ?? false,
          excludePaths: options.botTracking?.excludePaths ?? ['/_nuxt/', '/api/_aidp/'],
        },
      },
    )
    nuxt.options.runtimeConfig.speakspec = mergedPrivate as typeof nuxt.options.runtimeConfig.speakspec

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
    addServerHandler({
      route: '/.well-known/aidp.json',
      handler: resolver.resolve('./runtime/server/routes/well-known/aidp.json.get'),
    })

    // /.well-known/aidp/content/:id — per-content signed envelope per
    // §8.7. The handler strips the `.json` suffix from `:id` so the
    // canonical URL `/well-known/aidp/content/{id}.json` works as
    // documented in the spec. Step 3.2.
    addServerHandler({
      route: '/.well-known/aidp/content/:id',
      handler: resolver.resolve('./runtime/server/routes/well-known/aidp/content/[id].get'),
    })

    // /.well-known/aidp/content/ — paginated content directory per
    // §8.8. Spec mandates the trailing slash; we register both forms
    // so agents that drop it don't 404. Step 3.3.
    const directoryHandler = resolver.resolve('./runtime/server/routes/well-known/aidp/content/index.get')
    addServerHandler({
      route: '/.well-known/aidp/content/',
      handler: directoryHandler,
    })
    addServerHandler({
      route: '/.well-known/aidp/content',
      handler: directoryHandler,
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

    // Site-wide HTML link tags (§8.5): `<link rel="aidp">` (entity
    // discovery anchor) and `<link rel="aidp-keys">` (JWKS pointer).
    // Per-page `<link rel="aidp-content">` is opt-in via the
    // useAidpContent composable / <AidpDirective> component below.
    // Step 3.4.
    addPlugin(resolver.resolve('./runtime/plugins/aidp-links'))

    addImports({
      name: 'useAidpContent',
      from: resolver.resolve('./runtime/composables/useAidpContent'),
    })

    addComponent({
      name: 'AidpDirective',
      filePath: resolver.resolve('./runtime/components/AidpDirective.vue'),
    })

    // Opt-in AI crawler detection middleware. Always registered so
    // host projects can flip `botTracking.enabled` at runtime via env
    // var without rebuilding; the middleware itself is the gate.
    // Step 3.5.
    addServerHandler({
      middleware: true,
      handler: resolver.resolve('./runtime/server/middleware/ai-bot-detect'),
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
      botTracking: {
        enabled: boolean
        excludePaths: string[]
      }
    }
  }
  interface PublicRuntimeConfig {
    speakspec: {
      siteOrigin: string
    }
  }
}
