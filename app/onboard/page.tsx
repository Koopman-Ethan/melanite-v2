import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Set up your account · Melanite',
  robots: { index: false, follow: false },
}

const CONTACT = 'melanitelasersuite@gmail.com'

/** Landing here with no token at all.
 *
 *  A distinct state from a token that is wrong, because the advice differs: "check your email"
 *  rather than "check the URL". v1 separated these too, and was right to. */
export default function OnboardNoToken() {
  return (
    <div className="mx-auto w-full max-w-md text-center">
      <div
        className="mx-auto flex size-16 items-center justify-center rounded-full border border-line-strong bg-overlay text-2xl text-ink-secondary"
        aria-hidden
      >
        ?
      </div>
      <h1 className="mt-5 text-xl font-semibold">Missing your invite link?</h1>
      <p className="mt-2 text-sm text-ink-muted">
        It looks like you landed here without an invite token. Check your email for the link
        Keoni sent you, or reach out for a fresh invitation.
      </p>
      <p className="mt-6 text-xs text-ink-faint">
        <a href={`mailto:${CONTACT}`} className="text-gold underline-offset-4 hover:underline">
          {CONTACT}
        </a>
      </p>
    </div>
  )
}
