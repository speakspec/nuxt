// Pure helpers for the three AIDP HTML link relations registered in
// the customer's <head> per AIDP 0.3 §8.5:
//
//   <link rel="aidp"          href="{siteOrigin}/.well-known/aidp.json">
//   <link rel="aidp-keys"     href="{endpoint}/.well-known/aidp-keys">
//   <link rel="aidp-content"  href="{siteOrigin}/.well-known/aidp/content/{id}.json">
//
// Plugin / composable thin wrappers feed the descriptors below into
// `useHead({ link: [...] })`. Pure helpers live here so unit tests
// can pin URL shapes without touching the Nuxt runtime.

// Loose `Record<string, string>` shape so values fed into useHead's
// `link: [...]` array satisfy @unhead/vue's structural type (which
// includes a `data-${string}` index signature for templating). We
// don't use any data-* attributes; the looseness is type-only.
export type LinkDescriptor = Record<string, string>

function trimSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s
}

/** Discovery anchor pointing at the SDK-served entity directive. */
export function entityLink(siteOrigin: string): LinkDescriptor {
  return {
    rel: 'aidp',
    href: `${trimSlash(siteOrigin)}/.well-known/aidp.json`,
  }
}

/** Pointer to the trust provider's JWKS endpoint (§8.11). */
export function keysLink(endpoint: string): LinkDescriptor {
  return {
    rel: 'aidp-keys',
    href: `${trimSlash(endpoint)}/.well-known/aidp-keys`,
  }
}

/** Per-page binding to a single content envelope (§8.5 + §8.7). */
export function contentLink(siteOrigin: string, contentId: string): LinkDescriptor {
  return {
    rel: 'aidp-content',
    href: `${trimSlash(siteOrigin)}/.well-known/aidp/content/${encodeURIComponent(contentId)}.json`,
  }
}
