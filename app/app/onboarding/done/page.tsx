import type { Metadata } from 'next'
import Link from 'next/link'

import { redirect } from 'next/navigation'

import { requireProvider } from '@/lib/auth/dal'
import { isOnboarding, nextStepSlug } from '@/lib/onboarding'
import { db } from '@/lib/db'
import { providers } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

export const metadata: Metadata = { title: "You're all set · Melanite" }
export const dynamic = 'force-dynamic'

const CONTACT = 'melanitelasersuite@gmail.com'

const NEXT = [
  {
    title: 'Send your documents to Melanite',
    body: `Email your insurance and medical-director documentation to ${CONTACT}. Melanite confirms them and switches on your booking access — this is the step that actually unlocks taking clients.`,
  },
  {
    title: 'Book your first laser slot',
    body: 'Head to Book Laser Time to reserve the room and generate a checkout link for your client.',
  },
  {
    title: 'Send the link to your client',
    body: 'Copy the payment link or let us email it. Most providers text it.',
  },
  {
    title: 'Get paid the moment they pay',
    body: 'Your share lands in your bank automatically. Tips go to you in full.',
  },
]

/** The account is ACTIVE at this point but `bookingEnabled` is still false, which is why the
 *  first item is documents rather than a victory lap. Telling someone they are "all set" and
 *  then blocking them at the diary is how support tickets are made. */
export default async function OnboardingDone() {
  const user = await requireProvider()

  // Reaching this screen without finishing means someone typed the URL. Send them back to the
  // step they are actually on rather than congratulating them for work they have not done.
  if (isOnboarding(user)) {
    const [row] = await db
      .select({ step: providers.onboardingStep })
      .from(providers)
      .where(eq(providers.id, user.id))
      .limit(1)
    redirect(`/app/onboarding/${nextStepSlug(row?.step ?? 1)}`)
  }

  return (
    <div className="mx-auto w-full max-w-lg space-y-6">
      <div className="rounded-card border border-success/30 bg-success/10 p-8 text-center">
        <div
          className="mx-auto flex size-14 items-center justify-center rounded-full bg-gold text-2xl text-gold-ink"
          aria-hidden
        >
          ✓
        </div>
        <h1 className="mt-4 text-xl font-semibold">
          You&rsquo;re all set{user.firstName ? `, ${user.firstName}` : ''}.
        </h1>
        <p className="mt-2 text-sm text-ink-secondary">
          Your provider account is created. One thing left before you can take bookings.
        </p>
      </div>

      <section className="rounded-card border border-line p-5">
        <h2 className="text-xs uppercase tracking-wide text-gold">What happens next</h2>
        <ol className="mt-4 space-y-4">
          {NEXT.map((item, i) => (
            <li key={item.title} className="flex gap-3">
              <span
                className="flex size-6 shrink-0 items-center justify-center rounded-full bg-overlay text-xs text-ink-secondary"
                aria-hidden
              >
                {i + 1}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium">{item.title}</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">
                  {item.body}
                </span>
              </span>
            </li>
          ))}
        </ol>
      </section>

      <div className="rounded-card border border-line p-4">
        <p className="text-xs uppercase tracking-wide text-gold">Quick reminder</p>
        <p className="mt-2 text-xs leading-relaxed text-ink-muted">
          The laser is shared, and bookings are first-come, first-served — check the calendar
          early to lock in the slots you want. Cancellations inside 24 hours may carry a fee.
        </p>
      </div>

      <Link
        href="/app/dashboard"
        className="block rounded-control border border-gold bg-gold px-[18px] py-3 text-center text-[13px] font-bold tracking-[0.3px] text-gold-ink"
      >
        Go to my dashboard →
      </Link>
    </div>
  )
}
