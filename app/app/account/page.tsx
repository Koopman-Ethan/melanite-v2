import type { Metadata } from 'next'

import { requireProvider } from '@/lib/auth/dal'
import { licenseMessage, licenseStatus } from '@/lib/license'
import { getAccount, getActiveSessions, getDocuments } from '@/lib/db/queries/account'

import { NotificationsForm, PasswordForm, ProfileForm } from './forms'
import { Payouts } from './payouts'

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
  const [account, documents, activeSessions] = await Promise.all([
    getAccount(user.id),
    getDocuments(user.id),
    getActiveSessions(user.id),
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
              ? 'Licence expired.'
              : license.state === 'missing'
                ? 'No licence on file.'
                : 'Licence renewal due.'}
          </strong>{' '}
          {licenseNote}
        </div>
      )}

      <Section
        title="Profile"
        description="Your email is your sign-in and can’t be changed here — contact Melanite if it needs to move."
      >
        <ProfileForm values={account} />
      </Section>

      <Section
        title="Getting paid"
        description="Bookings use destination charges, so your share needs somewhere to land."
      >
        <Payouts connected={account.stripeOnboardingComplete} />
      </Section>

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
