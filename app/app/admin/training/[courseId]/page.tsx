import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requireAdmin } from '@/lib/auth/dal'
import { cn } from '@/lib/cn'
import { getCourses, getEnrollments } from '@/lib/db/queries/training'

import { CourseForm } from '../course-form'
import { CourseControls, EnrollmentControls } from './enrollment-actions'

export const metadata: Metadata = { title: 'Course · Melanite Admin' }
export const dynamic = 'force-dynamic'

const usd = (v: string) => Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

const dayLabel = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })

const PAYMENT_STYLES: Record<string, string> = {
  unpaid: 'border-danger/40 bg-danger/10 text-danger',
  partial: 'border-warning/40 bg-warning/10 text-warning',
  paid_in_full: 'border-success/40 bg-success/10 text-success',
}

const PAYMENT_LABELS: Record<string, string> = {
  unpaid: 'Unpaid',
  partial: 'Deposit paid',
  paid_in_full: 'Paid in full',
}

export default async function CoursePage({
  params,
}: {
  params: Promise<{ courseId: string }>
}) {
  await requireAdmin()
  const { courseId } = await params

  const courses = await getCourses(200)
  const course = courses.find((c) => c.id === courseId)
  if (!course) notFound()

  const enrollments = await getEnrollments(courseId)

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-10 space-y-6">
      <div>
        <Link
          href="/app/admin/training"
          className="text-xs text-ink-muted underline-offset-4 hover:underline"
        >
          ← All courses
        </Link>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{dayLabel(course.day1Date)}</h1>
          <p className="mt-1 text-sm text-ink-muted tabular-nums">
            {course.day1Start}–{course.day1End}
            {course.day2Date && (
              <>
                {' · '}
                {dayLabel(course.day2Date)} {course.day2Start}–{course.day2End}
              </>
            )}
          </p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-semibold tabular-nums">{usd(course.collected)}</div>
          <div className="text-xs text-ink-faint">
            collected
            {Number(course.outstanding) > 0 && (
              <span className="text-warning"> · {usd(course.outstanding)} owed</span>
            )}
          </div>
        </div>
      </header>

      <CourseControls
        courseId={course.id}
        status={course.status}
        enrolled={course.enrolled}
      />

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">
          Students · {course.enrolled} of {course.maxStudents}
        </h2>

        {enrollments.length === 0 ? (
          <div className="rounded-card border border-dashed border-line p-8 text-center text-sm text-ink-muted">
            Nobody has enrolled yet.
          </div>
        ) : (
          <ul className="space-y-2">
            {enrollments.map((e) => (
              <li key={e.id} className="rounded-card border border-line bg-surface p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">
                        {e.firstName} {e.lastName}
                      </span>
                      <span
                        className={cn(
                          'rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide',
                          PAYMENT_STYLES[e.paymentStatus] ?? 'border-line text-ink-muted',
                        )}
                      >
                        {PAYMENT_LABELS[e.paymentStatus] ?? e.paymentStatus}
                      </span>
                      {e.courseCompletedAt && (
                        <span className="rounded border border-line px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-faint">
                          Completed
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-ink-muted">
                      {[e.email, e.phone].filter(Boolean).join(' · ')}
                    </p>
                    {e.licenseNumber && (
                      <p className="mt-0.5 text-xs text-ink-faint">
                        Licence {e.licenseNumber}
                      </p>
                    )}
                  </div>

                  <div className="text-right tabular-nums">
                    <div className="text-sm font-medium">{usd(e.paid)} paid</div>
                    {Number(e.owed) > 0 && (
                      <div className="text-xs text-warning">{usd(e.owed)} owed</div>
                    )}
                  </div>
                </div>

                <EnrollmentControls
                  enrollmentId={e.id}
                  owed={e.owed}
                  balanceDueDate={e.balanceDueDate}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {course.status === 'scheduled' && (
        <CourseForm
          initial={{
            id: course.id,
            day1Date: course.day1Date,
            day1Start: course.day1Start,
            day1End: course.day1End,
            day2Date: course.day2Date ?? '',
            day2Start: course.day2Start,
            day2End: course.day2End,
            maxStudents: String(course.maxStudents),
            depositAmount: course.depositAmount,
            totalPrice: course.totalPrice,
          }}
        />
      )}
    </main>
  )
}
