import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
