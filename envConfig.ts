import { loadEnvConfig } from '@next/env'

// Loads .env* files the same way Next.js does, for tools that run outside the
// Next.js runtime (drizzle-kit reads .env.local through this).
loadEnvConfig(process.cwd())
