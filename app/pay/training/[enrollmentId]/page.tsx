import type { Metadata } from 'next'

import { getEnrollmentDetail } from '@/lib/db/queries/training'

import { BalanceCheckout } from './checkout'

export const metadata: Metadata = {
  title: 'Training balance · Melanite',
  robots: { index: false, follow: false },
}
export const dynamic = 'force-dynamic'

function Message({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto w-full max-w-lg rounded-card border border-line bg-surface p-8 text-center">
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="mt-2 text-sm text-ink-muted">{body}</p>
    </div>
  )
}

/** The balance page is addressed by enrolment id and carries no token.
 *
 *  That is v1's design and it holds up: the id is a uuid, the page reveals only that student's
 *  own first name, course date and balance, and the link has to survive being re-sent months
 *  later. A rotating token would break every previously sent email. */
export default async function TrainingBalancePage({
  params,
}: {
  params: Promise<{ enrollmentId: string }>
}) {
  const { enrollmentId } = await params
  const enrollment = await getEnrollmentDetail(enrollmentId)

  if (!enrollment) {
    return (
      <Message
        title="Enrolment not found"
        body="Check the link you were sent, or contact Melanite."
      />
    )
  }

  if (enrollment.courseStatus === 'cancelled') {
    return (
      <Message
        title="This course was cancelled"
        body="Contact Melanite about transferring to another date or arranging a refund."
      />
    )
  }

  if (Number(enrollment.owed) <= 0) {
    return (
      <Message
        title="Nothing left to pay"
        body={`Your training is paid in full. Melanite will be in touch with joining details.`}
      />
    )
  }

  return (
    <BalanceCheckout
      enrollmentId={enrollment.id}
      firstName={enrollment.firstName}
      courseDate={enrollment.day1Date}
      totalPrice={enrollment.totalPrice}
      paid={enrollment.paid}
      owed={enrollment.owed}
      dueDate={enrollment.balanceDueDate}
    />
  )
}
