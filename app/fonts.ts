import localFont from 'next/font/local'

// The real Melanite typefaces, read from the live Webflow site rather than guessed. The v1
// HTML mockups all say `Arial, sans-serif`, which is a placeholder the published build never
// used — the site actually loads Excon and Erode (both Fontshare / Indian Type Foundry).
//
// Self-hosted rather than pulled from Webflow's CDN: the marketing site can be republished or
// migrated at any point, and the portal should not have a font dependency on it. next/font
// also inlines the @font-face and preloads, so there is no layout shift.
//
// Only the weights the site actually ships are here. Excon has Regular and Medium; Erode ships
// Medium only, so there is no bold serif to fall back on — headings should use weight, size and
// letter-spacing rather than reaching for a weight that does not exist.

export const excon = localFont({
  variable: '--font-excon',
  display: 'swap',
  src: [
    { path: './fonts/Excon-Regular.woff2', weight: '400', style: 'normal' },
    { path: './fonts/Excon-Medium.woff2', weight: '500', style: 'normal' },
  ],
})

export const erode = localFont({
  variable: '--font-erode',
  display: 'swap',
  src: [{ path: './fonts/Erode-Medium.woff2', weight: '500', style: 'normal' }],
})
