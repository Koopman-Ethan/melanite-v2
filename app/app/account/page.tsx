import type { Metadata } from 'next'

import { requireProvider } from '@/lib/auth/dal'
import { licenseMessage, licenseStatus } from '@/lib/license'
import { hasAcceptedRentalTerms } from '@/lib/rental-terms'
import { liveScheduleVersion } from '@/lib/rental/schedule'
import { paysRent, sharesRevenue } from '@/lib/revenue-model'
import { getAccount, getActiveSessions, getDocuments } from '@/lib/db/queries/account'

import { NotificationsForm, PasswordForm, ProfileForm } from './forms'
import { Payouts } from './payouts'
import { RentalCard } from './rental-card'

export const metadata: Metadata = { title: 'Account · Melanite' }
export const dynamic = 'force-dynamic'

const DOC_LABELS: Record<string, string> = {
  training_certificate: 'Training certificate',
  supervision_agreement: 'Supervision agreement',
}

const date = (d: Date | string | null) =>
  d
    ? new Date(d).toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'America/Denver',
      })
    : null

function Section({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">{title}</h2>
        {description && <p className="mt-1 text-xs text-ink-faint">{description}</p>}
      </div>
      {children}
    </section>
  )
}

export default async function AccountPage() {
  const user = await requireProvider()
  const [account, documents, activeSessions, scheduleVersion] = await Promise.all([
    getAccount(user.id),
    getDocuments(user.id),
    getActiveSessions(user.id),
    liveScheduleVersion(),
  ])

  if (!account) return null

  // Was only ever past tense — "your license expired", by which point booking is already
  // dead. The same surface now speaks up during the renewal window, and when there is no date
  // on file at all.
  const license = licenseStatus(account.licenseExpiry)
  const licenseNote = licenseMessage(license, account.licenseExpiry)

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10 space-y-10">
      <header>
        <h1 className="text-2xl font-semibold">Account</h1>
        <p className="mt-1 text-sm text-ink-muted">
          {account.email} · joined {date(account.joinedAt)}
        </p>
      </header>

      {licenseNote && (
        <div
          className={
            license.state === 'expired'
              ? 'rounded-card border border-danger/40 bg-danger/10 p-4 text-sm text-ink-secondary'
              : 'rounded-card border border-warning/40 bg-warning/10 p-4 text-sm text-ink-secondary'
          }
        >
          {/* The state is in the words, not only in the border colour. */}
          <strong className={license.state === 'expired' ? 'text-danger' : 'text-warning'}>
            {license.state === 'expired'
              ? 'License expired.'
              : license.state === 'missing'
                ? 'No license on file.'
                : 'License renewal due.'}
          </strong>{' '}
          {licenseNote}
        </div>
      )}

      <Section
        title="Profile"
        description="Your email is your sign-in and can’t be changed here — contact Melanite if it needs to move."
      >
        <ProfileForm values={account} licenseRequired={user.role === 'provider'} />
      </Section>

      {/* Rent, and only for somebody who pays it.
          
          It rendered for everybody until 12 October, so Leyla — who is on the original 50/50
          and will never be charged a rental fee — was asked for a card she does not need and
          nagged to accept terms that do not bind her. Accepting them would have changed
          nothing, which is the worst kind of prompt: it teaches somebody that the ones here
          are noise.
          
          Deliberately NOT replaced with a general "terms" section for her. There is nothing a
          50/50 provider is bound by today that she has not already agreed to, and a consent box
          with nothing substantive in it is how the next real one gets clicked through. What she
          has accepted already shows further down, on the account line. */}
      {/* Getting paid, for the three still on the 50/50 split. Their clients pay Melanite and
          Melanite forwards their share, so without a connected account they can work, be owed
          money, and never receive any of it — which nothing else on this page can cost them.

          Remounted on 12 October. It was unmounted when the rental model arrived, correctly:
          Melanite had stopped paying anybody. It still does not pay the five on rent. */}
      {sharesRevenue(user.revenueModel) && (
        <Section
          title="Payouts"
          description="Your clients pay Melanite and your share is forwarded to you. Melanite keeps its half of what you charge, and never charges you a rental fee."
        >
          <Payouts connected={account.stripeOnboardingComplete} />
        </Section>
      )}

      {paysRent(user.revenueModel) && (
      <Section
        title="Equipment rental"
        description="Melanite charges this card after your session, not when you reserve the laser. What you charge your own clients never comes through here."
      >
        <RentalCard
          card={
            account.billingPaymentMethodId
              ? {
                  brand: account.billingCardBrand,
                  last4: account.billingCardLast4,
                  expMonth: account.billingCardExpMonth,
                  expYear: account.billingCardExpYear,
                }
              : null
          }
          termsAccepted={hasAcceptedRentalTerms(account, scheduleVersion)}
          termsAckAt={account.rentalTermsAckAt}
        />
      </Section>
      )}

      <Section
        title="Notifications"
        description="New in this version — previously only Melanite could change these for you."
      >
        <NotificationsForm values={account} />
      </Section>

      <Section title="Password">
        <PasswordForm />
      </Section>

      {documents.length > 0 && (
        <Section
          title="Documents"
          description="Filed with Melanite. To replace one, contact them."
        >
          <ul className="divide-y divide-line rounded-card border border-line">
            {documents.map((doc) => (
              <li key={doc.id} className="flex items-center justify-between gap-4 p-4">
                <span className="min-w-0">
                  <span className="block text-sm text-ink-secondary">
                    {DOC_LABELS[doc.docType] ?? doc.docType}
                  </span>
                  <span className="block truncate text-xs text-ink-faint">
                    {doc.originalFilename ?? 'file'} · uploaded {date(doc.uploadedAt)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* Only possible because sessions live in the database. v1 had no server-side session
          record at all, so there was no way to see or end one from another device. */}
      <Section
        title="Signed in"
        description="Changing your password signs out every other device."
      >
        <ul className="divide-y divide-line rounded-card border border-line">
          {activeSessions.map((s) => (
            <li key={s.id} className="p-4">
              <span className="block truncate text-sm text-ink-secondary">
                {s.userAgent ?? 'Unknown device'}
              </span>
              <span className="block text-xs text-ink-faint">
                last used {date(s.lastUsedAt)}
                {s.ipAddress && ` · ${s.ipAddress}`}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <section className="border-t border-line pt-6 text-xs text-ink-faint">
        <p>
          Last signed in {date(account.lastLoginAt) ?? 'never'}
          {account.policyAckAt &&
            ` · policy ${account.policyAckVersion ?? ''} accepted ${date(account.policyAckAt)}`}
        </p>
      </section>
    </main>
  )
}
