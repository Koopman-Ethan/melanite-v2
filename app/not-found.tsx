import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = { title: 'Page not found · Melanite' }

// The page somebody lands on when a link is wrong.
//
// Next's default is an unstyled white page reading "404 | This page could not be found." On a
// phone, with no branding and no way back, that does not look like a mistyped URL — it looks
// like the business has gone offline. A provider hit exactly that on 3 August 2026 following an
// old bookmark and reported it as being locked out, which is a reasonable reading of a blank
// white error page where your working day should be.
//
// The underlying cause is fixed in `lib/auth/next-path.ts`. This exists because that will not
// be the last wrong link anybody follows: old bookmarks, links in year-old text messages, and
// typed URLs all end here, and every one of them should offer a way onward instead of a
// dead end.

export default function NotFound() {
  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="w-full max-w-md text-center">
        <p className="text-xs uppercase tracking-wide text-gold">Melanite Laser Suite</p>

        <h1 className="mt-3 text-2xl font-semibold leading-tight">
          That page isn&rsquo;t <span className="text-gold">here</span>.
        </h1>

        {/* Says which of the two it is, because the reassurance is the useful part: somebody
            who has just signed in needs to know their account is fine. */}
        <p className="mt-3 text-sm text-ink-secondary">
          The link may be old, or the address slightly wrong. Nothing is wrong with your account.
        </p>

        <div className="mt-6 flex flex-col gap-2">
          <Link
            href="/app"
            className="rounded-control bg-gold px-[18px] py-3 text-center text-[13px] font-bold tracking-[0.3px] text-gold-ink transition-opacity hover:opacity-90"
          >
            Go to my dashboard
          </Link>
          <Link
            href="/login"
            className="rounded-control border border-line-strong px-[18px] py-3 text-center text-[13px] font-bold tracking-[0.3px] text-ink-secondary transition-colors hover:border-ink-faint hover:bg-overlay"
          >
            Sign in
          </Link>
        </div>

        <p className="mt-6 text-xs text-ink-faint">
          Following a link from an older version of the site? Some addresses have changed —
          signing in and navigating from the dashboard will get you there.
        </p>
      </div>
    </main>
  )
}
