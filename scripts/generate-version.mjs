#!/usr/bin/env node
// Generates src/runtime/version.ts from package.json.version. Hooked
// into `dev:prepare` and `prepack` so the SDK User-Agent stays in sync
// with the published version without a manual constant. The generated
// file is gitignored — regenerated at build time, baked into dist.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(resolve(here, '..', 'package.json'), 'utf8'))

const out = `export const SDK_VERSION = ${JSON.stringify(pkg.version)} as const
export const SDK_USER_AGENT = \`@speakspec/nuxt/\${SDK_VERSION}\`
`

writeFileSync(resolve(here, '..', 'src', 'runtime', 'version.ts'), out)
console.log(`generated src/runtime/version.ts (v${pkg.version})`)
