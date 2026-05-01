// Playground for @speakspec/nuxt module development.
// Step 3.0: minimal scaffold that loads the local module so
// `nuxi prepare playground` and `vue-tsc --noEmit` work; subsequent
// steps will exercise actual server routes / composables here.

export default defineNuxtConfig({
  modules: ['../src/module'],
  devtools: { enabled: true },
  compatibilityDate: '2025-01-01',
})
