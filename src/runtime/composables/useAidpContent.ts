// Per-page composable: registers the AIDP 0.3 §8.5 `aidp-content`
// link tag pointing at the SDK-served per-content envelope endpoint.
//
// Usage in an article / product page:
//
//   <script setup lang="ts">
//   const article = await useFetch(...)
//   useAidpContent({ id: article.value.id })
//   </script>
//
// IMPORTANT: call from `<script setup>` of a component (or another
// composable that itself runs in setup context). Calling from a
// middleware, plugin, or route hook leaks the head entry past the
// page lifecycle — `useHead` relies on the calling component for
// scoped cleanup.
//
// Quietly no-ops when siteOrigin is not configured or `id` is empty —
// the route handlers will 503 / 400 if anything tries to hit them,
// which is the better place to fail loudly.

import { useHead, useRequestURL, useRuntimeConfig } from '#imports'
import { contentLink } from '../utils/links'

export interface UseAidpContentOptions {
  /** AIDP content_id (the bare slug; URL-encoding is handled internally). */
  id: string
}

export function useAidpContent(opts: UseAidpContentOptions): void {
  const siteOrigin = useRuntimeConfig().public.speakspec?.siteOrigin
  if (!siteOrigin || !opts.id) return

  useHead({
    link: [contentLink(siteOrigin, opts.id)],
  })

  // Register the (path → content_id) mapping on the SSR side so that
  // a subsequent AI crawler hit on the same path can be enriched with
  // content_id by the bot-detect middleware. Skipped on the client —
  // the registry only exists in the Node process.
  if (import.meta.server) {
    void registerOnServer(useRequestURL().pathname, opts.id)
  }
}

async function registerOnServer(path: string, contentId: string): Promise<void> {
  // Dynamic import keeps the client bundle from pulling in
  // server-only registry code.
  const { registerContent } = await import('../server/utils/content-registry')
  registerContent(path, contentId)
}
