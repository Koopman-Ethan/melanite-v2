import { spawnSync } from 'node:child_process'

// A correctness build that cannot disturb a running dev server.
//
//   npm run build:check
//
// WHY THIS EXISTS. `next build` and `next dev` share `.next`, so building while the dev server
// is up rewrites the manifests underneath it and every route starts answering 500 with
// `ENOENT: .next/dev/routes-manifest.json`. That reads like a broken application rather than a
// broken directory, and the instinctive fix — clearing `.next` because the build looks stale —
// makes it worse. It cost two restarts in one afternoon before this existed.
//
// A tiny script rather than an inline env var in the npm script, because `VAR=x next build`
// is shell syntax that Windows does not have and `cross-env` is a dependency for one line.
//
// `.next-check` is gitignored alongside `.next`.

const result = spawnSync('npx', ['next', 'build'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, MELANITE_BUILD_DIR: '.next-check' },
})

process.exit(result.status ?? 1)
