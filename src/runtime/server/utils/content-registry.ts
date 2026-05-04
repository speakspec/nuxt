// In-memory map: path → content_id, populated by useAidpContent on
// SSR-render and read by the bot-detect middleware on subsequent
// crawler requests so impressions can be enriched with content_id.
//
// First-request limitation: the middleware fires BEFORE the page
// renders, so the very first hit on a path has no registered
// content_id. AI agents typically revisit; later hits get enriched.
//
// Module-scoped Map persists for the lifetime of the Nitro process.
// In serverless cold-start scenarios the registry resets — acceptable
// for the analytics signal.

const pathToContentId = new Map<string, string>()

export function registerContent(path: string, contentId: string): void {
  if (!path || !contentId) return
  pathToContentId.set(path, contentId)
}

export function lookupContentId(path: string): string | undefined {
  return pathToContentId.get(path)
}

export function clearContentRegistry(): void {
  pathToContentId.clear()
}
