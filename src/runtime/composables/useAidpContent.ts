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

import { useHead, useRuntimeConfig } from '#imports'
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
}
