import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Server actions carry the uploads: an equipment photograph and a client receipt.
    //
    // The default is 1MB, and exceeding it is not a nice failure — Next rejects the request
    // before any of our code runs, so every check in `lib/blob.ts` is skipped and the provider
    // gets a runtime overlay reading "Body exceeded 1 MB limit". A photo was fine because it is
    // downscaled in the browser first; a scanned receipt PDF cannot be, and found this.
    //
    // 4MB rather than something generous, because this applies to EVERY server action in the
    // app and a body limit is the cheap half of not being a free file host. `MAX_UPLOAD_BYTES`
    // in `lib/uploads.ts` sits under it, so a file that passes the browser check cannot be the
    // thing that bursts this.
    serverActions: { bodySizeLimit: '4mb' },
  },

  // A verification build can be sent somewhere other than `.next`.
  //
  // `next build` and `next dev` share that directory, so running a build while the dev server
  // is up rewrites the manifests underneath it and every route starts answering 500 —
  // `ENOENT: .next/dev/routes-manifest.json`, which reads like a broken app rather than a
  // broken directory. Clearing `.next` first makes it worse and is the obvious thing to do
  // when a build looks stale.
  //
  // `npm run build:check` sets this so a correctness build and a running dev server stop
  // competing for the same folder. Unset in production, where `.next` is correct and the only
  // thing running.
  ...(process.env.MELANITE_BUILD_DIR ? { distDir: process.env.MELANITE_BUILD_DIR } : {}),

  // `noindex` on every response, as the other half of app/robots.ts.
  //
  // robots.txt asks a crawler not to FETCH a page. This tells it not to LIST one it reached
  // anyway — from a link, a redirect, or a URL pasted somewhere public. Neither implies the
  // other, and the pages worth worrying about are exactly the ones a crawler could arrive at
  // without reading robots.txt first: `/pay/<token>` carries a client's name and what they owe.
  //
  // `nofollow` too, so a crawler that does land on one does not walk onward from it.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
      },
    ]
  },
};

export default nextConfig;
