// No-op stand-in for the `server-only` package.
//
// That package throws on import outside the Next.js server runtime, which is exactly what it
// is for — but it also makes modules importing it untestable from a plain Node script.
// scripts/tsconfig.json aliases it here so scripts can exercise lib/auth and lib/db directly.
// The real guard still applies to every Next build; only scripts see this file.
export {}
