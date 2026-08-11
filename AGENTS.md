<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Use npm 10 for anything that writes package-lock.json

`npm install` under **npm 11 silently produces a lock file that `npm ci` rejects**, and CI is
the only thing that ever finds out. Use:

```
npx npm@10 install
```

Why: `drizzle-kit` needs `esbuild ^0.25` and `vite` (via `vitest`) needs `^0.27 || ^0.28`.
Those ranges are disjoint, so a correct tree carries two copies — one hoisted, one nested. npm 11
hoists `0.25` and dedupes vite's dependency against it, producing a lock that is internally
contradictory rather than merely stale. It then installs from that lock quite happily. `npm ci`
recomputes from `package.json` and refuses.

Check with `npm ls esbuild`. `ELSPROBLEMS … deduped invalid` means the lock is broken again,
whatever the tests say.

This is why the lock sat unusable from 27 July until the first workflow was added in August —
nothing in the repo ran `npm ci` before then.
