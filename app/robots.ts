import type { MetadataRoute } from 'next'

// Keep the whole app out of search results.
//
// `app.melanitesuite.com` is a public hostname, and search engines find those on their own —
// certificate transparency logs, DNS, a link pasted anywhere. Nobody has to publish the address
// for it to get crawled.
//
// There is nothing here that belongs in a search result. Every route is a staff login, a page
// behind that login, or a tokenised link meant for one person. The last of those is the reason
// this matters rather than being tidiness: `/pay/<token>` shows a client's name and what they
// are paying, and `/onboard/<token>` is an invitation addressed to somebody. A crawler that
// reaches one of those pages could put a real person's name in Google.
//
// This is NOT a security control. Robots rules are advisory and an ill-behaved crawler ignores
// them; what actually protects these pages is the session check and the fact that the tokens
// are long and random. This stops the well-behaved majority, which is what search engines are.
//
// Paired with an X-Robots-Tag header in next.config.ts — robots.txt asks a crawler not to
// FETCH a page, `noindex` tells it not to LIST one it reached some other way. Neither implies
// the other, so both are set.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      disallow: '/',
    },
  }
}
