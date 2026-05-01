// Universal Nuxt plugin that injects the entity + keys link tags
// site-wide on every render. Per AIDP 0.3 §8.5, every page should
// carry the entity discovery anchor so AI crawlers can find the
// `/.well-known/aidp.json` endpoint regardless of which page they
// landed on. The aidp-content link is per-page and lives in
// useAidpContent / <AidpDirective>, not here.
//
// `useHead` is universal (works in both SSR and client hydration),
// so a single plugin file covers both. unhead dedupes link tags by
// content hash for custom rels (rel:href), so per-page
// useAidpContent calls emitting the same descriptor as a site-wide
// tag don't produce duplicates in the rendered DOM.
//
// Note: on the client, useRuntimeConfig() exposes only the public
// namespace, so `endpoint` (private) is undefined there. The early-
// return below means link emission only happens during SSR; the
// SSR-rendered tags hydrate to the live DOM and stay there. This is
// the desired behaviour — AI crawlers see the tags in initial HTML,
// and there's no need to re-emit them on the client.

import { defineNuxtPlugin, useRuntimeConfig, useHead } from '#imports'
import { entityLink, keysLink } from '../utils/links'

export default defineNuxtPlugin(() => {
  const publicConfig = useRuntimeConfig().public.speakspec
  const privateConfig = useRuntimeConfig().speakspec

  const siteOrigin = publicConfig?.siteOrigin
  const endpoint = privateConfig?.endpoint

  if (!siteOrigin || !endpoint) {
    // Module not configured; skip silently. The route handlers will
    // surface 503s if anything tries to hit them, which is the better
    // place to fail loudly.
    return
  }

  useHead({
    link: [
      entityLink(siteOrigin),
      keysLink(endpoint),
    ],
  })
})
