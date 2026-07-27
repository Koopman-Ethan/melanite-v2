import type { Metadata } from 'next'
import Link from 'next/link'

import { getInviteLanding, INVITE_TTL_DAYS } from '@/lib/db/queries/invites'

import { Onboarding } from './onboarding'

export const metadata: Metadata = {
  title: 'Set up your account · Melanite',
  // An invite link is a credential. It should not end up in a search index.
  robots: { index: false, follow: false },
}
export const dynamic = 'force-dynamic'

const CONTACT = 'melanitelasersuite@gmail.com'

/** Every dead end says which one it is, and what to do about it.
 *
 *  v1 had four distinct states here and it was right to: "wrong link", "too late" and "already
 *  done" need completely different actions from the person reading them, and collapsing them
 *  into one error means everybody emails Keoni. */
function Dead({
  icon,
  tone,
  title,
  body,
  action,
}: {
  icon: string
  tone: 'error' | 'warning' | 'done'
  title: string
  body: string
  action?: { label: string; href: string }
}) {
  const ring =
    tone === 'error'
      ? 'border-danger/40 bg-danger/10 text-danger'
      : tone === 'warning'
        ? 'border-warning/40 bg-warning/10 text-warning'
        : 'border-line-strong bg-overlay text-ink-secondary'

  return (
    <div className="mx-auto w-full max-w-md text-center">
      <div
        className={`mx-auto flex size-16 items-center justify-center rounded-full border text-2xl ${ring}`}
        aria-hidden
      >
        {icon}
      </div>
      <h1 className="mt-5 text-xl font-semibold">{title}</h1>
      <p className="mt-2 text-sm text-ink-muted">{body}</p>

      {action && (
        <Link
          href={action.href}
          className="mt-5 inline-block rounded-control border border-gold bg-gold px-[18px] py-3 text-[13px] font-bold tracking-[0.3px] text-gold-ink"
        >
          {action.label}
        </Link>
      )}

      <p className="mt-6 text-xs text-ink-faint">
        <a href={`mailto:${CONTACT}`} className="text-gold underline underline-offset-4">
          {CONTACT}
        </a>
      </p>
    </div>
  )
}

export default async function OnboardPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const invite = await getInviteLanding(token)

  if (invite.state === 'not_found') {
    return (
      <Dead
        icon="!"
        tone="error"
        title="Invite not found"
        body="We couldn’t find an invite matching this link. Double-check the URL from your email, or reach out to Keoni for a fresh invitation."
      />
    )
  }

  if (invite.state === 'expired' || invite.state === 'revoked') {
    return (
      <Dead
        icon="!"
        tone="warning"
        title={invite.state === 'expired' ? 'This invite has expired' : 'This invite was withdrawn'}
        body={
          invite.state === 'expired'
            ? `Provider invites expire ${INVITE_TTL_DAYS} days after they’re sent. Reach out to Keoni to issue you a new one.`
            : 'This invitation is no longer valid. Reach out to Keoni if you think that’s a mistake.'
        }
      />
    )
  }

  if (invite.state === 'accepted') {
    return (
      <Dead
        icon="✓"
        tone="done"
        title="This invite has already been used"
        body="Looks like you’ve already activated this account. Sign in to continue."
        action={{ label: 'Go to login', href: '/login' }}
      />
    )
  }

  return <Onboarding token={token} email={invite.email!} />
}
