import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

import './envConfig'

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
      // `server-only` is a build-time guard that throws if a module reaches a client bundle.
      // There is no client bundle here, so it is stubbed out — without this, every query and
      // auth module is untestable, which would push testing away from exactly the code that
      // handles money.
      'server-only': fileURLToPath(new URL('./test/server-only-stub.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts'],
    // Database tests share one Postgres instance, so they must not race each other.
    fileParallelism: false,
    testTimeout: 30_000,
  },
})
