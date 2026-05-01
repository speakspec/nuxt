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
//
// Step 3.0 ships only the module skeleton — actual server routes,
// composables, and webhook receivers land in subsequent steps.

import { defineNuxtModule } from '@nuxt/kit'

export interface ModuleOptions {
  /**
   * SpeakSpec entity ID (looks like `ent_xxx`). Required.
   * Available from the customer dashboard at aidp-web after creating
   * an entity.
   */
  entityId?: string

  /**
   * SpeakSpec API key (write scope), looks like `ssk_xxx`. Required.
   * Held server-side only; NEVER injected into the client bundle.
   */
  apiKey?: string

  /**
   * Shared secret for verifying §8.10 cache-invalidation webhook
   * deliveries. Each webhook payload is signed
   * `hmac-sha256(timestamp + "\n" + body)` and the receiver MUST verify
   * before invalidating any cache key.
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
  setup() {
    // Step 3.1+ will register server handlers, plugins, composables,
    // and components. The skeleton intentionally does nothing yet —
    // installing the module on a Nuxt 4 project is a no-op until at
    // least one feature step lands.
  },
})
