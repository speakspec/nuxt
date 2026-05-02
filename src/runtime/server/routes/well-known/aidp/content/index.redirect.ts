// Spec §8.8 mandates the trailing slash on the directory URL
// (`/.well-known/aidp/content/`). Agents that drop the slash should
// not 404 OR get a different resource that maps to a different cache
// key — they should be redirected to the canonical URL with 301
// Moved Permanently so caches converge on a single representation.

import { defineEventHandler, sendRedirect, getRequestURL } from 'h3'

export default defineEventHandler((event) => {
  const url = getRequestURL(event)
  const target = url.pathname + '/' + (url.search ?? '')
  return sendRedirect(event, target, 301)
})
